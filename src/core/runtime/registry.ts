/**
 * Searching the model registry, and being unambiguous about which one.
 *
 * Lemonade can reach two registries. Karen uses one: Hugging Face. ModelScope
 * is disabled -- see `ENABLED_SOURCES` for why, and for how to put it back.
 *
 * What survives that decision, and is the point of this module:
 *
 *   - **The country is part of the name.** Not a tooltip, not an icon, not a
 *     colour: the label a non-technical person reads is `Hugging Face [US]`,
 *     everywhere the registry is named. Someone checking an institutional
 *     policy should not have to already know where the files come from.
 *   - **Every result carries its origin**, even now that they all share one. A
 *     badge shown only on exceptions makes an unlabelled row ambiguous -- "the
 *     usual one" or "nobody checked" are indistinguishable -- and the whole
 *     point is that nobody has to guess.
 *   - **Searching is itself egress.** The query text goes to the registry
 *     before anything is downloaded, which is why it is sent on an explicit
 *     press rather than on every keystroke.
 *
 * Measured against lemonade 11.8.0, which does the fetching:
 *
 *   GET /api/v1/registry/search?query=&source=&limit=1..50
 *   GET /api/v1/pull/variants?checkpoint=&source=
 */

/** The two registries lemonade can reach. */
export type RegistrySource = "huggingface" | "modelscope";

/** Every registry lemonade knows, which is not the same as every one Karen uses. */
export const KNOWN_SOURCES: RegistrySource[] = ["huggingface", "modelscope"];

/**
 * The registries Karen will actually contact. **Hugging Face only.**
 *
 * ModelScope is deliberately not here. The labels, parsing and plumbing for it
 * remain -- it costs nothing to keep and re-enabling is this one line -- but
 * nothing in Karen may search it, list a repository on it, or download from
 * it, and `isEnabled` is checked in the main process rather than only in the
 * UI so that a stored config or a stale renderer cannot reach it either.
 *
 * The reason is institutional rather than technical: for the researchers Karen
 * is for, obtaining models from a PRC-hosted service can be a policy breach,
 * and an option that is merely labelled is still an option that can be clicked
 * by accident. It was also, measured, half-broken from outside its region --
 * its search answered while its file listing timed out -- so nothing usable is
 * being given up.
 */
export const ENABLED_SOURCES: RegistrySource[] = ["huggingface"];

export function isEnabled(source: RegistrySource): boolean {
  return ENABLED_SOURCES.includes(source);
}

/**
 * What a person reads. The bracketed country is not decoration -- it is the
 * only part of this string that some users are actually allowed to act on.
 */
export const REGISTRY_LABEL: Record<RegistrySource, string> = {
  huggingface: "Hugging Face [US]",
  modelscope: "ModelScope [CN]",
};

/** The label without the country, for prose where the country is stated near by. */
export const REGISTRY_NAME: Record<RegistrySource, string> = {
  huggingface: "Hugging Face",
  modelscope: "ModelScope",
};

/** The host a search or download actually contacts, and who runs it. */
export const REGISTRY_HOST: Record<RegistrySource, string> = {
  huggingface: "huggingface.co — United States",
  modelscope: "modelscope.cn — operated by Alibaba, hosted in China",
};

/**
 * Read a source from stored or API data, defaulting to Hugging Face.
 *
 * The catalogue states `source` only when it is *not* Hugging Face, so the
 * absent case has to mean huggingface rather than "unknown". That is a
 * property of upstream's file, and the only place it is relied upon.
 */
export function readSource(value: unknown): RegistrySource {
  return value === "modelscope" ? "modelscope" : "huggingface";
}

/* ------------------------------------------------------------- searching -- */

/** One repository, as a registry search returns it. */
export interface RegistryHit {
  /** `org/name`, which is what identifies it to a download. */
  id: string;
  /** The registry's own display name; on ModelScope often Chinese. */
  name: string;
  source: RegistrySource;
  downloads?: number | undefined;
  likes?: number | undefined;
  /** Whether the repository holds GGUF files, which is what llama.cpp runs. */
  hasGguf: boolean;
  description?: string | undefined;
  tags: string[];
}

export interface SearchResult {
  source: RegistrySource;
  /**
   * How many rows lemonade asked the registry for -- **not** how many came
   * back. The two differ a lot: "whisper" fetches 50 and yields 5, because
   * unsupported repository types are dropped after the fetch. Printing this as
   * a result count would be a lie, so it is named for what it is.
   */
  fetched: number;
  hits: RegistryHit[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function parseSearch(raw: unknown, fallback: RegistrySource): SearchResult {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const source = body["source"] === undefined ? fallback : readSource(body["source"]);
  const rows = Array.isArray(body["results"]) ? body["results"] : [];
  const hits: RegistryHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = str(r["repository_id"]);
    if (!id) continue;
    hits.push({
      id,
      name: str(r["display_name"]) ?? id,
      /* Per row rather than per response: a combined search merges two
         responses into one list, and a row that has lost track of where it
         came from cannot be labelled. */
      source: r["source"] === undefined ? source : readSource(r["source"]),
      hasGguf: r["has_gguf"] === true,
      tags: Array.isArray(r["tags"]) ? r["tags"].filter((t): t is string => typeof t === "string") : [],
      ...(num(r["downloads"]) !== undefined ? { downloads: num(r["downloads"]) } : {}),
      ...(num(r["likes"]) !== undefined ? { likes: num(r["likes"]) } : {}),
      ...(str(r["description"]) ? { description: str(r["description"]) } : {}),
    });
  }
  return { source, fetched: num(body["total"]) ?? hits.length, hits };
}

/**
 * Merge results from several registries into one list.
 *
 * **Runnable first, then popular.** Measured on a plain search for "qwen": the
 * five most-downloaded repositories are all safetensors, which Karen cannot
 * run, so ordering by downloads alone buries the first usable result below a
 * screen of dead ends. GGUF is what llama.cpp loads, so `has_gguf` is the
 * closest thing the registries give to "you could actually use this".
 *
 * Within each half, downloads -- the only comparable figure both registries
 * report. Deduplicated on source+id rather than id alone: the same
 * `unsloth/Qwen3-30B-A3B-GGUF` exists on both, and collapsing them would hide
 * from a user that one of their two copies is the one they may not use.
 */
export function mergeHits(results: SearchResult[]): RegistryHit[] {
  const seen = new Set<string>();
  const all: RegistryHit[] = [];
  for (const result of results) {
    for (const hit of result.hits) {
      const key = `${hit.source}/${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(hit);
    }
  }
  return all.sort(
    (a, b) => Number(b.hasGguf) - Number(a.hasGguf) || (b.downloads ?? 0) - (a.downloads ?? 0),
  );
}

/**
 * Turn a failed call into a sentence a person can act on.
 *
 * The client's own error names the path and pastes the body, which is right
 * for a log and wrong for a pane: `/pull/variants?checkpoint=Qwen%2F… failed
 * (500): {"error":"ModelScope API returned status 500"}` tells an academic
 * nothing except that something technical went wrong.
 *
 * ModelScope's file listing in particular fails this way from outside China --
 * its own API answers `DeadlineExceeded` on the directory tree while search
 * works fine -- so this is the error users are most likely to meet, and it
 * deserves to say what to do rather than what broke.
 */
export function explainRegistryError(message: string, source: RegistrySource): string {
  const inner = /\{"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  const detail = (inner?.[1] ?? message.replace(/^\/\S+\s+failed\s+\(\d+\):\s*/, "")).trim();
  if (/status 5\d\d|timeout|timed out|deadline/i.test(detail)) {
    return `${REGISTRY_NAME[source]} did not answer in time. Its search works, but listing a repository's files often fails from outside its own region — try again, or use the other registry.`;
  }
  return detail || `${REGISTRY_NAME[source]} could not be read.`;
}

/* -------------------------------------------------------------- variants -- */

/** One quantisation of a repository: what you actually download. */
export interface RepoVariant {
  /** `Q4_K_M`, `UD-Q4_K_XL`, `BF16`… */
  name: string;
  /** The file to name in a pull; the others come with it. */
  primaryFile: string;
  files: string[];
  sizeBytes?: number | undefined;
  /** Split across several files, which is worth saying before a 60 GB pull. */
  sharded: boolean;
}

export interface RepoVariants {
  checkpoint: string;
  source: RegistrySource;
  /** The engine that will run it, which decides whether it is usable at all. */
  recipe?: string | undefined;
  /** Upstream's suggested id for the model once installed. */
  suggestedName?: string | undefined;
  suggestedLabels: string[];
  /** Vision projectors; their presence is what makes a model multimodal. */
  mmprojFiles: string[];
  variants: RepoVariant[];
}

export function parseVariants(raw: unknown, fallback: RegistrySource): RepoVariants {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(body["variants"]) ? body["variants"] : [];
  const variants: RepoVariant[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const v = row as Record<string, unknown>;
    const name = str(v["name"]);
    const primary = str(v["primary_file"]);
    if (!name || !primary) continue;
    variants.push({
      name,
      primaryFile: primary,
      files: Array.isArray(v["files"]) ? v["files"].filter((f): f is string => typeof f === "string") : [primary],
      sharded: v["sharded"] === true,
      ...(num(v["size_bytes"]) !== undefined ? { sizeBytes: num(v["size_bytes"]) } : {}),
    });
  }
  const strList = (key: string): string[] =>
    Array.isArray(body[key]) ? (body[key] as unknown[]).filter((f): f is string => typeof f === "string") : [];
  return {
    checkpoint: str(body["checkpoint"]) ?? "",
    source: body["source"] === undefined ? fallback : readSource(body["source"]),
    suggestedLabels: strList("suggested_labels"),
    mmprojFiles: strList("mmproj_files"),
    variants,
    ...(str(body["recipe"]) ? { recipe: str(body["recipe"]) } : {}),
    ...(str(body["suggested_name"]) ? { suggestedName: str(body["suggested_name"]) } : {}),
  };
}

/**
 * The checkpoint string a pull wants: `org/repo:file.gguf`.
 *
 * Sharded variants name their first file, which is how llama.cpp finds the
 * rest -- naming the whole set here would produce a checkpoint no endpoint
 * accepts.
 */
export function checkpointFor(repo: string, variant: RepoVariant): string {
  return `${repo}:${variant.primaryFile}`;
}

/**
 * A readable model id from a repository and quantisation.
 *
 * The repository's own name is not enough on its own: two quantisations of the
 * same repo would install over each other, and the size is the thing a person
 * chose between.
 */
export function modelNameFor(repo: string, variant: RepoVariant): string {
  const leaf = repo.split("/").pop() ?? repo;
  return `${leaf}-${variant.name}`;
}

/**
 * Which quantisation to put forward, by the usual rule of thumb.
 *
 * Below Q4 quality degrades noticeably, Q4_K_M is the ordinary default, and
 * above Q6 the gains are small next to the size. `quantRank` in `fit.ts`
 * encodes that order; this applies it and falls back to the largest variant
 * that is not obviously a full-precision dump.
 */
export function recommendVariant(
  variants: RepoVariant[],
  rank: (name: string) => number,
): RepoVariant | undefined {
  if (!variants.length) return undefined;
  return [...variants].sort((a, b) => {
    const byRank = rank(a.name) - rank(b.name);
    if (byRank !== 0) return byRank;
    return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
  })[0];
}

/** `12078219` → `12.1M`, because nine digits in a table is not a figure. */
export function formatCount(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** The most rows lemonade will fetch from a registry in one search. */
export const SEARCH_LIMIT = 50;

/**
 * Say what a search found, without claiming more than was measured.
 *
 * The two registries mean different things by `total`, which is a trap:
 *
 *   - Hugging Face returns exactly what was asked for -- ask 50, `total` is
 *     50 -- so anything missing from the results was fetched and then dropped
 *     for being a format Karen cannot run.
 *   - ModelScope returns the size of the whole match set: 24,742 for "qwen".
 *     Those were never fetched, so saying they are "in formats Karen cannot
 *     run" asserts something about 24,692 repositories nobody looked at.
 *
 * Both facts are useful and they are different sentences, so which one is
 * printed follows from whether the registry reported more than was requested.
 */
export function describeSearch(shown: number, fetched: number, asked = SEARCH_LIMIT): string {
  const results = `${shown} ${shown === 1 ? "result" : "results"}`;
  if (fetched > asked) {
    return `${results} — ${fetched.toLocaleString("en-GB")} models match; these are the first Karen can run.`;
  }
  if (shown < fetched) {
    const dropped = fetched - shown;
    return `${results} — ${dropped} more matched but ${dropped === 1 ? "is" : "are"} in formats Karen cannot run.`;
  }
  return results;
}
