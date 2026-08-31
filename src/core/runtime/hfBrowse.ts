/**
 * Browsing Hugging Face the way LM Studio does, rather than the way a
 * subprocess happens to.
 *
 * Karen's registry search went through Lemonade, which offers exactly one
 * knob: `search=<text>`, capped at 50, matched against repository names. That
 * is not a search experience, and three measurements say why.
 *
 *   - **"granite" returned 42 repositories of which 5 were usable.** Not
 *     because of any filtering Karen added: only 5 of them contain GGUF files
 *     at all. Hugging Face's own publisher page shows 36 `ibm-granite` repos
 *     because it lists what exists rather than what one runtime can load.
 *   - **There is no way to ask for a publisher.** Lemonade sends no `author=`,
 *     so "show me everything IBM publishes" cannot be expressed. Name matching
 *     is a poor substitute: it finds `AnkitAI/Parable-Granite-…` and misses
 *     nothing published under a different name.
 *   - **There is no way to ask for a kind of model.** No `pipeline_tag`, so
 *     image, speech and embedding models are unreachable except by guessing
 *     words that might appear in their titles.
 *
 * Hugging Face's own API answers all three, and Karen already sends every
 * search to that host -- `lemond` makes the call today. Talking to it directly
 * changes which process opens the socket, not which company receives the
 * query, and it buys `author`, `pipeline_tag`, `filter`, `sort` and a hundred
 * results a page.
 *
 * **Nothing here is curated.** An earlier version of the shelves dropped
 * safety-stripped merges, capped how many repositories one owner could
 * occupy, and cut the list at 24. That was the wrong instinct: a person
 * looking for a model wants the registry's answer, not Karen's opinion of it.
 * What is kept is *labelling* -- every row says what it is and whether this
 * machine can run it -- because describing a result is not the same as hiding
 * it.
 */

/** A Hugging Face model as this app needs it. */
export interface HfModel {
  /** `org/name`. */
  id: string;
  owner: string;
  /** Rolling 30-day count. Not a lifetime total; see `describeDownloads`. */
  downloads?: number | undefined;
  likes?: number | undefined;
  /** `text-generation`, `text-to-image`, … Often absent. */
  task?: string | undefined;
  tags: string[];
  /** Whether the repository advertises GGUF, which is what llama.cpp reads. */
  hasGguf: boolean;
  /** ISO date the repository was created, when the API supplied it. */
  createdAt?: string | undefined;
  gated: boolean;
}

/**
 * The kinds of model worth offering as a tab.
 *
 * Keyed by Hugging Face's `pipeline_tag`, because that is the only filter the
 * API accepts -- a tab that filtered client-side would show "12 results" over
 * a page that fetched 100 and would page inconsistently.
 *
 * `runnable` records whether Karen can actually load this kind today. It is
 * false for image, video and speech synthesis, and that is not pessimism:
 * Lemonade's pull path reports `recipe: llamacpp` for ANY repository
 * containing `.gguf` files -- measured, on `Kijai/WanVideo_comfy_GGUF` and
 * `SporkySporkness/FLUX.1-Canny-dev-GGUF`, both of which are diffusion models
 * that llama.cpp cannot execute. Those kinds are still listed, because the
 * request was to see what the registry holds; they are marked so that nobody
 * spends twelve gigabytes discovering it.
 */
export interface ModelKind {
  id: string;
  title: string;
  /** The `pipeline_tag` values this tab asks for; empty means no filter. */
  tasks: string[];
  hint: string;
  /** Whether Karen can load this kind once downloaded. */
  runnable: boolean;
}

export const KINDS: ModelKind[] = [
  {
    id: "all",
    title: "Everything",
    tasks: [],
    hint: "Every repository the registry returns, unfiltered.",
    runnable: true,
  },
  {
    id: "chat",
    title: "Chat and writing",
    tasks: ["text-generation"],
    hint: "Answering questions, drafting, summarising.",
    runnable: true,
  },
  {
    id: "vision",
    title: "Reading images",
    tasks: ["image-text-to-text"],
    hint: "Models that can look at a figure, a scan or a screenshot.",
    runnable: true,
  },
  {
    id: "speech",
    title: "Transcription",
    tasks: ["automatic-speech-recognition"],
    hint: "Audio into text. Whisper builds are ggml rather than GGUF, so most will not load in Karen yet.",
    runnable: false,
  },
  {
    id: "voice",
    title: "Speech synthesis",
    tasks: ["text-to-speech"],
    hint: "Reading text aloud. Lemonade runs these through Kokoro, not llama.cpp.",
    runnable: false,
  },
  {
    id: "image",
    title: "Image generation",
    tasks: ["text-to-image", "image-to-image"],
    hint: "Diffusion models. Lemonade runs these through Stable Diffusion, not llama.cpp.",
    runnable: false,
  },
  {
    id: "embedding",
    title: "Embeddings",
    tasks: ["feature-extraction", "sentence-similarity"],
    hint: "Turning text into vectors, which is how a library becomes searchable by meaning.",
    runnable: true,
  },
];

export function kindById(id: string): ModelKind {
  return KINDS.find((k) => k.id === id) ?? KINDS[0]!;
}

/** How results are ordered. `trendingScore` is the registry's own "hot now". */
export type BrowseSort = "downloads" | "likes" | "trendingScore" | "lastModified";

export const SORTS: { id: BrowseSort; label: string }[] = [
  { id: "downloads", label: "Most downloaded" },
  { id: "trendingScore", label: "Trending now" },
  { id: "likes", label: "Most liked" },
  { id: "lastModified", label: "Recently updated" },
];

export interface BrowseQuery {
  /** Free text, matched against repository names. */
  query?: string | undefined;
  /** A publisher, exactly — `ibm-granite`, `unsloth`. */
  author?: string | undefined;
  kind?: string | undefined;
  /** Only repositories llama.cpp could read. */
  ggufOnly?: boolean | undefined;
  sort?: BrowseSort | undefined;
  limit?: number | undefined;
}

/** How many a page holds. The API's own ceiling for this endpoint. */
export const PAGE = 100;

/**
 * The query string for `/api/models`.
 *
 * Built here rather than in the main process so it can be tested without a
 * socket: the difference between `author=` and `search=` is the difference
 * between a publisher's page and a guess, and it is worth pinning down.
 */
export function browseParams(q: BrowseQuery): URLSearchParams {
  const params = new URLSearchParams();
  const kind = kindById(q.kind ?? "all");

  if (q.author) params.set("author", q.author);
  if (q.query?.trim()) params.set("search", q.query.trim());
  /* One tag only: the API takes a single `pipeline_tag`, and passing two
     returns nothing rather than the union. Where a kind names several, the
     first is the one asked for and the rest are kept for labelling. */
  if (kind.tasks[0]) params.set("pipeline_tag", kind.tasks[0]);
  if (q.ggufOnly) params.set("filter", "gguf");

  params.set("sort", q.sort ?? "downloads");
  params.set("direction", "-1");
  params.set("limit", String(q.limit ?? PAGE));
  /* Asked for explicitly, because the default response omits them and the
     download figure is the one number on the row a person can act on. */
  for (const field of ["downloads", "likes", "createdAt", "pipeline_tag", "tags", "gated"]) {
    params.append("expand[]", field);
  }
  return params;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Read the API's array into this app's shape, skipping anything malformed. */
export function parseModels(raw: unknown): HfModel[] {
  if (!Array.isArray(raw)) return [];
  const out: HfModel[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = str(r["id"]) ?? str(r["modelId"]);
    if (!id) continue;
    const tags = Array.isArray(r["tags"])
      ? r["tags"].filter((t): t is string => typeof t === "string")
      : [];
    out.push({
      id,
      owner: id.includes("/") ? id.slice(0, id.indexOf("/")) : id,
      tags,
      /* The `gguf` tag is how the registry marks it, and it is also what
         `filter=gguf` selects on -- so a row's badge and the filter agree by
         construction rather than by two separate guesses. */
      hasGguf: tags.includes("gguf"),
      // `gated` repositories need an accepted licence before they will download.
      gated: r["gated"] === true || typeof r["gated"] === "string",
      ...(num(r["downloads"]) !== undefined ? { downloads: num(r["downloads"]) } : {}),
      ...(num(r["likes"]) !== undefined ? { likes: num(r["likes"]) } : {}),
      ...(str(r["pipeline_tag"]) ? { task: str(r["pipeline_tag"]) } : {}),
      ...(str(r["createdAt"]) ? { createdAt: str(r["createdAt"]) } : {}),
    });
  }
  return out;
}

/**
 * What Karen can do with a repository, said plainly on the row.
 *
 * Three states rather than two, because "cannot run" covers two very different
 * situations and only one of them is the user's problem to solve.
 */
export type Loadable = "ready" | "wrong-format" | "other-runtime";

export function loadable(model: HfModel, kind: ModelKind): Loadable {
  if (!model.hasGguf) return "wrong-format";
  if (!kind.runnable) return "other-runtime";
  return "ready";
}

export const LOADABLE_WORDS: Record<Loadable, { short: string; tone: string; why: string }> = {
  ready: {
    short: "Ready",
    tone: "good",
    why: "GGUF, which is what Karen's llama.cpp engine reads.",
  },
  "wrong-format": {
    short: "Not GGUF",
    tone: "dim",
    why:
      "This repository holds the original weights rather than a quantised GGUF build. " +
      "Karen cannot load it; look for a GGUF version of the same model, often published by " +
      "unsloth or bartowski.",
  },
  "other-runtime": {
    short: "Other engine",
    tone: "warn",
    why:
      "Lemonade reports every repository containing .gguf files as a llama.cpp model, " +
      "including diffusion and speech models it cannot actually run that way. " +
      "Downloading this may produce a model that will not load.",
  },
};

/** `12.8M`, `334k`, `47`. */
export function compact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(1);
    return `${m.endsWith(".0") ? m.slice(0, -2) : m}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * The download count with the window it was measured over.
 *
 * The registry's `downloads` is a rolling 30-day figure, not a lifetime one:
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` reports 12,760,676 against
 * 18,171,482 all-time. Printed bare it reads as "thirteen million people use
 * this", which is not what it says.
 */
export function describeDownloads(n: number | undefined): string {
  return n === undefined ? "Not reported" : `${compact(n)} in the last 30 days`;
}

/** "4 days ago", for judging whether something is current. */
export function age(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.floor(days / 365)} years ago`;
}


/**
 * Publishers worth a shortcut, by their actual registry handle.
 *
 * The handle, not a family name: `author=ibm-granite` returns that
 * organisation's catalogue, where `search=granite` returns whatever has the
 * word in its title -- including `AnkitAI/Parable-Granite-…` -- and misses
 * anything named differently. Being able to ask this question at all is most
 * of the reason this module talks to the registry itself.
 *
 * Two groups, because they publish different things and conflating them is
 * how a browse ends up empty. **Model makers** release the original weights;
 * several of them publish no GGUF at all. **GGUF builders** are the community
 * organisations that quantise those weights, and they are where a llama.cpp
 * user actually gets a model -- measured: `meta-llama` has 0 GGUF
 * repositories, `unsloth` has more than 100.
 */
export interface Publisher {
  label: string;
  /** The registry handle, used verbatim as `author=`. */
  author: string;
  builder?: boolean;
  /** Said when a filtered browse of this publisher comes back empty. */
  note?: string;
}

const NO_GGUF = (who: string): string =>
  `${who} publishes the original weights rather than GGUF builds. ` +
  "Turn off “Only models Karen can run” to see them, or look under unsloth, " +
  "bartowski or ggml-org for GGUF versions of the same models.";

export const PUBLISHERS: Publisher[] = [
  { label: "Alibaba (Qwen)", author: "Qwen" },
  { label: "Google (Gemma)", author: "google" },
  { label: "Meta (Llama)", author: "meta-llama", note: NO_GGUF("Meta") },
  { label: "Mistral", author: "mistralai" },
  { label: "Microsoft (Phi)", author: "microsoft" },
  { label: "IBM (Granite)", author: "ibm-granite" },
  { label: "OpenAI (gpt-oss)", author: "openai", note: NO_GGUF("OpenAI") },
  { label: "Arcee", author: "arcee-ai" },
  { label: "Poolside", author: "poolside" },
  { label: "Z.ai (GLM)", author: "zai-org" },
  { label: "Unsloth", author: "unsloth", builder: true },
  { label: "Bartowski", author: "bartowski", builder: true },
  { label: "LM Studio", author: "lmstudio-community", builder: true },
  { label: "ggml.org", author: "ggml-org", builder: true },
];

/** The note for a publisher, when one applies. */
export function publisherNote(author: string | undefined): string | undefined {
  return author ? PUBLISHERS.find((p) => p.author === author)?.note : undefined;
}
