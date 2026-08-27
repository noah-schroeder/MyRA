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
import { parseCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { LEMONADE_VERSION } from "../../core/runtime/lemonade.ts";
import { LemonadeServer } from "./lemonade.ts";
import { LemonadeApi } from "./lemonadeApi.ts";
import { findLemonade, installLemonade } from "./lemonadeInstall.ts";
import { defaultModelsDir, lemonadeCacheDir, lemonadeConfigDir, lemonadeDir, stagingDir } from "./paths.ts";
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
}

const DEFAULTS: Omit<RuntimeConfig, "modelsDir"> = {
  startOnLaunch: false,
  useForChat: true,
};

export interface EnsureOptions {
  signal?: AbortSignal;
  onPhase?: (what: string) => void;
  onProgress?: (p: Progress & { what: string }) => void;
}

export class RuntimeManager {
  #config: RuntimeConfig = { ...DEFAULTS, modelsDir: "" };
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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

    opts.onPhase?.("starting Lemonade");
    const status = await this.#lemonade.start({
      binary,
      cacheDir: lemonadeCacheDir(),
      configDir: lemonadeConfigDir(),
      // So a library built up under the old runtime is simply there.
      modelsDir: this.#config.modelsDir || defaultModelsDir(),
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
      return parseCatalog(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // A catalogue we cannot read is an empty one; the daemon still works and
      // anything already installed still lists through /models.
      return [];
    }
  }

  async loadModel(name: string): Promise<void> {
    await this.ensureLemonade();
    await this.#api.loadModel(name);
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
  chatEndpoint(): { baseUrl: string; apiKey: string } | undefined {
    if (!this.#config.useForChat) return undefined;
    const status = this.#lemonade.status;
    if (status.state !== "ready" || !status.baseUrl || !status.health?.modelLoaded) return undefined;
    return { baseUrl: status.baseUrl, apiKey: this.#lemonade.apiKey };
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
