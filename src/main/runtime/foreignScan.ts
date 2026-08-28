/**
 * Finding the user's existing LM Studio and Ollama models, and making them
 * reachable by Lemonade.
 *
 * See `core/runtime/foreign.ts` for the measured behaviour of
 * `extra_models_dir` that dictates the shape of all this. In short: build one
 * real directory per model, each containing a single symlink named `*.gguf`,
 * and point the daemon at the directory holding them.
 *
 * Nothing here writes outside Karen's own index directory. The user's model
 * stores are opened read-only and never modified.
 */

import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import {
  blobFile, defaultStores, indexId, isAuxiliaryGguf, isGguf, ollamaLabel, ollamaModelDigest,
  type ForeignModel, type ForeignSource,
} from "../../core/runtime/foreign.ts";

/** Deep enough for `publisher/repo/quant/file.gguf`, shallow enough to stay quick. */
const MAX_DEPTH = 5;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `.gguf` under a directory, with its depth-first path.
 *
 * Symlinked directories are not followed. A user who has linked their model
 * store somewhere else is served by pointing Karen at the real location, and
 * following links here risks walking a cycle on someone's home directory.
 */
async function findGgufs(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findGgufs(path, depth + 1)));
    else if (entry.isFile() && isGguf(entry.name) && !isAuxiliaryGguf(entry.name)) out.push(path);
  }
  return out;
}

/**
 * LM Studio keeps `<publisher>/<repo>/<file>.gguf`.
 *
 * The filename already carries the quantisation (`...-Q4_K_M.gguf`), which is
 * the part that distinguishes two copies of the same model, so it makes a
 * better label than the directory does.
 */
export async function scanLmStudio(root: string): Promise<ForeignModel[]> {
  const files = await findGgufs(root);
  return files.map((path) => {
    const label = path.split(/[/\\]/).pop()?.replace(/\.gguf$/i, "") ?? "model";
    return {
      id: indexId("lmstudio", label),
      label,
      source: "lmstudio" as ForeignSource,
      path,
      linkName: `${label}.gguf`,
    };
  });
}

/**
 * Ollama keeps content-addressed blobs and a tree of manifests naming them.
 *
 * The blobs carry no extension and no model name, so the manifests are the only
 * way to tell `llama3.2:3b` from a licence file. Each manifest is a small JSON
 * document; there are rarely more than a few dozen.
 */
export async function scanOllama(root: string): Promise<ForeignModel[]> {
  const manifestRoot = join(root, "manifests");
  if (!(await exists(manifestRoot))) return [];

  const manifests = await findFiles(manifestRoot);
  const out: ForeignModel[] = [];
  for (const path of manifests) {
    const label = ollamaLabel(relative(manifestRoot, path));
    if (!label) continue;
    let digest: string | undefined;
    try {
      digest = ollamaModelDigest(JSON.parse(await readFile(path, "utf8")));
    } catch {
      continue; // Not a manifest, or not one this version of Ollama writes.
    }
    if (!digest) continue;
    const blob = join(root, "blobs", blobFile(digest));
    if (!(await exists(blob))) continue;
    out.push({
      id: indexId("ollama", label),
      label,
      source: "ollama",
      path: blob,
      /* The extension lives on the link, not on the blob: this is the whole
         reason Ollama's store can be read at all. */
      linkName: `${label.replace(/[/\\:]/g, "-")}.gguf`,
    });
  }
  return out;
}

async function findFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findFiles(path, depth + 1)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export interface Discovery {
  models: ForeignModel[];
  /** Stores that were actually present, for reporting in the UI. */
  found: { source: ForeignSource; dir: string; count: number }[];
}

/** Look in every default location, plus any the user added. */
export async function discoverForeign(extra: string[] = []): Promise<Discovery> {
  const stores = [
    ...defaultStores(homedir(), process.platform, process.env),
    /* A directory the user named themselves is scanned the LM Studio way:
       any GGUF under it, labelled by filename. */
    ...extra.filter((d) => d.trim()).map((dir) => ({ source: "lmstudio" as ForeignSource, dir })),
  ];

  const models: ForeignModel[] = [];
  const found: Discovery["found"] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();

  for (const store of stores) {
    if (!(await exists(store.dir))) continue;
    const batch = store.source === "ollama"
      ? await scanOllama(store.dir)
      : await scanLmStudio(store.dir);

    let kept = 0;
    for (const model of batch) {
      /* Two stores can hold the same file -- LM Studio's old and new locations
         are often one a symlink of the other -- and the same label can appear
         twice across publishers. Both would collide in the index. */
      const real = await realpath(model.path).catch(() => model.path);
      if (seenPaths.has(real) || seenIds.has(model.id)) continue;
      seenPaths.add(real);
      seenIds.add(model.id);
      models.push(model);
      kept += 1;
    }
    if (kept) found.push({ source: store.source, dir: store.dir, count: kept });
  }
  return { models, found };
}

/**
 * Mirror a directory tree as real directories holding symlinked files.
 *
 * Used for Karen's own models directory, which has to appear in the index too:
 * `extra_models_dir` takes one path, so the index is the only path, and a model
 * that is not mirrored into it disappears from the app. Mirroring rather than
 * renaming keeps every existing model id byte-for-byte what it was, which is
 * what stops this from silently invalidating a saved "load on launch".
 */
async function mirrorTree(from: string, into: string, depth = 0): Promise<number> {
  if (depth > MAX_DEPTH) return 0;
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(into, entry.name);
    if (entry.isDirectory()) {
      const n = await mirrorTree(source, join(into, entry.name), depth + 1);
      count += n;
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await mkdir(into, { recursive: true });
      await link(source, target);
      count += 1;
    }
  }
  return count;
}

/** Replace whatever is at `target` with a link to `source`. */
async function link(source: string, target: string): Promise<void> {
  const current = await readlink(target).catch(() => undefined);
  if (current === source) return;
  if (current !== undefined || (await exists(target))) await rm(target, { force: true });
  await symlink(source, target);
}

export interface IndexResult {
  dir: string;
  foreign: ForeignModel[];
  found: Discovery["found"];
}

/**
 * Build the single directory Lemonade is pointed at.
 *
 * Rebuilt on every start rather than kept in sync: a model deleted in LM Studio
 * leaves a dangling link, and a dangling link inside `extra_models_dir` is a
 * model that appears in Karen and fails to load. Starting from empty each time
 * costs a few milliseconds of `symlink` calls and cannot drift.
 */
export async function buildIndex(opts: {
  indexDir: string;
  modelsDir: string;
  extraDirs?: string[];
  includeForeign: boolean;
}): Promise<IndexResult> {
  const { indexDir, modelsDir } = opts;

  /* This function begins by deleting its own directory, so it refuses to run
     if that directory is, or contains, the user's models. Nothing in the code
     today can produce that -- the index lives under the app's own data dir --
     but the cost of the check is nothing and the cost of being wrong is
     someone's model library. */
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  };
  if (modelsDir && inside(indexDir, modelsDir)) {
    throw new Error(`Refusing to build the model index at ${indexDir}: it contains the models directory.`);
  }

  await rm(indexDir, { recursive: true, force: true });
  await mkdir(indexDir, { recursive: true });

  // Karen's own library first, so its ids win any collision with a foreign one.
  if (modelsDir && (await exists(modelsDir))) await mirrorTree(modelsDir, indexDir);

  if (!opts.includeForeign) return { dir: indexDir, foreign: [], found: [] };

  const { models, found } = await discoverForeign(opts.extraDirs ?? []);
  const kept: ForeignModel[] = [];
  for (const model of models) {
    const dir = join(indexDir, model.id);
    if (await exists(dir)) continue; // One of Karen's own already claimed the name.
    try {
      await mkdir(dir, { recursive: true });
      await symlink(model.path, join(dir, model.linkName));
      kept.push(model);
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* Written beside the index so the UI can say where a model came from. The
     ids encode it too, but this keeps the label readable -- `llama3.2:3b`
     rather than the colon-free directory name. */
  await writeFile(
    join(indexDir, "karen-sources.json"),
    `${JSON.stringify({ models: kept, found }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { dir: indexDir, foreign: kept, found };
}

/** Read back what the last build recorded, without rebuilding. */
export async function readIndexSources(indexDir: string): Promise<IndexResult> {
  const empty = { dir: indexDir, foreign: [], found: [] };
  try {
    const raw = JSON.parse(await readFile(join(indexDir, "karen-sources.json"), "utf8"));
    return {
      dir: indexDir,
      foreign: Array.isArray(raw.models) ? raw.models : [],
      found: Array.isArray(raw.found) ? raw.found : [],
    };
  } catch {
    return empty;
  }
}

/** Whether a path is a symlink, used only by the tests. */
export async function isLink(path: string): Promise<boolean> {
  return lstat(path).then((s) => s.isSymbolicLink()).catch(() => false);
}
