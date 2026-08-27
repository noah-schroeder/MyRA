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
export interface LemonadeHealth {
  modelLoaded?: string | undefined;
  loaded: string[];
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
  const all = obj["all_models_loaded"];
  const one = obj["model_loaded"];
  return {
    loaded: Array.isArray(all) ? all.filter((m): m is string => typeof m === "string") : [],
    ...(typeof one === "string" && one ? { modelLoaded: one } : {}),
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
export function pinnedConfig(): Record<string, unknown> {
  return {
    broadcast: false,
    auto_check_model_updates: false,
    auto_update_models: false,
    telemetry: { enabled: false },
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
