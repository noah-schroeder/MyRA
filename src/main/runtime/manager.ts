/**
 * The local inference backend: install it, run it, and remember what to load.
 *
 * This file used to be 835 lines, and almost all of it was llama.cpp
 * housekeeping -- fetching release assets, reading an OCI registry for the
 * CUDA build upstream does not publish there, probing devices, guessing a
 * backend from PCI vendor ids, scanning GGUF headers, composing launch flags.
 * All of that is now Lemonade's, which is the point: it maintains a build
 * matrix across CUDA, ROCm, Vulkan, NPU, Metal and CPU that Karen could not,
 * and it was already doing it correctly on hardware where Karen's own attempt
 * had failed five times over.
 *
 * What is left here is the part that is genuinely Karen's: which model to load
 * on launch, whether chat should use the local model at all, where models live,
 * and the guarantee that nothing Karen starts outlives it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE,
} from "../../core/paths.ts";
import { enabledOnly, parseCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { LEMONADE_VERSION } from "../../core/runtime/lemonade.ts";
import { LemonadeServer } from "./lemonade.ts";
import { LemonadeApi } from "./lemonadeApi.ts";
import { findLemonade, installLemonade } from "./lemonadeInstall.ts";
import { buildIndex, readIndexSources, type IndexResult } from "./foreignScan.ts";
import {
  defaultModelsDir, lemonadeCacheDir, lemonadeConfigDir, lemonadeDir, lemonadeIndexDir, stagingDir,
} from "./paths.ts";
import type { Progress } from "./download.ts";

const CONFIG_PATH = join(CONFIG_DIR, "runtime.json");

export interface RuntimeConfig {
  /** Where Karen's own model files live; Lemonade is pointed at this too. */
  modelsDir: string;
  /** Start the backend when the app opens. Off by default: an 8 GB process
   *  should not appear because someone opened a window. */
  startOnLaunch: boolean;
  /** The model to load, by the name Lemonade knows it as. */
  activeModel?: string;
  /**
   * Send chat and research to the model Karen is serving.
   *
   * Separate from the endpoint settings rather than overwriting them: someone
   * who configures their own endpoint and then tries the bundled runtime should
   * get their own back by switching this off, not by retyping a URL.
   */
  useForChat: boolean;
  /**
   * Offer models already downloaded with LM Studio or Ollama.
   *
   * On by default. Someone arriving from either tool has the weights already,
   * and the alternative is asking them to spend an evening re-downloading
   * files that are sitting on the same disk. Reading those directories is
   * local and read-only; nothing about it reaches the network.
   */
  importForeignModels: boolean;
  /** Extra directories of GGUF files the user named themselves. */
  extraModelDirs?: string[];
}

const DEFAULTS: Omit<RuntimeConfig, "modelsDir"> = {
  startOnLaunch: false,
  useForChat: true,
  importForeignModels: true,
};

export interface EnsureOptions {
  signal?: AbortSignal;
  onPhase?: (what: string) => void;
  onProgress?: (p: Progress & { what: string }) => void;
}

export class RuntimeManager {
  #config: RuntimeConfig = { ...DEFAULTS, modelsDir: "" };
  /** What the last index build found, for the UI to report. */
  #index: IndexResult | undefined;
  #lemonade = new LemonadeServer();
  #listeners = new Set<() => void>();

  /**
   * The client for whatever Lemonade is running, or nothing when it is not.
   *
   * A live target rather than a stored base URL: the daemon gets a fresh port
   * on every start, so a client that captured one would keep working until the
   * first restart and then fail in a way that looked like the daemon was down.
   */
  #api = new LemonadeApi(() => {
    const { adminUrl } = this.#lemonade.status;
    return adminUrl ? { base: adminUrl, headers: this.#lemonade.authHeaders() } : undefined;
  });

  get config(): RuntimeConfig {
    return this.#config;
  }

  get lemonade(): LemonadeServer {
    return this.#lemonade;
  }

  get api(): LemonadeApi {
    return this.#api;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  async load(): Promise<RuntimeConfig> {
    this.#config = { ...DEFAULTS, modelsDir: defaultModelsDir() };
    try {
      const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<RuntimeConfig>;
      this.#config = { ...this.#config, ...parsed };
    } catch (err) {
      /* A missing file is the first run. A file that will not parse is a
         force-quit or a power cut caught mid-write, and it must not throw out
         of startup: this runs inside `main()`, and everything registered after
         it -- the runtime's whole IPC surface -- would never happen. The
         defaults already assigned above are a working configuration. */
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`runtime.json could not be read (${(err as Error).message}); using defaults.`);
      }
    }
    this.#lemonade.onChange(() => this.#emit());
    return this.#config;
  }

  async update(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
    this.#config = { ...this.#config, ...patch };
    await makeOwnDir(CONFIG_DIR);
    await writeFile(CONFIG_PATH, `${JSON.stringify(this.#config, null, 2)}\n`, {
      mode: OWNER_ONLY_FILE,
    });
    this.#emit();
    return this.#config;
  }

  /**
   * The LM Studio and Ollama models in the current index.
   *
   * Read from what the last build recorded rather than rescanned: the answer
   * cannot change without a rebuild, and a rescan on every list would walk two
   * directory trees to tell the UI something it already knew.
   */
  get foreignModels(): IndexResult["foreign"] {
    return this.#index?.foreign ?? [];
  }

  /** Which stores were found, and how many models each held. */
  get foreignStores(): IndexResult["found"] {
    return this.#index?.found ?? [];
  }

  /**
   * Rebuild the index and restart the daemon so it rescans.
   *
   * Lemonade reads `extra_models_dir` once at startup, so a model added in LM
   * Studio while Karen is open cannot appear without this.
   */
  async rescanModels(): Promise<IndexResult["found"]> {
    await this.stop();
    this.#index = undefined;
    await this.ensureLemonade();
    return this.foreignStores;
  }

  /* ------------------------------------------------------------- backend -- */

  /**
   * Have a Lemonade running, installing it the first time.
   *
   * Idempotent and cheap when it is already up, because everything that wants
   * the daemon calls this rather than assuming someone else did -- there is no
   * single moment in the app's life when "the backend is ready" is true, and
   * pretending otherwise is how a race gets written.
   */
  async ensureLemonade(opts: EnsureOptions = {}): Promise<LemonadeApi> {
    if (this.#lemonade.status.state === "ready") return this.#api;

    const dir = lemonadeDir(LEMONADE_VERSION);
    let binary = await findLemonade(dir);
    if (!binary) {
      const install = await installLemonade({
        dir,
        staging: join(stagingDir(), "lemonade"),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });
      binary = install.binary;
    }

    /*
     * Everything Karen can offer has to be reachable from one directory,
     * because that is all `extra_models_dir` accepts. Built before the daemon
     * starts, since the daemon scans it once at startup.
     *
     * A failure here must not stop the backend: losing the LM Studio models is
     * a disappointment, and losing the daemon because of it would be a fault.
     * The fallback is the models directory itself, which is exactly what was
     * passed before any of this existed.
     */
    opts.onPhase?.("looking for models you already have");
    const modelsDir = this.#config.modelsDir || defaultModelsDir();
    let indexDir = modelsDir;
    try {
      this.#index = await buildIndex({
        indexDir: lemonadeIndexDir(),
        modelsDir,
        includeForeign: this.#config.importForeignModels,
        ...(this.#config.extraModelDirs ? { extraDirs: this.#config.extraModelDirs } : {}),
      });
      indexDir = this.#index.dir;
    } catch (err) {
      this.#index = undefined;
      this.#lemonade.note(`Could not index your model folders: ${(err as Error).message}`);
    }

    opts.onPhase?.("starting Lemonade");
    const status = await this.#lemonade.start({
      binary,
      cacheDir: lemonadeCacheDir(),
      configDir: lemonadeConfigDir(),
      // So a library built up under the old runtime is simply there.
      modelsDir: indexDir,
    });
    if (status.state !== "ready") throw new Error(status.error ?? "Lemonade did not start.");
    return this.#api;
  }

  /* -------------------------------------------------------------- models -- */

  /**
   * Every model Lemonade knows about, read from the install rather than asked.
   *
   * `/models` answers with what is registered -- three things on a fresh
   * machine -- while the catalogue proper ships inside the daemon as
   * `resources/server_models.json`. Reading the file needs no network and,
   * more to the point, carries each model's size and labels, which the API does
   * not return and without which the list cannot say what a model is for or
   * whether it will fit.
   */
  async catalog(): Promise<CatalogEntry[]> {
    const binary = await findLemonade(lemonadeDir(LEMONADE_VERSION));
    if (!binary) return [];
    try {
      const path = join(dirname(binary), "resources", "server_models.json");
      return enabledOnly(parseCatalog(JSON.parse(await readFile(path, "utf8"))));
    } catch {
      // A catalogue we cannot read is an empty one; the daemon still works and
      // anything already installed still lists through /models.
      return [];
    }
  }

  /**
   * Which model is being loaded right now, if any.
   *
   * Loading an 8B model off a cold page cache is tens of seconds during which
   * `/load` has not returned and health still reports nothing -- measured, the
   * daemon publishes no intermediate state at all. So the only way the window
   * can say anything truthful while it happens is for this process to say it
   * is happening.
   */
  #loading: string | undefined;

  get loadingModel(): string | undefined {
    return this.#loading;
  }

  async loadModel(name: string): Promise<void> {
    await this.ensureLemonade();
    this.#loading = name;
    this.#emit();
    try {
      await this.#api.loadModel(name);
    } finally {
      /* Cleared before the health refresh so a failed load does not leave the
         bar spinning over a model that is not coming. */
      this.#loading = undefined;
      this.#emit();
    }
    await this.#lemonade.refreshHealth();
    await this.update({ activeModel: name });
  }

  async unloadModel(): Promise<void> {
    if (this.#lemonade.status.state !== "ready") return;
    await this.#api.unloadModel();
    await this.#lemonade.refreshHealth();
    this.#emit();
  }

  /* ------------------------------------------------------------ endpoints -- */

  /**
   * Where chat should send its requests, when Karen is hosting the model.
   *
   * Gated on a model actually being loaded, not merely on the daemon running:
   * Lemonade comes up in a second and holds nothing, so "it is up" says
   * nothing about whether a request would be answered.
   */
  chatEndpoint():
    | { baseUrl: string; apiKey: string; model: string; contextTokens?: number }
    | undefined {
    if (!this.#config.useForChat) return undefined;
    const status = this.#lemonade.status;
    if (status.state !== "ready" || !status.baseUrl || !status.health?.modelLoaded) return undefined;
    /*
     * The model name travels with the address, and must.
     *
     * Lemonade rejects a chat request that does not name a model -- "Invalid
     * request: No model specified in request" -- and the name in `settings.llm`
     * is whoever the user typed for their own endpoint, which for someone
     * running locally is usually nothing at all. So the caller cannot build a
     * working request out of the base URL alone, and handing over the address
     * without the name invited exactly that. This is the id the daemon knows
     * it by, which is not always what the UI shows a person.
     */
    return {
      baseUrl: status.baseUrl,
      apiKey: this.#lemonade.apiKey,
      model: status.health.modelLoaded,
      /* The denominator for the token meter and the trigger for compaction.
         Only present when it was actually established -- a guessed window is
         worse than none, because compaction would fire at the wrong point. */
      ...(status.health.active?.contextTokens
        ? { contextTokens: status.health.active.contextTokens }
        : {}),
    };
  }

  /**
   * A transcription endpoint, when Lemonade has a speech model to offer.
   *
   * Returns the model name as well as the address, because the two are not
   * separable here: the configured default is OpenAI's `whisper-1`, which this
   * daemon has never heard of, so sending that would fail against a server that
   * is working perfectly. Whichever Whisper is actually present is used.
   *
   * Nothing is started for this. If the daemon is not already running the
   * answer is "no" -- transcription should not be what pays to boot it.
   */
  async transcriptionEndpoint(): Promise<{ baseUrl: string; apiKey: string; model: string } | undefined> {
    const status = this.#lemonade.status;
    if (status.state !== "ready" || !status.baseUrl) return undefined;
    try {
      const models = await this.#api.listModels();
      const speech = models.find((m) => /whisper|moonshine/i.test(m.id));
      if (!speech) return undefined;
      return { baseUrl: status.baseUrl, apiKey: this.#lemonade.apiKey, model: speech.id };
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------ lifecycle -- */

  /** Start the backend and load the remembered model, for `startOnLaunch`. */
  async startOnLaunch(): Promise<void> {
    if (!this.#config.startOnLaunch || !this.#config.activeModel) return;
    await this.ensureLemonade();
    await this.#api.loadModel(this.#config.activeModel);
    await this.#lemonade.refreshHealth();
    this.#emit();
  }

  async stop(): Promise<void> {
    await this.#lemonade.stop();
  }

  killNow(): void {
    this.#lemonade.killNow();
  }
}
