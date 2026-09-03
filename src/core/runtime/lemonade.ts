/**
 * Lemonade: the inference backend Karen runs instead of managing its own.
 *
 * Karen used to acquire llama.cpp itself -- release assets, an OCI registry for
 * the CUDA build upstream does not publish, a bundled C runtime, a loader
 * sandwich. Five builds went into making one RTX 4060 work. Lemonade already
 * solves that whole problem: it ships per-architecture CUDA builds as ordinary
 * tarballs, targets an older glibc, and covers ROCm, Vulkan, NPU, Metal and CPU
 * besides -- plus speech, embeddings and image models behind the same
 * OpenAI-compatible API.
 *
 * `lemond` is a single native binary. It is not a model process: it starts once
 * and stays up, and models are loaded and unloaded through its API. That is the
 * essential difference from the llama-server it replaces, and it is why the
 * supervisor here has no notion of a model.
 *
 * Two facts about running it were measured rather than assumed, and both are
 * load-bearing:
 *
 *   - **It finds `resources/` relative to `/proc/self/exe`.** Confirmed by
 *     keeping the real binary and faking `argv[0]`: it still started, so the
 *     lookup is not argv-based. Under a bundled loader `/proc/self/exe` IS the
 *     loader, so the loader must sit beside `lemond` -- exactly the placement
 *     ggml needed for its backends. See core/runtime/libc.ts.
 *   - **It broadcasts over UDP to advertise itself.** On by default. Karen
 *     passes `--no-broadcast`, which is a privacy requirement rather than a
 *     preference: a local assistant has no business announcing itself to the
 *     network.
 */

/**
 * The version Karen ships.
 *
 * Pinned deliberately. Lemonade moves fast and its API surface is broad; an
 * upgrade should be a decision with a test run behind it, not something that
 * arrives because a URL said "latest".
 */
export const LEMONADE_VERSION = "11.8.0";

export const LEMONADE_REPO = "lemonade-sdk/lemonade";

/** The daemon's filename, which is all that differs across platforms. */
export function lemondName(platform: string = process.platform): string {
  return platform === "win32" ? "lemond.exe" : "lemond";
}

/**
 * The embeddable build for a platform, or undefined where none is published.
 *
 * Upstream publishes ubuntu-x64, ubuntu-arm64, windows-x64 and macos-arm64.
 * There is no macOS x64 build and no Windows arm64 build, and saying so here
 * is better than composing a URL that 404s at install time.
 */
export function embeddableAsset(
  platform: string = process.platform,
  arch: string = process.arch,
  version: string = LEMONADE_VERSION,
): string | undefined {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!cpu) return undefined;
  const stem = `lemonade-embeddable-${version}`;
  if (platform === "linux") return `${stem}-ubuntu-${cpu}.tar.gz`;
  if (platform === "darwin") return cpu === "arm64" ? `${stem}-macos-arm64.tar.gz` : undefined;
  if (platform === "win32") return cpu === "x64" ? `${stem}-windows-x64.zip` : undefined;
  return undefined;
}

export function embeddableUrl(asset: string, version: string = LEMONADE_VERSION): string {
  return `https://github.com/${LEMONADE_REPO}/releases/download/v${version}/${asset}`;
}

export interface LemondArgs {
  port: number;
  /** Where downloaded models and backend binaries go. */
  cacheDir: string;
  /** Where lemond keeps its own JSON state. */
  configDir: string;
}

/**
 * How Karen starts the daemon.
 *
 * `cache_dir` and `config_dir` are positional, which is what makes the whole
 * thing relocatable: nothing lands in `~/.cache/lemonade` or `~/.config/lemonade`
 * behind the user's back, and a Karen uninstall can take its own directories
 * with it.
 *
 * The host is pinned to loopback here rather than left to configuration. A
 * model server reachable from the network is a different product with a
 * different threat model, and this one is not it.
 */
export function lemondArgs(opts: LemondArgs): string[] {
  return [
    "--host", "127.0.0.1",
    "--port", String(opts.port),
    // See the header: on by default, and never wanted here.
    "--no-broadcast",
    opts.cacheDir,
    opts.configDir,
  ];
}

/**
 * Lemonade serves the same routes under two prefixes.
 *
 * `/api/v1` is what the running daemon answers on and what its own tooling
 * uses; `/v1` is the OpenAI-compatible alias, and is what Karen's chat and
 * transcription clients should be pointed at because that is the shape they
 * already speak. Both were measured returning 200.
 */
export function apiBase(port: number): string {
  return `http://127.0.0.1:${port}/api/v1`;
}

export function openAiBase(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/** What `/api/v1/health` answers with once the daemon is serving. */
/**
 * What the daemon reports about the model it is holding.
 *
 * The context size is the part worth having: llama.cpp is launched with
 * `--ctx-size 4096` whatever the model's own ceiling is -- measured, a model
 * whose `max_context_window` is 131,072 still gets 4,096 -- so "how much room
 * do I have" has an answer that is neither the model's spec sheet nor
 * guessable. Showing both numbers is what makes that visible.
 */
export interface LoadedModel {
  id: string;
  /**
   * Tokens this conversation actually has, and nothing softer than that.
   *
   * Two numbers claim to be this and only one of them is true. Lemonade's
   * `recipe_options.ctx_size` is what it *asked* for; llama-server's own
   * `/props` reports what it *got*, per slot, after llama.cpp has clamped to
   * the model's trained length and divided by `--parallel`. They agree today
   * because Lemonade launches with `--parallel 1`, and they would silently
   * stop agreeing the moment it did not.
   *
   * So this field holds the server's answer when it can be had, and
   * `contextFrom` says which it is. It also feeds compaction, which makes an
   * over-estimate here worse than no estimate: it would summarise too late and
   * overflow the window anyway.
   */
  contextTokens?: number | undefined;
  /** Whether the figure was measured from llama-server or taken from Lemonade. */
  contextFrom?: "server" | "daemon" | undefined;
  /** The model's own ceiling, which is usually much larger. */
  maxContextTokens?: number | undefined;
  /** `gpu` or `cpu`, which answers "did the card get used". */
  device?: string | undefined;
  recipe?: string | undefined;
  /**
   * What the daemon says this model is for: `llm`, `transcription`, `tts`.
   *
   * Its own classification, and the reliable one -- see `isChatModel`.
   */
  type?: string | undefined;
  /** The llama-server behind this model, which can be asked what it really did. */
  backendUrl?: string | undefined;
  ready: boolean;
}

export interface LemonadeHealth {
  modelLoaded?: string | undefined;
  loaded: string[];
  /** Detail for `modelLoaded`, when the daemon reports it. */
  active?: LoadedModel | undefined;
  /**
   * Every model the daemon is holding, with the engine behind each.
   *
   * Kept in full because `model_loaded` cannot be read as "the model chat uses"
   * and was: Lemonade holds several models at once, each on its own backend
   * port, and that field names whichever was touched LAST. Measured -- load a
   * chat model, transcribe one clip, and `model_loaded` is `Whisper-Tiny`,
   * while the chat model is still resident and still answering on 8002. Karen
   * routed chat by that name, so a single dictation would have pointed the
   * conversation at a speech-to-text model.
   */
  models: LoadedModel[];
}

/**
 * The engines that are not chat engines.
 *
 * By recipe rather than by model name, because the recipe is what the daemon
 * launched and cannot be renamed out of correctness -- `whisper-tts` would
 * defeat a name test, and the catalogue is free to add such a thing.
 */
const NON_CHAT_RECIPES = new Set(["whispercpp", "moonshine", "kokoro", "openmoss", "sd-cpp"]);

export function isChatEngine(recipe?: string | undefined): boolean {
  return !recipe || !NON_CHAT_RECIPES.has(recipe);
}

/**
 * The kinds of model a conversation can be held with.
 *
 * `type` is the daemon's own classification and beats the recipe list above,
 * because it needs no maintenance: measured on a daemon holding three models
 * at once, it reports `llm`, `transcription` and `tts`. A new speech engine
 * Karen has never heard of is therefore excluded on the day it ships, where
 * the recipe list would have admitted it until somebody noticed.
 */
const CHAT_TYPES = new Set(["llm", "text", "chat"]);

/**
 * Whether this loaded model could answer a message.
 *
 * The recipe is the fallback for a daemon that does not send `type`, and the
 * final fallback is "yes" -- an unknown engine is offered rather than hidden,
 * because a chat model wrongly withheld is a broken app while a speech model
 * wrongly offered is one failed request.
 */
export function isChatModel(model: { type?: string | undefined; recipe?: string | undefined }): boolean {
  if (model.type) return CHAT_TYPES.has(model.type);
  return isChatEngine(model.recipe);
}

/**
 * Which loaded model a conversation should go to.
 *
 * `preferred` is the model Karen last loaded on purpose. It wins when it is
 * still resident; otherwise the first loaded model that a chat request could
 * actually be answered by. Returning nothing is a real answer -- a daemon
 * holding only Kokoro has nothing to chat with, and saying so is better than
 * naming a voice model and letting the request fail at the far end.
 */
export function chatModelOf(
  health: LemonadeHealth | undefined,
  preferred?: string | undefined,
): LoadedModel | undefined {
  const models = health?.models ?? [];
  const chosen = preferred ? models.find((m) => m.id === preferred) : undefined;
  if (chosen && isChatModel(chosen)) return chosen;
  return models.find((m) => isChatModel(m));
}

/**
 * The model to put back, when something has taken it away.
 *
 * Pure, because every one of these conditions is a rule rather than an
 * operation and each of them was wrong once. Undefined means "leave it": a
 * conversation with no model chosen is not a fault, a stopped daemon should
 * stay stopped, and a record naming a speech model must never be reloaded into
 * the conversation's slot.
 */
export function chatModelToReload(opts: {
  useForChat: boolean;
  /** Whether the daemon is up. Starting one is a separate decision. */
  ready: boolean;
  /** What `chatModelOf` resolves right now; a value means nothing to do. */
  resolved: LoadedModel | undefined;
  activeModel?: string | undefined;
  /** The chosen model's engine, when the catalogue knows it. */
  recipe?: string | undefined;
}): string | undefined {
  if (!opts.useForChat || !opts.ready) return undefined;
  if (opts.resolved) return undefined;
  const wanted = opts.activeModel?.trim();
  if (!wanted) return undefined;
  if (opts.recipe && !isChatEngine(opts.recipe)) return undefined;
  return wanted;
}

/**
 * Read the health payload, tolerating a shape that is not ours to control.
 *
 * Deliberately forgiving: readiness is "it answered 200", and the fields here
 * are decoration. A parser that threw on an unexpected key would turn a
 * cosmetic upstream change into a daemon that never starts.
 */
export function parseHealth(body: unknown): LemonadeHealth {
  const obj = (body ?? {}) as Record<string, unknown>;
  /* `all_models_loaded` holds objects, not strings -- it did not always, and
     reading it as strings left the list silently empty. Both shapes are
     accepted rather than swapping one assumption for another. */
  const rows = Array.isArray(obj["all_models_loaded"]) ? obj["all_models_loaded"] : [];
  const models: LoadedModel[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row) {
      models.push({ id: row, ready: true });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    const id = typeof m["model_name"] === "string" ? m["model_name"] : undefined;
    if (!id) continue;
    const options = (m["recipe_options"] ?? {}) as Record<string, unknown>;
    const int = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    models.push({
      id,
      ready: m["status"] === "ready" || m["loaded"] === true,
      ...(int(options["ctx_size"]) !== undefined ? { contextTokens: int(options["ctx_size"]) } : {}),
      ...(int(m["max_context_window"]) !== undefined
        ? { maxContextTokens: int(m["max_context_window"]) }
        : {}),
      ...(int(options["ctx_size"]) !== undefined ? { contextFrom: "daemon" as const } : {}),
      ...(typeof m["device"] === "string" ? { device: m["device"] } : {}),
      ...(typeof m["recipe"] === "string" ? { recipe: m["recipe"] } : {}),
      ...(typeof m["type"] === "string" ? { type: m["type"] } : {}),
      ...(typeof m["backend_url"] === "string" ? { backendUrl: m["backend_url"] } : {}),
    });
  }
  const one = obj["model_loaded"];
  const modelLoaded = typeof one === "string" && one ? one : undefined;
  const active = models.find((m) => m.id === modelLoaded) ?? (modelLoaded ? undefined : models[0]);
  return {
    loaded: models.map((m) => m.id),
    models,
    ...(modelLoaded ? { modelLoaded } : {}),
    ...(active ? { active } : {}),
  };
}

/**
 * The settings Karen pins in Lemonade's `config.json`, and why each one.
 *
 * Read off the daemon's own `resources/defaults.json` rather than from the
 * documentation, because two of these defaults are not what a private assistant
 * wants and neither is mentioned prominently:
 *
 *   - `broadcast` defaults to **true**: the daemon advertises itself over UDP
 *     so other machines can find it. Also passed as `--no-broadcast` on the
 *     command line; set here as well so it holds even if the flag is ever lost.
 *   - `auto_check_model_updates` defaults to **true**: it contacts Hugging Face
 *     in the background to see whether models have new revisions. That is a
 *     network call the user did not ask for and cannot see, which is exactly
 *     what Karen promises not to do. Checking for updates is fine when someone
 *     presses a button; it is not fine on a timer.
 *
 * `telemetry.enabled` is already false by default, and its OTLP endpoint points
 * at localhost. It is pinned anyway: a guarantee that rests on someone else's
 * default is not a guarantee, and this file is the cheapest place to hold it.
 */
export function pinnedConfig(modelsDir?: string): Record<string, unknown> {
  return {
    broadcast: false,
    auto_check_model_updates: false,
    auto_update_models: false,
    telemetry: { enabled: false },
    /*
     * Where Karen's existing models already are.
     *
     * This is the whole of the migration. Lemonade scans this directory and
     * lists what it finds as downloaded models, so a library built up under the
     * old runtime is simply there -- no per-model registration, and nothing
     * re-downloaded. Measured against a real models directory: both GGUF files
     * in it appeared, both marked as already present.
     */
    ...(modelsDir ? { extra_models_dir: modelsDir } : {}),
    /*
     * Let the image engine use the card it can actually get.
     *
     * Without this, stable-diffusion.cpp asks for the whole diffusion model as
     * one contiguous VRAM allocation and aborts when it cannot have it:
     *
     *     allocating 1411.07 MiB on device 0: cudaMalloc failed: out of memory
     *
     * on an 8 GB card that was busy holding a chat model, a Whisper and a
     * Kokoro -- reported, and reproduced by running the engine by hand,
     * because the daemon discards its engine's stderr. Lemonade will not free
     * the card for it: `max_loaded_models` is 1 but applies per TYPE, so it
     * holds one of each kind and never evicts across pools.
     *
     * `--auto-fit` is the engine's own answer, and it is the right one --
     * "pick the diffusion/te/vae device placements automatically from the
     * model size and the per-device memory budgets ... defaults to free memory
     * minus a small margin". A full card means some of the model runs from
     * RAM, slowly, instead of the generation failing. Measured on a card with
     * room: 33.6 s with the flag against 33.1 s without, which is noise.
     *
     * Merged rather than replacing the block, so Lemonade's own per-backend
     * arguments -- the Vulkan build gets `--vae-tiling --diffusion-fa` -- are
     * still added alongside it.
     */
    sdcpp: { args: "--auto-fit" },
  };
}

/**
 * Karen's settings win; anything else the daemon or the user put there stays.
 *
 * A shallow merge would drop the rest of the `telemetry` block, so the one
 * nested object is merged a level deeper. Everything Karen pins is either a
 * scalar or that block, so this is as deep as it needs to go -- and a general
 * deep merge would be more machinery than the problem has.
 */
export function mergeConfig(
  existing: Record<string, unknown>,
  pinned: Record<string, unknown> = pinnedConfig(),
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing, ...pinned };
  for (const [key, value] of Object.entries(pinned)) {
    const prior = existing[key];
    if (value && typeof value === "object" && !Array.isArray(value)
        && prior && typeof prior === "object" && !Array.isArray(prior)) {
      out[key] = { ...(prior as object), ...(value as object) };
    }
  }
  return out;
}

/** Lemonade keeps its persistent settings here, inside the config directory. */
export const CONFIG_FILE = "config.json";

/**
 * The context a conversation really gets, read from llama-server itself.
 *
 * `default_generation_settings.n_ctx` is the per-slot figure -- what one
 * conversation can hold -- while the top-level `n_ctx` is the total across
 * slots. With one slot they are equal; with more they are not, and the
 * per-slot number is the one a token meter must count against.
 *
 * Unauthenticated on purpose: this is the backend llama-server that Lemonade
 * started on loopback, and it is launched without a key. Failure is silent and
 * the caller keeps the daemon's own figure.
 */
export function parseProps(body: unknown): number | undefined {
  const obj = (body ?? {}) as Record<string, unknown>;
  const perSlot = (obj["default_generation_settings"] ?? {}) as Record<string, unknown>;
  for (const value of [perSlot["n_ctx"], obj["n_ctx"]]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** `http://127.0.0.1:8002/v1` → `http://127.0.0.1:8002/props`. */
export function propsUrl(backendUrl: string): string | undefined {
  try {
    return new URL("/props", backendUrl).toString();
  } catch {
    return undefined;
  }
}
