/**
 * Which registry a model comes from, and what to call it in front of a person.
 *
 * Lemonade can reach two registries. MyRA uses one: Hugging Face. ModelScope
 * is disabled -- see `ENABLED_SOURCES` for why, and for how to put it back.
 *
 * Browsing itself now happens in `hfBrowse.ts`, which talks to the registry's
 * own API because Lemonade's search offers a single `search=` parameter and
 * cannot express a publisher or a kind of model. What stays here is everything
 * about *identity and provenance* -- naming, labelling, and turning a
 * repository into something downloadable -- because those are shared by both
 * paths and must never disagree.
 *
 *   - **The country is part of the name.** Not a tooltip, not an icon, not a
 *     colour: the label a non-technical person reads is `Hugging Face [US]`,
 *     everywhere the registry is named. Someone checking an institutional
 *     policy should not have to already know where the files come from.
 *   - **Every result carries its origin**, even now that they all share one. A
 *     badge shown only on exceptions makes an unlabelled row ambiguous -- "the
 *     usual one" or "nobody checked" are indistinguishable -- and the whole
 *     point is that nobody has to guess.
 *   - **Downloading still goes through Lemonade.** `parseVariants`,
 *     `checkpointFor` and `modelNameFor` describe the daemon's own pull API,
 *     which remains the only thing that fetches a file.
 */

/** The two registries lemonade can reach. */
export type RegistrySource = "huggingface" | "modelscope";

/** Every registry lemonade knows, which is not the same as every one MyRA uses. */
export const KNOWN_SOURCES: RegistrySource[] = ["huggingface", "modelscope"];

/**
 * The registries MyRA will actually contact. **Hugging Face only.**
 *
 * ModelScope is deliberately not here. The labels, parsing and plumbing for it
 * remain -- it costs nothing to keep and re-enabling is this one line -- but
 * nothing in MyRA may search it, list a repository on it, or download from
 * it, and `isEnabled` is checked in the main process rather than only in the
 * UI so that a stored config or a stale renderer cannot reach it either.
 *
 * The reason is institutional rather than technical: for the researchers MyRA
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

/* Narrowing helpers for the daemon's JSON, which is `unknown` at the boundary
   and must not be trusted to have the shapes its docs promise. */
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

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
  /**
   * How well a build of this size runs here. Lower is better.
   *
   * A tier rather than a yes/no, because "fits" has more than two answers and
   * the difference between them decides the badge. A machine with a card wants
   * the best build that fits *on the card*; a machine without one, or one whose
   * card is too small for anything here, still wants the best build that will
   * run at all rather than one marked "Too large". Before this the badge was
   * pinned to `Q4_K_M` by preference order alone, and sat beside "Too large" on
   * a 30B repository -- the app recommending the choice that will not work.
   *
   * Within a tier the order is unchanged and simply filtered: bigger is not
   * better here, so a machine with room to spare still gets Q4_K_M rather than
   * being pushed up to Q8_0. With no tier function at all, the fixed order
   * stands.
   */
  tier?: (sizeBytes: number) => number,
): RepoVariant | undefined {
  if (!variants.length) return undefined;
  const byPreference = [...variants].sort((a, b) => {
    const byRank = rank(a.name) - rank(b.name);
    if (byRank !== 0) return byRank;
    return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
  });
  if (tier) {
    const sized = byPreference.filter((v) => v.sizeBytes !== undefined);
    const best = Math.min(...sized.map((v) => tier(v.sizeBytes ?? 0)));
    if (Number.isFinite(best)) {
      const runnable = sized.find((v) => tier(v.sizeBytes ?? 0) === best);
      if (runnable) return runnable;
    }
  }
  return byPreference[0];
}
