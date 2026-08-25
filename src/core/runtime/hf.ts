/**
 * Finding models on HuggingFace.
 *
 * Everything on the Hub is searchable, deliberately: a curated shortlist is a
 * good empty state and a bad filter, and the moment someone wants a model we
 * did not think of, a shortlist becomes the reason they go back to LM Studio.
 *
 * Two API shapes, both checked live rather than remembered:
 *
 *   - `/api/models?search=…&filter=gguf` for the repository list.
 *   - `/api/models/{repo}/tree/main?recursive=true` for the files, which
 *     carries an exact byte size and an `lfs.oid` sha256 per file. That is what
 *     makes a verified download possible.
 *
 * Two things break naive implementations and are handled here: **sharded**
 * models, which arrive as `…-00001-of-00002.gguf` and are useless in part, and
 * **gated** repositories, which need a licence accepted on the website before
 * any token will work.
 */

export interface HfModel {
  id: string;
  downloads?: number;
  likes?: number;
  gated?: false | "auto" | "manual";
  tags?: string[];
  lastModified?: string;
}

export interface HfFile {
  path: string;
  size: number;
  /** sha256 of the content, from git-lfs. Absent for small non-LFS files. */
  sha256?: string;
}

const API = "https://huggingface.co";

export function searchUrl(query: string, opts: { limit?: number; sort?: string } = {}): string {
  const params = new URLSearchParams({
    search: query,
    filter: "gguf",
    sort: opts.sort ?? "downloads",
    direction: "-1",
    limit: String(opts.limit ?? 25),
  });
  return `${API}/api/models?${params.toString()}`;
}

export function treeUrl(repo: string): string {
  return `${API}/api/models/${repo}/tree/main?recursive=true`;
}

export function infoUrl(repo: string): string {
  return `${API}/api/models/${repo}`;
}

/** The URL a file is actually downloaded from. */
export function downloadUrl(repo: string, path: string): string {
  return `${API}/${repo}/resolve/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}

interface RawTreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

export function parseTree(entries: unknown): HfFile[] {
  if (!Array.isArray(entries)) return [];
  const out: HfFile[] = [];
  for (const raw of entries as RawTreeEntry[]) {
    if (!raw?.path || !raw.path.toLowerCase().endsWith(".gguf")) continue;
    const size = raw.lfs?.size ?? raw.size ?? 0;
    const oid = raw.lfs?.oid;
    out.push({
      path: raw.path,
      size,
      ...(oid && /^[0-9a-f]{64}$/i.test(oid) ? { sha256: oid.toLowerCase() } : {}),
    });
  }
  return out;
}

/** `…-00001-of-00003.gguf` → `{ stem, index, total }`. */
const SHARD = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;

export interface ModelFile {
  /** What to show: the shard suffix removed when there is one. */
  label: string;
  /** Every file that must be downloaded, in order. One entry when not sharded. */
  parts: HfFile[];
  /** Total bytes across all parts. */
  size: number;
  /** The file to pass to `-m`: the first shard, which names the rest. */
  entry: string;
}

/**
 * Group a repository's GGUF files into things a user can choose.
 *
 * A sharded model is one choice, not five: offering the parts separately
 * invites someone to download a third of a model.
 */
export function groupFiles(files: HfFile[]): ModelFile[] {
  const shards = new Map<string, HfFile[]>();
  const singles: HfFile[] = [];

  for (const f of files) {
    const base = f.path.slice(f.path.lastIndexOf("/") + 1);
    const m = SHARD.exec(base);
    if (m) {
      const key = `${f.path.slice(0, f.path.length - base.length)}${m[1]}`;
      const list = shards.get(key) ?? [];
      list.push(f);
      shards.set(key, list);
    } else {
      singles.push(f);
    }
  }

  const out: ModelFile[] = singles.map((f) => ({
    label: f.path,
    parts: [f],
    size: f.size,
    entry: f.path,
  }));

  for (const [key, parts] of shards) {
    parts.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
    out.push({
      label: `${key}.gguf`,
      parts,
      size: parts.reduce((n, p) => n + p.size, 0),
      entry: parts[0]!.path,
    });
  }

  return out.sort((a, b) => a.size - b.size);
}

/** The quantisation in a filename, for display: `…-Q4_K_M.gguf` → `Q4_K_M`. */
export function quantOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
  // Q4_K_M, IQ4_XS, Q8_0, BF16 -- the suffix runs to the end of the name and may
  // carry several underscore-separated parts, which is why this is a repeated
  // group rather than one optional tail.
  const m = /[.\-_]((?:IQ|TQ|Q)\d+(?:[.\-_][A-Z0-9]+)*|BF16|F16|F32)$/i.exec(base);
  return m?.[1]?.toUpperCase();
}

export class GatedError extends Error {
  override readonly name = "GatedError";
  readonly repo: string;
  constructor(repo: string) {
    super(
      `${repo} requires you to accept its licence on huggingface.co before it can be downloaded. ` +
        `Open the model page, accept, then add an access token in Settings.`,
    );
    this.repo = repo;
  }
}
