/**
 * Uploaded papers on disk: `<root>/<id>/{original.<ext>, text.json, source.json}`.
 *
 * The root is a folder the person can see -- `~/Documents/myra/sources` by
 * default, beside research runs and papers, and movable in Settings -- because
 * these are papers they chose to keep, and a file manager is where people look
 * for papers. The root itself is theirs and never re-chmodded; each paper's own
 * directory is MyRA's and is `0700`, its files `0600`, since a colleague's
 * preprint dropped in here is exactly what another account should not read.
 *
 * `source.json` is the done-marker and is written last -- see
 * [source.ts](./source.ts). Extraction is injected, so this is tested with no
 * pdftotext and no Electron.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeOwnDir, makePrivateDir, OWNER_ONLY_FILE } from "../paths.ts";
import { fullTextOf, type FullText } from "./fulltext.ts";
import {
  assertSourceId, doiFrom, parseSource, sourceExtension, sourceId, titleGuess,
  type Source, type TextStatus,
} from "./source.ts";

export const SOURCE_JSON = "source.json";
export const TEXT_JSON = "text.json";

/** Pages of text, or why there are none. */
export type Extractor = (
  name: string,
  bytes: Uint8Array,
) => Promise<{ pages: string[]; paged: boolean } | { error: string; scanned?: boolean }>;

/** Well past any paper; a file this size is a book scan or a mistake. */
export const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

async function writePrivate(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.partial`;
  await writeFile(temp, data, { mode: OWNER_ONLY_FILE });
  await rename(temp, path);
}

/**
 * Keep a paper: the file, its text, then the record.
 *
 * A paper whose text could not be read is still kept -- the person chose it
 * and can still open it -- but is marked, so search says it was skipped rather
 * than implying it said nothing.
 */
export async function addSource(
  root: string,
  name: string,
  bytes: Uint8Array,
  extract: Extractor,
  now = new Date(),
): Promise<Source> {
  const ext = sourceExtension(name);
  if (!ext) throw new Error(`${name} is not a file MyRA can read the text of — use a PDF, Word, ODT, RTF, Markdown or plain-text file.`);
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`${name} is over ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`);
  if (!bytes.byteLength) throw new Error(`${name} is empty.`);

  const extracted = await extract(name, bytes).catch(
    (err: unknown): { error: string; scanned?: boolean } => ({ error: (err as Error).message }),
  );
  const pages = "pages" in extracted ? extracted.pages : [];
  const id = assertSourceId(sourceId(titleGuess(pages, name), now));

  await makePrivateDir(root);
  const dir = join(root, id);
  await makeOwnDir(dir);
  const file = `original.${ext}`;
  await writePrivate(join(dir, file), bytes);

  let text: TextStatus = "failed";
  let textError: string | undefined;
  if ("pages" in extracted && extracted.pages.some((p) => p.trim())) {
    await writePrivate(join(dir, TEXT_JSON), `${JSON.stringify({ pages: extracted.pages, paged: extracted.paged })}\n`);
    text = "ok";
  } else if ("error" in extracted) {
    text = extracted.scanned ? "scanned" : "failed";
    textError = extracted.error;
  } else {
    text = "scanned";
    textError = "no text could be found in it — it is probably scanned images, which need OCR";
  }

  const source: Source = {
    id,
    title: titleGuess(pages, name),
    authors: "",
    year: "",
    doi: doiFrom(pages),
    file,
    originalName: name,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pages: pages.length,
    paged: "pages" in extracted ? extracted.paged : true,
    text,
    ...(textError ? { textError } : {}),
    addedAt: now.toISOString(),
  };
  await writePrivate(join(dir, SOURCE_JSON), `${JSON.stringify(source, null, 2)}\n`);
  return source;
}

export async function readSource(root: string, id: string): Promise<Source | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, assertSourceId(id), SOURCE_JSON), "utf8")) as unknown;
    return parseSource(raw, id);
  } catch {
    return undefined;
  }
}

/** Every finished source, newest first. A directory with no `source.json` is an interrupted add, and is not shown. */
export async function listSources(root: string): Promise<Source[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: Source[] = [];
  for (const name of names) {
    try {
      assertSourceId(name);
    } catch {
      continue;
    }
    const source = await readSource(root, name);
    if (source) out.push(source);
  }
  return out.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id.localeCompare(a.id));
}

export async function saveSource(root: string, source: Source): Promise<Source> {
  await writePrivate(join(root, assertSourceId(source.id), SOURCE_JSON), `${JSON.stringify(source, null, 2)}\n`);
  return source;
}

/** The paper's text, sections recomputed from the stored pages so a better heading reader applies to old papers too. */
export async function readSourceText(root: string, id: string): Promise<FullText | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, assertSourceId(id), TEXT_JSON), "utf8")) as {
      pages?: unknown;
      paged?: unknown;
    };
    if (!Array.isArray(raw.pages)) return undefined;
    const pages = raw.pages.map((p) => (typeof p === "string" ? p : ""));
    return fullTextOf(pages, raw.paged !== false);
  } catch {
    return undefined;
  }
}

/** The stored file's absolute path, for opening it in the system viewer. */
export function sourceFile(root: string, source: Source): string {
  return join(root, assertSourceId(source.id), source.file);
}

export async function removeSource(root: string, id: string): Promise<void> {
  await rm(join(root, assertSourceId(id)), { recursive: true, force: true });
}
