/**
 * Browsing Hugging Face the way LM Studio does, rather than the way a
 * subprocess happens to.
 *
 * MyRA's registry search went through Lemonade, which offers exactly one
 * knob: `search=<text>`, capped at 50, matched against repository names. That
 * is not a search experience, and three measurements say why.
 *
 *   - **"granite" returned 42 repositories of which 5 were usable.** Not
 *     because of any filtering MyRA added: only 5 of them contain GGUF files
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
 * Hugging Face's own API answers all three, and MyRA already sends every
 * search to that host -- `lemond` makes the call today. Talking to it directly
 * changes which process opens the socket, not which company receives the
 * query, and it buys `author`, `pipeline_tag`, `filter`, `sort` and a hundred
 * results a page.
 *
 * **Nothing here is curated.** An earlier version of the shelves dropped
 * safety-stripped merges, capped how many repositories one owner could
 * occupy, and cut the list at 24. That was the wrong instinct: a person
 * looking for a model wants the registry's answer, not MyRA's opinion of it.
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
  /** ISO date it was last touched, needed to merge several `lastModified` pages. */
  lastModified?: string | undefined;
  gated: boolean;
}

/**
 * The kinds of model worth offering as a tab.
 *
 * Keyed by Hugging Face's `pipeline_tag`, because that is the only filter the
 * API accepts -- a tab that filtered client-side would show "12 results" over
 * a page that fetched 100 and would page inconsistently.
 *
 * Each kind names the Lemonade engine that runs it. That mapping used to be
 * missing, which is why image and speech models were shown as unloadable:
 * Lemonade's own `/pull/variants` reports `recipe: llamacpp` for ANY
 * repository containing `.gguf` files -- measured, on
 * `Kijai/WanVideo_comfy_GGUF` and `SporkySporkness/FLUX.1-Canny-dev-GGUF` --
 * so trusting it installed a diffusion model as a language model. Naming the
 * recipe from the model's PURPOSE instead makes all of these work: a pull
 * declaring `sd-cpp` fetches `stabilityai/sd-turbo:sd_turbo.safetensors`
 * happily, and one declaring `whispercpp` fetches `ggml-tiny.bin`.
 *
 * What is still required is that the engine be installed, which is a separate
 * question from whether the download is possible -- see `loadable`.
 */
export interface ModelKind {
  id: string;
  title: string;
  /** The `pipeline_tag` values this tab asks for; empty means no filter. */
  tasks: string[];
  hint: string;
  /** Whether MyRA can load this kind once downloaded. */
  runnable: boolean;
  /**
   * Whether the registry can usefully be searched for it. Absent means yes.
   *
   * Separate from `runnable`: MyRA runs diffusion models perfectly well, it
   * just cannot assemble one out of a repository listing.
   */
  browsable?: boolean | undefined;
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
    hint: "Audio into text — what Meetings uses. Whisper builds are ggml rather than GGUF, which is why they need their own engine.",
    runnable: true,
  },
  {
    id: "voice",
    title: "Speech synthesis",
    tasks: ["text-to-speech"],
    hint: "Reading text aloud. Lemonade runs these through Kokoro rather than llama.cpp.",
    runnable: true,
  },
  {
    id: "image",
    title: "Image generation",
    tasks: ["text-to-image", "image-to-image"],
    hint: "Diffusion models. Lemonade runs these through Stable Diffusion rather than llama.cpp.",
    runnable: true,
    /*
     * Not a tab, because searching for one here cannot work.
     *
     * A modern diffusion model is three files -- the diffusion model, a text
     * encoder and a VAE -- and nothing on the registry says which three go
     * together: FLUX.2-klein-9B's encoder is a Qwen3-8B in an unrelated
     * repository. Measured on the twenty most-downloaded `text-to-image`
     * repositories, essentially none offer a single file that loads on its
     * own: most are diffusers-format directories, and one holds 1,416 LoRAs
     * that would have been listed as though each were a model. Every one of
     * those downloads ends in `sd-server` exiting 1 in about 40 ms, which
     * reaches the user as "failed to start or become ready".
     *
     * That mapping exists only in Lemonade's own catalogue, which is where
     * this kind is served from instead -- see the Recommended list, and
     * `myra:register-image-model` for adding one it does not carry.
     */
    browsable: false,
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

/**
 * The kinds offered as tabs, which is every kind but the curated ones.
 *
 * A filter rather than a shorter `KINDS`, because `kindById` and `recipeFor`
 * still have to resolve the kind an image model IS -- it is only the browsing
 * of it that cannot work.
 */
export function browsableKinds(): ModelKind[] {
  return KINDS.filter((k) => k.browsable !== false);
}

/** How results are ordered. `trendingScore` is the registry's own "hot now". */
export type BrowseSort =
  | "downloads" | "likes" | "trendingScore" | "lastModified" | "createdAt";

export const SORTS: { id: BrowseSort; label: string }[] = [
  { id: "downloads", label: "Most downloaded" },
  { id: "trendingScore", label: "Trending now" },
  { id: "likes", label: "Most liked" },
  /* Two different dates, and the difference matters when looking for something
     new: `createdAt` is when the repository first appeared, `lastModified` is
     when a file in it last changed -- a three-year-old model whose README was
     edited yesterday sorts to the top of one and not the other. */
  { id: "createdAt", label: "Recently uploaded" },
  { id: "lastModified", label: "Recently updated" },
];

/**
 * Which Lemonade recipe loads a given kind of model.
 *
 * This mapping is the fix for a whole class of broken download. Lemonade's
 * `/pull/variants` reports `recipe: llamacpp` for ANY repository containing
 * `.gguf` files, diffusion and audio models included -- so a FLUX or Wan Video
 * repository came back labelled as a language model, and a pull that trusted
 * that label produced a file llama.cpp could never load.
 *
 * `/pull` does honour an explicit recipe: measured, a pull naming `sd-cpp`
 * fetches `stabilityai/sd-turbo:sd_turbo.safetensors` happily, and a pull
 * naming a recipe that does not exist is refused with `Recipe 'x' not found`.
 * So MyRA decides the recipe from what the registry says the model is FOR,
 * rather than from what file extensions happen to be in the repository.
 */
export const KIND_RECIPE: Record<string, string> = {
  chat: "llamacpp",
  vision: "llamacpp",
  embedding: "llamacpp",
  speech: "whispercpp",
  voice: "kokoro",
  image: "sd-cpp",
};

export interface BrowseQuery {
  /** Free text, matched against repository names. */
  query?: string | undefined;
  /**
   * Publishers, exactly — `ibm-granite`, `unsloth`.
   *
   * A list, because the registry's API takes only one: `author=a&author=b`
   * and `author=a,b` both return zero results, measured. Several publishers
   * therefore mean several requests, merged and re-sorted here -- which is why
   * `browseParams` still builds the query for exactly one.
   */
  authors?: string[] | undefined;
  /** One publisher, which is what a single request can carry. */
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
  /*
   * The GGUF filter is a llama.cpp filter, and applying it elsewhere hides the
   * models that work.
   *
   * `filter=gguf` selects repositories tagged `gguf`. That is exactly right
   * for chat, vision and embeddings, which llama.cpp loads. It is wrong for
   * every other kind: sd-cpp reads `.safetensors`, whisper.cpp reads ggml
   * `.bin`, kokoro reads `.onnx` -- so a "only what MyRA can run" switch that
   * meant `gguf` would exclude `stabilityai/sd-turbo`, which MyRA can run
   * perfectly well. On those tabs the switch has nothing to filter on and is
   * left off.
   */
  if (q.ggufOnly && ggufIsMeaningful(kind)) params.set("filter", "gguf");

  params.set("sort", q.sort ?? "downloads");
  params.set("direction", "-1");
  params.set("limit", String(q.limit ?? PAGE));
  /* Asked for explicitly, because the default response omits them and the
     download figure is the one number on the row a person can act on. */
  for (const field of [
    "downloads", "likes", "createdAt", "lastModified", "pipeline_tag", "tags", "gated",
  ]) {
    params.append("expand[]", field);
  }
  return params;
}

/**
 * Whether "GGUF only" says anything on this tab.
 *
 * True for the llama.cpp kinds, and for "Everything" -- where the filter is
 * the one blunt way to ask for things that will load, since a mixed list has
 * no single engine to reason about.
 */
export function ggufIsMeaningful(kind: ModelKind): boolean {
  return kind.id === "all" || KIND_RECIPE[kind.id] === "llamacpp";
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
      ...(str(r["lastModified"]) ? { lastModified: str(r["lastModified"]) } : {}),
    });
  }
  return out;
}

/**
 * What MyRA can do with a repository, said plainly on the row.
 *
 * Four states, and the two middle ones are the useful ones. A model whose
 * engine is missing is not unloadable -- the engine is one click away under
 * Settings → Runtime, and saying "cannot run" about that is the kind of
 * inaccuracy that makes people give up on a feature that works. A diffusion
 * model is the opposite case and needs its own word: the engine may be
 * installed and the row still cannot be downloaded from here, because the
 * repository is one part of a model whose other parts nothing here names.
 */
export type Loadable = "ready" | "needs-engine" | "wrong-format" | "curated-only";

export function loadable(
  model: HfModel,
  recipe: string,
  /** Which engines have a backend installed. Absent means "not known yet". */
  engines?: ReadonlySet<string>,
): Loadable {
  /* Before anything else: a diffusion model is not one file, and which three
     files it needs is not written down anywhere on the registry. The
     "Everything" tab still returns these -- they are real models and hiding
     them would be its own lie -- so the row says where they do come from
     rather than offering a download that cannot load. See `browsable`. */
  if (recipe === "sd-cpp" || recipe === "thenoise") return "curated-only";
  /* Format first: llama.cpp reads GGUF and the original weights beside it are
     not a build it can load, whatever engine is present. The other engines
     read their own formats, so this test only applies to llamacpp. */
  if (recipe === "llamacpp" && !model.hasGguf) return "wrong-format";
  if (engines && !engines.has(recipe)) return "needs-engine";
  return "ready";
}

export const LOADABLE_WORDS: Record<Loadable, { short: string; tone: string; why: string }> = {
  ready: {
    short: "Ready",
    tone: "good",
    why: "The engine this needs is installed, so it will load once downloaded.",
  },
  "needs-engine": {
    short: "Needs engine",
    tone: "warn",
    why:
      "MyRA can download this, but the engine that runs it is not installed yet. " +
      "Install it under Settings → Runtime and it will load.",
  },
  "curated-only": {
    short: "Curated list",
    tone: "dim",
    why:
      "Image models are picked from the Recommended list rather than searched for. A " +
      "diffusion model needs a text encoder and a VAE alongside it, usually from other " +
      "repositories, and nothing here says which — so this repository on its own would " +
      "download several gigabytes that cannot load.",
  },
  "wrong-format": {
    short: "Not GGUF",
    tone: "dim",
    why:
      "This repository holds the original weights rather than a quantised GGUF build. " +
      "llama.cpp cannot load it; look for a GGUF version of the same model, often published " +
      "by unsloth or bartowski.",
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
  /**
   * What to search for when this publisher is being crossed with another.
   *
   * "IBM (Granite) and Unsloth" can only mean one thing -- Unsloth's builds of
   * Granite -- and the registry expresses it as `author=unsloth&search=granite`
   * rather than as two authors. So a maker needs a word as well as a handle,
   * and the word is the family name rather than the handle: `search=ibm-granite`
   * matches almost nothing, because Unsloth does not put IBM's handle in its
   * repository names.
   */
  term?: string;
  /** Said when a filtered browse of this publisher comes back empty. */
  note?: string;
}

const NO_GGUF = (who: string): string =>
  `${who} publishes the original weights rather than GGUF builds. ` +
  "Turn off “Only models MyRA can run” to see them, or look under unsloth, " +
  "bartowski or ggml-org for GGUF versions of the same models.";

export const PUBLISHERS: Publisher[] = [
  { label: "Alibaba (Qwen)", author: "Qwen", term: "qwen" },
  { label: "Google (Gemma)", author: "google", term: "gemma" },
  { label: "Meta (Llama)", author: "meta-llama", term: "llama", note: NO_GGUF("Meta") },
  { label: "Mistral", author: "mistralai", term: "mistral" },
  { label: "Microsoft (Phi)", author: "microsoft", term: "phi" },
  { label: "IBM (Granite)", author: "ibm-granite", term: "granite" },
  { label: "OpenAI (gpt-oss)", author: "openai", term: "gpt-oss", note: NO_GGUF("OpenAI") },
  { label: "Arcee", author: "arcee-ai", term: "arcee" },
  { label: "Poolside", author: "poolside", term: "poolside" },
  { label: "Z.ai (GLM)", author: "zai-org", term: "glm" },
  { label: "Unsloth", author: "unsloth", builder: true },
  { label: "Bartowski", author: "bartowski", builder: true },
  { label: "LM Studio", author: "lmstudio-community", builder: true },
  { label: "ggml.org", author: "ggml-org", builder: true },
];

/** The note for a publisher, when one applies. */
export function publisherNote(author: string | undefined): string | undefined {
  return author ? PUBLISHERS.find((p) => p.author === author)?.note : undefined;
}

/* ------------------------------------------------------------- pulling -- */


/**
 * The recipe for a repository, from the kind being browsed and the model's own
 * task.
 *
 * The model's task wins when it has one, because a browse of "Everything" has
 * no kind to go on and a repository's `pipeline_tag` is the registry's own
 * statement of purpose. `llamacpp` is the fallback: it is what the vast
 * majority of GGUF repositories are, and it is what Lemonade would have
 * guessed anyway.
 */
export function recipeFor(model: HfModel, kind: ModelKind): string {
  const byTask = TASK_RECIPE[model.task ?? ""];
  if (byTask) return byTask;
  return KIND_RECIPE[kind.id] ?? "llamacpp";
}

const TASK_RECIPE: Record<string, string> = {
  "text-generation": "llamacpp",
  "image-text-to-text": "llamacpp",
  "feature-extraction": "llamacpp",
  "sentence-similarity": "llamacpp",
  "automatic-speech-recognition": "whispercpp",
  "text-to-speech": "kokoro",
  "text-to-image": "sd-cpp",
  "image-to-image": "sd-cpp",
};

/**
 * The name a downloaded model is registered under.
 *
 * **The `user.` prefix is required, not decorative.** Lemonade refuses any
 * pull that supplies its own checkpoint unless the name is in the `user.`
 * namespace: `Registered model definitions must use a non-empty 'user.*'
 * name`. MyRA was sending `Qwen3-0.6B-GGUF-Q4_K_M` and getting a 400 every
 * time, which means the Download button on the search page had never once
 * worked. The namespace is the daemon's way of keeping models a person added
 * apart from the ones its own catalogue defines, so this belongs on the name
 * rather than being worked around.
 */
export function pullName(repo: string, variant?: string): string {
  const leaf = repo.split("/").pop() ?? repo;
  const base = variant ? `${leaf}-${variant}` : leaf;
  /* The daemon accepts a `user.` name and little else about it, so anything
     that could confuse a path or a URL is flattened rather than trusted. */
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // Collapse runs, or "name!-Q4" becomes "name--Q4".
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `user.${safe || "model"}`;
}

/** The checkpoint string a pull wants: `org/repo:path/to/file`. */
export function pullCheckpoint(repo: string, file?: string): string {
  return file ? `${repo}:${file}` : repo;
}

/**
 * The id the daemon will LIST a pulled model under, which is not its name.
 *
 * A pull has to be named `user.<something>` -- see `pullName` -- and the daemon
 * then reports it with the namespace removed. Measured: registering
 * `user.myra-delete-probe` answers
 * `{"canonical_model_name":"user.myra-delete-probe","model":{"id":"myra-delete-probe",…}}`,
 * and `embeddinggemma-300M-GGUF-Q8_0` sits in `/models` today under exactly
 * that shape.
 *
 * This existed as a bug before it existed as a function. The search page tested
 * "have I got this already" against `modelNameFor`, which produces the name
 * without the prefix and without `pullName`'s flattening, so a repository whose
 * name contained anything unusual never matched -- and the Download button on a
 * model already downloaded said Download.
 */
export function pulledId(repo: string, variant?: string): string {
  return listedId(pullName(repo, variant));
}

/**
 * The same conversion, for a name a pull already carries.
 *
 * Main starts a download under `pullName`'s `user.` name and then has to find
 * the model the daemon made of it -- to know it has appeared, and to file the
 * facts learned about it under the key everything else uses, which is the id at
 * load time. Looking for the `user.` name found nothing either time: the wait
 * for the model to show up always ran its retries out, and a downloaded model's
 * shape was recorded under a key no reader of it ever asks for.
 */
export function listedId(name: string): string {
  return name.replace(/^user\./, "");
}

/**
 * A file inside a repository, as something a person could choose to download.
 *
 * Needed because `/pull/variants` only understands GGUF, ONNX RyzenAI and
 * Lemonade's own Omni collections -- asked about `stabilityai/sd-turbo` it
 * answers with a 500 and a list of what it does support. Every other kind of
 * model therefore has to have its files listed from the registry directly.
 */
export interface RepoFile {
  path: string;
  sizeBytes?: number | undefined;
}

/** Extensions worth offering, by recipe. Anything else is not a model file. */
const LOADABLE_EXT: Record<string, RegExp> = {
  llamacpp: /\.gguf$/i,
  "sd-cpp": /\.(safetensors|gguf|ckpt)$/i,
  whispercpp: /\.(bin|gguf)$/i,
  kokoro: /\.(onnx|pth|safetensors)$/i,
};

/**
 * The files in a repository a given recipe could actually load.
 *
 * Sharded parts are dropped rather than offered: llama.cpp and friends are
 * given the first shard and find the rest themselves, so listing
 * `…-00002-of-00003.gguf` as a choice offers a download that cannot work.
 */
export function loadableFiles(files: RepoFile[], recipe: string): RepoFile[] {
  const wanted = LOADABLE_EXT[recipe] ?? /\.(gguf|safetensors|bin|onnx)$/i;
  return files
    .filter((f) => wanted.test(f.path))
    .filter((f) => isFirstShard(f.path))
    .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
}

/**
 * Whether a path is a whole file or the first part of a split one.
 *
 * Read as a number rather than matched with a lookahead: `-0*(?!1\b)\d+-of-`
 * looks like it excludes part one and does not, because the `0*` backtracks
 * until the lookahead passes and `-00001-of-00002` matches after all. Parsing
 * the index cannot go wrong that way.
 */
function isFirstShard(path: string): boolean {
  const m = /-(\d+)-of-(\d+)\.[A-Za-z0-9]+$/.exec(path);
  return m === null || Number(m[1]) === 1;
}


/* ------------------------------------------------------------- merging -- */

/**
 * Merge several publishers' pages into one ordered list.
 *
 * Needed because the registry answers about one `author` at a time, so
 * "Unsloth and IBM together" is two requests. Re-sorting is not optional: each
 * page is ordered within itself, and concatenating them would put every
 * Unsloth model above every IBM one regardless of the figure being sorted on.
 */
export function mergeSorted(pages: HfModel[][], sort: BrowseSort): HfModel[] {
  const seen = new Map<string, HfModel>();
  for (const page of pages) {
    for (const model of page) if (!seen.has(model.id)) seen.set(model.id, model);
  }
  return [...seen.values()].sort((a, b) => sortKey(b, sort) - sortKey(a, sort));
}

function sortKey(m: HfModel, sort: BrowseSort): number {
  switch (sort) {
    case "likes":
      return m.likes ?? 0;
    case "lastModified":
      return Date.parse(m.lastModified ?? "") || 0;
    case "createdAt":
      return Date.parse(m.createdAt ?? "") || 0;
    case "trendingScore":
      /* The API does not return a trending score, only order by it. Across
         merged pages that order is lost, so downloads stands in -- the two
         agree closely enough for a list, and inventing a score would be worse
         than using a real number that is nearly right. */
      return m.downloads ?? 0;
    default:
      return m.downloads ?? 0;
  }
}


/* ----------------------------------------------------- one repository -- */

/**
 * Everything worth knowing about one repository, from the call that was
 * already being made.
 *
 * `GET /api/models/{repo}?blobs=true` was fetched only for `siblings`, and the
 * rest of the body thrown away. Measured on `unsloth/Qwen3-8B-GGUF`, that body
 * also carries the licence, the base model, and -- for GGUF repositories -- a
 * `gguf` block with the architecture and the trained context length. Those are
 * the three facts a person actually chooses on, and all three were being
 * discarded on the way past.
 *
 * The licence in particular is not a nicety. A researcher whose institution
 * restricts model use needs it before the download, not after.
 */
export interface RepoDetail {
  id: string;
  files: RepoFile[];
  /** As the publisher wrote it: `apache-2.0`, `llama3.1`, `other`. */
  license?: string | undefined;
  licenseLink?: string | undefined;
  /** The unquantised model a GGUF build was made from. */
  baseModel?: string | undefined;
  task?: string | undefined;
  tags: string[];
  downloads?: number | undefined;
  likes?: number | undefined;
  lastModified?: string | undefined;
  createdAt?: string | undefined;
  gated: boolean;
  /** `qwen3`, `llama`, … Present only where the registry read the GGUF header. */
  architecture?: string | undefined;
  /** The length the model was trained for, which is its ceiling. */
  contextTokens?: number | undefined;
}

export function parseRepoDetail(raw: unknown, fallbackId = ""): RepoDetail {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const number = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const card = (body["cardData"] && typeof body["cardData"] === "object"
    ? body["cardData"]
    : {}) as Record<string, unknown>;
  const gguf = (body["gguf"] && typeof body["gguf"] === "object"
    ? body["gguf"]
    : {}) as Record<string, unknown>;

  /* `base_model` is a string in most cards and a list in the ones built from
     several. The first entry is the one that answers "what is this a build
     of", and joining them would produce a value no link could use. */
  const base = Array.isArray(card["base_model"])
    ? text((card["base_model"] as unknown[])[0])
    : text(card["base_model"]);

  const files: RepoFile[] = [];
  for (const row of Array.isArray(body["siblings"]) ? body["siblings"] : []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const path = text(r["rfilename"]);
    if (!path) continue;
    const size = number(r["size"]);
    files.push({ path, ...(size !== undefined ? { sizeBytes: size } : {}) });
  }

  return {
    id: text(body["id"]) ?? text(body["modelId"]) ?? fallbackId,
    files,
    ...(text(card["license"]) ? { license: text(card["license"]) } : {}),
    ...(text(card["license_link"]) ? { licenseLink: text(card["license_link"]) } : {}),
    ...(base ? { baseModel: base } : {}),
    ...(text(body["pipeline_tag"]) ? { task: text(body["pipeline_tag"]) } : {}),
    tags: Array.isArray(body["tags"])
      ? (body["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    ...(number(body["downloads"]) !== undefined ? { downloads: number(body["downloads"]) } : {}),
    ...(number(body["likes"]) !== undefined ? { likes: number(body["likes"]) } : {}),
    ...(text(body["lastModified"]) ? { lastModified: text(body["lastModified"]) } : {}),
    ...(text(body["createdAt"]) ? { createdAt: text(body["createdAt"]) } : {}),
    gated: body["gated"] !== false && body["gated"] !== undefined,
    ...(text(gguf["architecture"]) ? { architecture: text(gguf["architecture"]) } : {}),
    ...(number(gguf["context_length"]) !== undefined
      ? { contextTokens: number(gguf["context_length"]) }
      : {}),
  };
}


/* ------------------------------------------------- what to actually ask -- */

/**
 * The publishers chosen, split into the two things they mean.
 *
 * A maker and a builder are not two values of one filter. "IBM (Granite)" names
 * who wrote the model; "Unsloth" names who converted it. Choosing both can only
 * mean one thing -- Unsloth's builds of Granite -- and the union the old code
 * produced (everything IBM publishes, plus everything Unsloth publishes) is not
 * a reading anybody wanted.
 */
export function splitPublishers(authors: readonly string[]): {
  makers: Publisher[];
  builders: Publisher[];
} {
  const chosen = authors
    .map((a) => PUBLISHERS.find((p) => p.author === a))
    .filter((p): p is Publisher => p !== undefined);
  return {
    makers: chosen.filter((p) => !p.builder),
    builders: chosen.filter((p) => p.builder),
  };
}

/**
 * How many requests one browse may make.
 *
 * Crossing makers with builders multiplies, and every request is a round trip
 * to a service that rate-limits. Four builders by ten makers is forty, which is
 * both slow and rude; this is generous for any selection a person makes on
 * purpose and the UI says when it has bitten.
 */
export const MAX_REQUESTS = 8;

export interface BrowsePlan {
  requests: BrowseQuery[];
  /** Pairs dropped by `MAX_REQUESTS`, so the screen can say so rather than lie. */
  dropped: number;
  /** Whether the selection is a crossing rather than a union. */
  crossed: boolean;
}

/**
 * Turn what the controls say into the requests that answer it.
 *
 * Three shapes, and the third is the one this exists for:
 *
 *   makers only     one request per maker, unioned      (as before)
 *   builders only   one request per builder, unioned    (as before)
 *   both            one request per pair, `author=<builder>&search=<maker>`
 *
 * The free-text box joins the search term rather than replacing it, so
 * "Granite + Unsloth" with "3.3" typed in narrows to Unsloth's Granite 3.3
 * builds instead of starting again.
 */
export function browsePlan(sel: {
  query?: string | undefined;
  authors?: readonly string[] | undefined;
  kind?: string | undefined;
  ggufOnly?: boolean | undefined;
  sort?: BrowseSort | undefined;
}): BrowsePlan {
  const base = {
    ...(sel.kind ? { kind: sel.kind } : {}),
    ...(sel.ggufOnly !== undefined ? { ggufOnly: sel.ggufOnly } : {}),
    ...(sel.sort ? { sort: sel.sort } : {}),
  };
  const text = sel.query?.trim() ?? "";
  const { makers, builders } = splitPublishers(sel.authors ?? []);

  const search = (...parts: (string | undefined)[]): { query?: string } => {
    const joined = parts.filter((p) => p && p.trim()).join(" ").trim();
    return joined ? { query: joined } : {};
  };

  let requests: BrowseQuery[];
  if (makers.length && builders.length) {
    requests = builders.flatMap((b) =>
      makers.map((mk) => ({ ...base, author: b.author, ...search(mk.term ?? mk.author, text) })),
    );
  } else {
    const only = makers.length ? makers : builders;
    requests = only.length
      ? only.map((p) => ({ ...base, author: p.author, ...search(text) }))
      : [{ ...base, ...search(text) }];
  }

  return {
    requests: requests.slice(0, MAX_REQUESTS),
    dropped: Math.max(0, requests.length - MAX_REQUESTS),
    crossed: makers.length > 0 && builders.length > 0,
  };
}

/* ----------------------------------- filters the registry cannot express -- */

/**
 * "Uploaded recently" and "downloaded a lot" as filters rather than as sorts.
 *
 * The registry sorts by both and filters by neither, so unlike every other
 * control on the page these are applied to the page that came back. That is a
 * real difference and the screen has to admit it: a filter on a hundred rows
 * chosen by download count cannot find a new model, however new it is, and
 * silently showing four results would look like the registry holds four.
 * `describeFiltered` writes that sentence.
 */
export interface LocalFilter {
  /** Uploaded within this many days, when set. */
  withinDays?: number | undefined;
  /** At least this many pulls in the last 30 days, when set. */
  minDownloads?: number | undefined;
}

export const UPLOADED_WITHIN: { id: string; label: string; days?: number }[] = [
  { id: "any", label: "Any time" },
  { id: "30", label: "Past month", days: 30 },
  { id: "90", label: "Past 3 months", days: 90 },
  { id: "180", label: "Past 6 months", days: 180 },
  { id: "365", label: "Past year", days: 365 },
];

export const MIN_DOWNLOADS: { id: string; label: string; n?: number }[] = [
  { id: "any", label: "Any" },
  { id: "1000", label: "1k+", n: 1_000 },
  { id: "10000", label: "10k+", n: 10_000 },
  { id: "100000", label: "100k+", n: 100_000 },
];

export interface Filtered {
  shown: HfModel[];
  /** Dropped for being too old or too little used. */
  hidden: number;
  /**
   * Dropped because the registry did not say when they were uploaded.
   *
   * Counted separately and said out loud. Treating "no date" as "too old" is a
   * guess, and quietly hiding a model because a field was missing is the kind
   * of thing that makes a list untrustworthy.
   */
  undated: number;
}

export function applyLocalFilter(
  models: readonly HfModel[],
  filter: LocalFilter,
  now = Date.now(),
): Filtered {
  if (filter.withinDays === undefined && filter.minDownloads === undefined) {
    return { shown: [...models], hidden: 0, undated: 0 };
  }
  const cutoff = filter.withinDays === undefined
    ? undefined
    : now - filter.withinDays * 24 * 60 * 60 * 1000;

  const shown: HfModel[] = [];
  let hidden = 0;
  let undated = 0;
  for (const model of models) {
    if (filter.minDownloads !== undefined && (model.downloads ?? 0) < filter.minDownloads) {
      hidden++;
      continue;
    }
    if (cutoff !== undefined) {
      const at = Date.parse(model.createdAt ?? "");
      if (!Number.isFinite(at)) {
        undated++;
        continue;
      }
      if (at < cutoff) {
        hidden++;
        continue;
      }
    }
    shown.push(model);
  }
  return { shown, hidden, undated };
}

/**
 * What the local filters did, in a sentence that does not overstate the page.
 *
 * The caveat is the point. Sorted by downloads, a "past month" filter is asking
 * a question of the hundred most-downloaded repositories, and the honest answer
 * names the sort that would actually search for new things.
 */
export function describeFiltered(
  result: Filtered,
  total: number,
  filter: LocalFilter,
  sort: BrowseSort,
): string | undefined {
  if (filter.withinDays === undefined && filter.minDownloads === undefined) return undefined;
  const parts: string[] = [
    `${result.shown.length} of the ${total} the registry returned match.`,
  ];
  if (result.undated) {
    parts.push(
      `${result.undated} more gave no upload date, so they are not shown.`,
    );
  }
  if (filter.withinDays !== undefined && sort !== "createdAt") {
    parts.push(
      "This filters the page that came back rather than the registry, so it is" +
      " searching within that sort. Choose “Recently uploaded” to look at new models instead.",
    );
  }
  return parts.join(" ");
}
