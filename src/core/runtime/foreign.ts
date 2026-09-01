/**
 * Models the user already downloaded with LM Studio or Ollama.
 *
 * Someone who has been running local models before Karen has tens of gigabytes
 * of GGUF files on disk already. Asking them to download the same weights a
 * second time is the kind of thing that makes a tool feel like it was written
 * for its author rather than for them, so Karen finds those files and offers
 * them alongside everything else.
 *
 * ## Why this is a directory of symlinks rather than an API call
 *
 * Lemonade owns the model list now, and it takes exactly one hint about models
 * it did not download itself: `extra_models_dir`. Measured against the daemon,
 * that setting behaves as follows, and each of these shaped the design:
 *
 *   - It is scanned **recursively**, and a model's id is the name of the
 *     **leaf directory** holding the `.gguf` (or the filename, for a loose
 *     one). So naming the directory names the model.
 *   - Symlinked **files** are followed. Symlinked **directories** are not: a
 *     link to a tree is skipped silently, which is why this cannot simply
 *     point at `~/.lmstudio` and be done with it.
 *   - The `.gguf` extension is taken from the **link**, not from its target.
 *     That is what makes Ollama reachable at all, because its blobs are
 *     content-addressed files named `sha256-<hex>` with no extension.
 *   - It must be a **string**. Passing a list of directories does not merge
 *     them, it kills the daemon at startup with a JSON type error, so there is
 *     exactly one place to put everything.
 *
 * Hence: one real directory per model, each holding one symlink. No weights are
 * copied, and nothing the user owns is moved or written to.
 */

/** Where a model was found. Karen's own downloads are not "foreign". */
export type ForeignSource = "lmstudio" | "ollama";

export interface ForeignModel {
  /** The id Lemonade will report, and the index directory's name. */
  id: string;
  /** What to show a person: `llama3.2:3b`, `Llama-3.2-3B-Instruct-Q4_K_M`. */
  label: string;
  source: ForeignSource;
  /** The real GGUF on disk, which is never moved or copied. */
  path: string;
  /** The name the symlink takes inside the index directory. */
  linkName: string;
}

export const SOURCE_LABELS: Record<ForeignSource, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
};

/**
 * Where each tool keeps its models, by platform.
 *
 * Ollama honours `OLLAMA_MODELS`; LM Studio has no equivalent environment
 * variable, so both of its historical locations are checked instead.
 */
export function defaultStores(
  home: string,
  platform: string,
  env: Record<string, string | undefined> = {},
): { source: ForeignSource; dir: string }[] {
  const j = (...parts: string[]): string => parts.join("/");
  const out: { source: ForeignSource; dir: string }[] = [];

  /* LM Studio: `~/.lmstudio/models` since 0.3, `~/.cache/lm-studio/models`
     before it. Both are listed; the scanner skips whichever is absent. */
  out.push({ source: "lmstudio", dir: j(home, ".lmstudio", "models") });
  if (platform === "win32") {
    out.push({ source: "lmstudio", dir: j(home, "AppData", "Local", "LM-Studio", "models") });
  } else {
    out.push({ source: "lmstudio", dir: j(home, ".cache", "lm-studio", "models") });
  }

  const ollama = env["OLLAMA_MODELS"];
  out.push({
    source: "ollama",
    dir: ollama && ollama.trim() ? ollama.trim() : j(home, ".ollama", "models"),
  });
  return out;
}

/**
 * A path component safe on every platform Karen runs on.
 *
 * Ollama writes tags as `name:tag`, and a colon is legal in a filename on Linux
 * but not on Windows. Without this the index fails to build on the one platform
 * where a user is most likely to have installed both tools.
 */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[/\\:<>"|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "model";
}

/**
 * The display name of an Ollama model, from the path of its manifest.
 *
 * Manifests live at `manifests/<registry>/<namespace>/<name>/<tag>`, so the
 * last segment is the tag, the one before it is the name, and anything between
 * the registry and the name is a namespace. `library` is Ollama's own namespace
 * for official models and is dropped, because nobody types it.
 */
export function ollamaLabel(relativeManifestPath: string): string | undefined {
  const parts = relativeManifestPath.split(/[/\\]/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const tag = parts[parts.length - 1];
  const name = parts[parts.length - 2];
  const namespace = parts.slice(1, parts.length - 2).join("/");
  if (!tag || !name) return undefined;
  const stem = !namespace || namespace === "library" ? name : `${namespace}/${name}`;
  return `${stem}:${tag}`;
}

/** The media type Ollama gives the layer that is the actual GGUF. */
const OLLAMA_MODEL_LAYER = "application/vnd.ollama.image.model";

/**
 * The blob digest of a manifest's weights layer.
 *
 * A manifest lists the template, licence and parameters beside the model, so
 * the media type is what picks the right one. Taking the largest layer would
 * usually work, and would silently pick a licence file for a tiny model.
 */
export function ollamaModelDigest(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const layers = (manifest as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return undefined;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    const { mediaType, digest } = layer as { mediaType?: unknown; digest?: unknown };
    if (mediaType === OLLAMA_MODEL_LAYER && typeof digest === "string" && digest) return digest;
  }
  return undefined;
}

/** A digest `sha256:abc` names the file `blobs/sha256-abc`. */
export function blobFile(digest: string): string {
  return digest.replace(":", "-");
}

/**
 * The index directory name for a foreign model.
 *
 * Prefixed by source so that two tools holding the same model do not collide,
 * and so the id itself still says where it came from if the manifest written
 * beside the index is ever lost.
 */
export function indexId(source: ForeignSource, label: string): string {
  return `${source}__${safeSegment(label)}`;
}

/** Split an index id back into its source, for the UI. */
export function readIndexId(id: string): { source: ForeignSource; label: string } | undefined {
  for (const source of Object.keys(SOURCE_LABELS) as ForeignSource[]) {
    const prefix = `${source}__`;
    if (id.startsWith(prefix)) return { source, label: id.slice(prefix.length) };
  }
  return undefined;
}

/**
 * What to show a person for a model id.
 *
 * Models found in LM Studio or Ollama are registered under `lmstudio__NAME`,
 * because the index directory name *is* the id Lemonade reports and two tools
 * can hold a model of the same name. That prefix is bookkeeping, and it should
 * never have been on screen: what someone downloaded in LM Studio is called
 * `LFM2.5-8B-A1B`, and that is what they are looking for.
 *
 * The id itself is untouched -- it is what `load` and every chat request name,
 * and renaming it would orphan the index. Only the label changes.
 */
export function displayModelName(id: string): string {
  const known = readIndexId(id);
  if (known) return known.label;
  /* Anything else registered from a directory carries a flattened repository
     path -- `bartowski__SmolLM2-135M-Instruct-GGUF` is `bartowski/SmolLM2-…`.
     The publisher is as much noise here as the tool name: nobody looking for
     the model they downloaded searches for who packaged it. */
  const cut = id.lastIndexOf("__");
  const tail = cut === -1 ? "" : id.slice(cut + 2);
  return tail || id;
}

/**
 * The shortest name that still identifies a model on screen.
 *
 * Repository paths, index prefixes and quantisation suffixes are most of the
 * length and least of the meaning: `lmstudio__LFM2.5-8B-A1B` is "LFM2.5-8B-A1B",
 * and `unsloth/Qwen3-Coder-30B-…-GGUF` is "Qwen3-Coder-30B".
 */
export function shortModelName(id: string): string {
  const named = displayModelName(id);
  const base = named.slice(named.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
  return base.replace(/-(GGUF|(?:IQ|TQ|Q)\d+[\w.]*|BF16|F16|F32)$/i, "");
}

/**
 * Narrow a model list by what someone typed.
 *
 * Here rather than in the menu that uses it because the menu is a .tsx, which
 * the test runner cannot load -- Node's type stripping does not do JSX. The
 * search box also only appears once there are more than six models, so it is
 * invisible on every machine this was developed on. Untested filtering over a
 * list nobody here can see is the shape of thing that ships broken.
 *
 * Matches the shortened text AND the full id. A row for
 * `unsloth__Qwen3-Coder-30B-…` reads as "Qwen3-Coder-30B", so matching only
 * what is on screen would make "unsloth" find nothing -- while being exactly
 * how someone with sixty models narrows to one publisher's.
 */
export function filterModels<T extends { path: string; name: string }>(
  models: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter(
    (m) =>
      shortModelName(m.name).toLowerCase().includes(needle) ||
      m.path.toLowerCase().includes(needle),
  );
}

/** Which tool a model was found in, when it was found rather than downloaded. */
export function sourceOfModel(id: string): ForeignSource | undefined {
  return readIndexId(id)?.source;
}

export function isGguf(name: string): boolean {
  return name.toLowerCase().endsWith(".gguf");
}

/**
 * Files that are part of a model but are not the model.
 *
 * `mmproj` holds a vision projector, and offering one as a chat model produces
 * a load failure with nothing on screen to explain it. Split archives are
 * listed once, under their first part, for the same reason.
 */
export function isAuxiliaryGguf(name: string): boolean {
  if (/(^|[-._])mmproj/i.test(name)) return true;
  const split = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(name);
  return split ? split[1] !== "00001" : false;
}
