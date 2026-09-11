/**
 * The local inference backend: install it, run it, and remember what to load.
 *
 * This file used to be 835 lines, and almost all of it was llama.cpp
 * housekeeping -- fetching release assets, reading an OCI registry for the
 * CUDA build upstream does not publish there, probing devices, guessing a
 * backend from PCI vendor ids, scanning GGUF headers, composing launch flags.
 * All of that is now Lemonade's, which is the point: it maintains a build
 * matrix across CUDA, ROCm, Vulkan, NPU, Metal and CPU that MyRA could not,
 * and it was already doing it correctly on hardware where MyRA's own attempt
 * had failed five times over.
 *
 * What is left here is the part that is genuinely MyRA's: which model to load
 * on launch, whether chat should use the local model at all, where models live,
 * and the guarantee that nothing MyRA starts outlives it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE,
} from "../../core/paths.ts";
import { enabledOnly, parseCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import {
  pinKey, withoutPin, withPin, type EnginePins,
} from "../../core/runtime/enginePins.ts";
import {
  chatModelOf, chatModelToReload, isChatEngine, isChatModel, LEMONADE_VERSION,
  type LoadedModel,
} from "../../core/runtime/lemonade.ts";
import { LemonadeServer } from "./lemonade.ts";
import { LemonadeApi } from "./lemonadeApi.ts";
import { findLemonade, installLemonade } from "./lemonadeInstall.ts";
import { bundledLoader } from "./loader.ts";
import { repairEngines } from "./engineRuntime.ts";
import { shippedVersions } from "./engineVersions.ts";
import { checkEngineUpdates, type UpdateCheck } from "./engineUpdates.ts";
import { buildIndex, readIndexSources, type IndexResult } from "./foreignScan.ts";
import {
  defaultModelsDir, lemonadeCacheDir, lemonadeConfigDir, lemonadeDir, lemonadeIndexDir, stagingDir,
} from "./paths.ts";
import type { Progress } from "./download.ts";
import type { MachineInfo, PullProgress } from "../../core/runtime/systemInfo.ts";
import type { InstalledModel } from "./lemonadeApi.ts";
import { autoContext } from "../../core/runtime/fit.ts";
import { kvBytesPerElement, readFlags, writeFlags } from "../../core/runtime/llamaArgs.ts";
import { factsFor } from "./modelFacts.ts";
import { isOverridden, type ModelOptions } from "../../core/runtime/modelOptions.ts";

/**
 * Whether CUDA is what this model would actually run on.
 *
 * A backend pinned for this model, in `llamacpp_backend`, is respected
 * outright -- matching CUDA or not, that is the user's own choice. Left on
 * the daemon's "auto", it is inferred from the hardware: an Nvidia device the
 * probe found, and the cuda backend actually installed rather than merely
 * offered as an option.
 */
function cudaIsTheBackend(options: ModelOptions, info: MachineInfo): boolean {
  const pinned = String(options.effective["llamacpp_backend"] ?? "").trim().toLowerCase();
  if (pinned) return pinned === "cuda";
  return (
    info.devices.some((d) => d.id.startsWith("CUDA")) &&
    info.backends.some((b) => b.id === "cuda" && b.state === "installed")
  );
}

const CONFIG_PATH = join(CONFIG_DIR, "runtime.json");

export interface RuntimeConfig {
  /** Where MyRA's own model files live; Lemonade is pointed at this too. */
  modelsDir: string;
  /** Start the backend when the app opens. Off by default: an 8 GB process
   *  should not appear because someone opened a window. */
  startOnLaunch: boolean;
  /* `| undefined` for the same reason `defaultModel` has it below: a record
     naming a speech model has to be expressible as cleared, not merely
     overwritten. */
  /** The model to load, by the name Lemonade knows it as. */
  activeModel?: string | undefined;
  /**
   * The model to load at startup, chosen deliberately.
   *
   * Separate from `activeModel`, which is simply the last one loaded and
   * therefore changes every time you try something. That made the startup model
   * whatever you happened to open last -- fine when you have three models, and
   * not what anyone means by a default when they have sixty. Unset falls back
   * to `activeModel`, which is the behaviour every existing install already has.
   */
  /* `| undefined` explicitly, so clearing it is expressible: with
     exactOptionalPropertyTypes a bare optional cannot be set back to nothing,
     and un-choosing a default is a thing people need to do. */
  defaultModel?: string | undefined;
  /**
   * Send chat and research to the model MyRA is serving.
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
  /**
   * Engine builds chosen here, over the ones this Lemonade ships with.
   *
   * Keyed `recipe:backend` -- see core/runtime/enginePins.ts for why a pin
   * cannot be per engine. Absent means "whatever Lemonade shipped", which is
   * what every install has until somebody presses Update, and deleting a key
   * is how it goes back.
   */
  enginePins?: EnginePins;
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

  /** MyRA's own models folder, as configured. */
  get modelsDir(): string {
    return this.#config.modelsDir || defaultModelsDir();
  }

  /**
   * The directory the daemon was actually pointed at.
   *
   * Not always `lemonadeIndexDir()`: when the index cannot be built the models
   * directory is passed straight through, and anything resolving a model's
   * files has to follow the same path the daemon did rather than the one it
   * was meant to.
   */
  get indexDir(): string {
    return this.#index?.dir ?? this.modelsDir;
  }

  /**
   * Rebuild the index and restart the daemon so it rescans.
   *
   * Lemonade reads `extra_models_dir` once at startup, so a model added in LM
   * Studio while MyRA is open cannot appear without this.
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
     * Everything MyRA can offer has to be reachable from one directory,
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
      ...(this.#config.enginePins ? { enginePins: this.#config.enginePins } : {}),
      // So a library built up under the old runtime is simply there.
      modelsDir: indexDir,
    });
    if (status.state !== "ready") throw new Error(status.error ?? "Lemonade did not start.");
    await this.#repairEngines(dirname(binary));
    return this.#api;
  }

  /**
   * Give the installed engines the C runtime the daemon itself is using.
   *
   * Runs on every launch rather than once, because Lemonade installs engines
   * whenever the user asks for one and reinstalls them on an upgrade -- and a
   * wrapper that exists only if you were running the right version of MyRA on
   * the day you pressed the button is not a fix.
   *
   * Never fatal. A machine that cannot be repaired still has a working daemon
   * and working chat, and the failure it produces afterwards now says what is
   * wrong; losing the backend over this would be the worse trade.
   */
  async #repairEngines(lemondDir: string): Promise<void> {
    try {
      for (const fixed of await repairEngines(lemonadeCacheDir(), lemondDir)) {
        this.#lemonade.note(
          `${fixed.recipe} (${fixed.backend}) needs ${fixed.missing.join(", ")}, which this ` +
            `system does not have; started it through the C library MyRA ships instead.`,
        );
      }
    } catch (err) {
      this.#lemonade.note(`Could not adapt the engines to this system: ${(err as Error).message}`);
    }
  }

  /* -------------------------------------------------- engine versions -- */

  /**
   * Which build each installed backend is on, and which Lemonade shipped.
   *
   * The installed figure comes from the daemon, which reads it from the
   * `version.txt` beside the binary -- not from MyRA's pin. The two are the
   * same right up until somebody changes one, which is exactly when showing
   * the pin instead would start lying about what is on the disk.
   */
  async engineVersions(): Promise<{ pins: EnginePins; shipped: Record<string, string> }> {
    const pins = this.#config.enginePins ?? {};
    const binary = await findLemonade(lemonadeDir(LEMONADE_VERSION));
    if (!binary) return { pins, shipped: {} };
    const table = await shippedVersions(dirname(binary)).catch(() => undefined);
    const shipped: Record<string, string> = {};
    for (const [recipe, block] of Object.entries(table ?? {})) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      for (const [backend, version] of Object.entries(block as Record<string, unknown>)) {
        /* Every block in that file carries a `comment` explaining itself, and
           two of them run to several hundred words. They are strings like any
           version is, and shipping them across the IPC boundary on every
           refresh of the runtime screen buys nothing. */
        if (backend !== "comment" && typeof version === "string") {
          shipped[pinKey(recipe, backend)] = version;
        }
      }
    }
    return { pins, shipped };
  }

  /** Look for newer engine builds. Never called except from a button. */
  async checkEngineUpdates(): Promise<UpdateCheck> {
    await this.ensureLemonade();
    return checkEngineUpdates({ api: this.#api });
  }

  /**
   * Move one backend to a different build, or back to the shipped one.
   *
   * Three steps in a fixed order, because the daemon reads its version table
   * only at startup: write the pin, restart, install. The restart is what
   * makes this worth a confirmation -- it drops every loaded model.
   *
   * **A failure puts the pin back.** Leaving a pin that could not be installed
   * would leave the backend in `update_required`, and the daemon fetches a
   * pending build silently on the next `/load` -- measured. Somebody who
   * pressed Update, saw it fail, and went back to work would then have the
   * download happen anyway, in the middle of a sentence, with nothing on
   * screen to explain it.
   */
  async updateEngine(
    recipe: string,
    backend: string,
    version: string | undefined,
    opts: { onPhase?: (what: string) => void } = {},
  ): Promise<{ version?: string | undefined }> {
    const key = pinKey(recipe, backend);
    const before = this.#config.enginePins ?? {};
    const after = version ? withPin(before, key, version) : withoutPin(before, key);

    await this.update({ enginePins: after });
    try {
      opts.onPhase?.("Restarting the backend so it reads the new version");
      await this.stop();
      await this.ensureLemonade();
      opts.onPhase?.("Downloading the engine");
      await this.#api.installBackend(recipe, backend);
      /* Before reporting success: a newer build can want newer system
         libraries than this machine has, and MyRA's answer to that is to run
         it through the C runtime it ships. The moment it was installed is the
         only moment anybody is watching. */
      await this.repairInstalledEngines();
    } catch (err) {
      await this.update({ enginePins: before }).catch(() => undefined);
      await this.stop().catch(() => undefined);
      await this.ensureLemonade().catch(() => undefined);
      throw err;
    }
    /* Read back rather than reported: what the screen shows afterwards has to
       be the build on the disk, not the one that was asked for. */
    const info = await this.#api.systemInfo().catch(() => undefined);
    const found = info?.engines.find((e) => e.id === recipe)?.backends.find((b) => b.id === backend);
    return { version: found?.version };
  }

  /**
   * The same repair, for an engine that has just been installed.
   *
   * Separate entry point because an install happens with the daemon already
   * running, so nothing would otherwise look at the new directory until the
   * next launch -- and the user installs an engine precisely because they are
   * about to use it.
   */
  async repairInstalledEngines(): Promise<void> {
    const binary = await findLemonade(lemonadeDir(LEMONADE_VERSION));
    if (binary) await this.#repairEngines(dirname(binary));
  }

  /**
   * Whether this machine was too old for the daemon's own build.
   *
   * MyRA ships a C runtime beside `lemond` when the host's glibc is older
   * than the GLIBC_2.38 the embeddable needs. That fact is worth far more than
   * the daemon's startup, because the ENGINES lemond downloads afterwards are
   * built the same way and get no such help: measured on the released
   * binaries, `whisper-server` v1.8.4 and kokoro's `koko` b17 both need
   * GLIBC_2.38, while the llama.cpp build needs only 2.34. So on one of these
   * machines chat works and every speech model dies on startup with exit code
   * 1 -- which is exactly the shape of the failure that has to be explained.
   *
   * Read off the disk rather than remembered, the same way `launchSpec`
   * decides how to start the daemon, so the two can never disagree.
   */
  async bundledLibc(): Promise<boolean> {
    const binary = await findLemonade(lemonadeDir(LEMONADE_VERSION));
    return binary ? bundledLoader(dirname(binary)) !== undefined : false;
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

  /**
   * Give a model a window worth having and a sensible backend default, before
   * it loads.
   *
   * The daemon's default is `ctx_size: -1`, which resolves to **4,096** whatever
   * the model can do -- measured, on one whose ceiling is 131,072. That is the
   * number the context half of this exists to improve on, and
   * `POST /models/{id}/options` before `/load` is how: measured against lemond
   * 11.8.0, the launch command came out as `llama-server ... --ctx-size 8192`,
   * so the patch reaches the process. Both patches below go through the same
   * one call when there is anything to send, rather than two round trips.
   *
   * Three refusals hold for context, and each is load-bearing:
   *
   *   - **A value the user set is never touched.** `saved` is the daemon's own
   *     record of what was overridden, so this asks it rather than guessing.
   *   - **A recipe with no `ctx_size` is left alone**, which is how whispercpp
   *     stays out of this by the daemon's own field list rather than by a
   *     model-name test.
   *   - **A window that will not fit is not written down.** `autoContext`
   *     returns nothing in that case and this writes nothing: the daemon's 4,096
   *     is a poor default, but a number that stops the model loading is worse.
   *     The daemon does not clamp -- asked for a million it tries, and the OOM
   *     killer arrives -- so the clamping is ours to do.
   *
   * Flash attention gets one refusal of its own, and it is finer-grained than
   * "has `llamacpp_args` been overridden": that string holds many flags, and a
   * user who has set `-ngl 32` and nothing else about attention has not made a
   * choice about this one. So the check reads the string itself -- `--flash-attn`
   * present, in any of its three values, is left exactly as it is; only its
   * absence, which covers both "never set" and an old bare `--flash-attn` from
   * before this flag required a value, gets `on` written in, and only on CUDA.
   */
  async #autoTuneLoad(name: string): Promise<void> {
    try {
      const options = await this.#api.modelOptions(name);
      /* `ctx_size`, `llamacpp_args` and `llamacpp_backend` are the llamacpp
         recipe's own fields, measured and documented in modelOptions.ts --
         their presence here, not a name test, is what keeps this whole method
         away from whispercpp, kokoro and sd-cpp models. */
      if (!("ctx_size" in options.defaults)) return;

      const info = await this.#api.systemInfo().catch(() => undefined);
      const patch: { ctx_size?: number; llamacpp_args?: string } = {};

      if (info && !isOverridden(options, "ctx_size")) {
        const model = (await this.#api.listModels().catch(() => [])).find((m) => m.id === name);
        if (model?.sizeBytes) {
          /* Read, never fetched: the shape was learned when the model was
             downloaded. Absent means the sizer falls back to the floor and
             says so, which is the honest answer for a model imported from
             elsewhere or downloaded before this existed. */
          const facts = await factsFor(name);
          const args = options.effective["llamacpp_args"];
          const bpe = typeof args === "string" ? kvBytesPerElement(args) : undefined;

          const auto = autoContext({
            fileBytes: model.sizeBytes,
            machine: {
              ...(info.devices[0]?.totalBytes ? { vramBytes: info.devices[0].totalBytes } : {}),
              ramBytes: info.ramBytes ?? 0,
            },
            ...(facts?.shape ? { shape: facts.shape } : {}),
            ...(model.maxContextTokens ? { ceiling: model.maxContextTokens } : {}),
            /* A quantised KV cache is the one flag that changes how long a
               window fits, so somebody who set it gets sized against what
               they set. */
            ...(bpe ? { bytesPerElement: bpe } : {}),
          });
          if (auto.tokens && auto.tokens !== options.resolvedCtxSize) patch.ctx_size = auto.tokens;
        }
      }

      if (info) {
        const args = options.effective["llamacpp_args"];
        const current = typeof args === "string" ? args : "";
        if (!readFlags(current).values["--flash-attn"] && cudaIsTheBackend(options, info)) {
          patch.llamacpp_args = writeFlags(current, { "--flash-attn": "on" });
        }
      }

      if (Object.keys(patch).length) await this.#api.setModelOptions(name, patch);
    } catch {
      /* Tuning is an improvement on the default, not a precondition for
         loading one. A daemon that refuses the patch, a model list that
         fails, a probe that reports no devices -- all of them mean "load it
         as it was". */
    }
  }

  async loadModel(name: string): Promise<void> {
    await this.ensureLemonade();
    await this.#autoTuneLoad(name);
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

    /*
     * Only a model chat can actually be held with becomes the active one.
     *
     * `activeModel` is what the chat bar names and what `startOnLaunch`
     * reloads, so a speech model recorded here follows the user around: the
     * bar offered Whisper and Kokoro as the conversation's model, which is the
     * report this guards against. `loadAuxModel` is the road speech and image
     * models are supposed to arrive by, and this makes the wrong road safe
     * rather than merely discouraged.
     */
    const loaded = this.#lemonade.status.health?.models.find((m) => m.id === name);
    if (!loaded || isChatModel(loaded)) await this.update({ activeModel: name });
  }

  async unloadModel(model?: string): Promise<void> {
    if (this.#lemonade.status.state !== "ready") return;
    await this.#api.unloadModel(model);
    await this.#lemonade.refreshHealth();
    this.#emit();
  }

  /* ------------------------------------------------------------ endpoints -- */

  /**
   * Where chat should send its requests, when MyRA is hosting the model.
   *
   * Gated on a model actually being loaded, not merely on the daemon running:
   * Lemonade comes up in a second and holds nothing, so "it is up" says
   * nothing about whether a request would be answered.
   */
  /**
   * The model a message would go to, or nothing.
   *
   * Shared with `chatEndpoint` so the bar and the request can never disagree
   * -- if this says nothing, "None selected" is the truth rather than a
   * placeholder, and no message is quietly going somewhere unnamed.
   */
  chatModel(): LoadedModel | undefined {
    if (!this.#config.useForChat) return undefined;
    if (this.#lemonade.status.state !== "ready") return undefined;
    return chatModelOf(this.#lemonade.status.health, this.#config.activeModel);
  }

  /**
   * Put the chosen chat model back if something took it away.
   *
   * Nothing loaded a model because a message was sent, and several things
   * unload one. Lemonade evicts on its own -- "Load failed with
   * non-file-not-found error, evicting all models and retrying", seen in a
   * user's log dropping their chat model to make room for a Whisper that then
   * failed anyway -- and MyRA's own eject button frees a card deliberately.
   * After either, `chatModel()` is empty, the bar reads "None selected", and
   * the only way back was to reopen the menu and pick the same model again.
   *
   * Ejecting is "give me the memory back", not "I have stopped wanting this
   * model", which is why the eject button leaves the choice in place. This is
   * the other half of that sentence.
   *
   * Returns why it could not, so the caller can say something better than "no
   * model is loaded" about a model that is chosen and would not load.
   */
  async ensureChatModel(): Promise<string | undefined> {
    /*
     * The cheap conditions first, because the catalogue read below is not.
     *
     * `catalog()` opens and parses a 70 KB file of 228 entries, and this runs
     * on EVERY model call -- not only chat turns, but each stage of a research
     * run, which makes dozens. Asking the disk that many times to answer a
     * question that is almost always "the model is already loaded, do nothing"
     * is the kind of cost that never shows up in a test and is felt in a long
     * run. The rules themselves still live in one place, below.
     */
    if (!this.#config.useForChat) return undefined;
    if (this.#lemonade.status.state !== "ready") return undefined;
    if (this.chatModel()) return undefined;

    const chosen = this.#config.activeModel;
    const recipe = chosen
      ? (await this.catalog().catch(() => [])).find((e) => e.id === chosen)?.recipe
      : undefined;
    const wanted = chatModelToReload({
      useForChat: this.#config.useForChat,
      ready: this.#lemonade.status.state === "ready",
      resolved: this.chatModel(),
      ...(chosen ? { activeModel: chosen } : {}),
      ...(recipe ? { recipe } : {}),
    });
    if (!wanted) return undefined;

    try {
      await this.loadModel(wanted);
      return undefined;
    } catch (err) {
      return `${wanted} is the chosen model and it would not load: ${(err as Error).message}`;
    }
  }

  chatEndpoint():
    | { baseUrl: string; apiKey: string; model: string; contextTokens?: number }
    | undefined {
    if (!this.#config.useForChat) return undefined;
    const status = this.#lemonade.status;
    if (status.state !== "ready" || !status.baseUrl) return undefined;
    /*
     * Resolved from what is loaded, NOT from `model_loaded`.
     *
     * That field names the model the daemon touched last, and since audio runs
     * through the same daemon it is routinely a speech model: transcribe one
     * clip and it reads `Whisper-Tiny` while the chat model is still resident
     * on its own backend. Reading it here sent the next message in the
     * conversation to Whisper. `chatModelOf` prefers the model MyRA loaded on
     * purpose and will only ever return one whose engine can hold a
     * conversation.
     */
    const model = this.chatModel();
    if (!model) return undefined;
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
      model: model.id,
      /* The denominator for the token meter and the trigger for compaction.
         Only present when it was actually established -- a guessed window is
         worse than none, because compaction would fire at the wrong point.
         Taken from the chat model's own entry, so a loaded voice model cannot
         lend the meter its (absent) context. */
      ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    };
  }

  /**
   * Where a local model that is not the chat model can be reached.
   *
   * Speech, voice and image models all ask this, and the model is passed in
   * rather than looked for. This used to search the installed models for
   * `/whisper|moonshine/i` and use the first hit, which made "which model
   * transcribes me" a question with no answer in the interface and the wrong
   * answer whenever two were downloaded. The choice lives in the settings now
   * and this only resolves it.
   *
   * `start` decides whether it is worth booting the daemon for. Dictation says
   * yes -- somebody pressed the microphone, and a first press that silently
   * does nothing is the worst answer available. Meetings says no, because a
   * background stage should not be what starts an inference engine.
   */
  async auxEndpoint(
    model: string,
    { start = false }: { start?: boolean } = {},
  ): Promise<{ baseUrl: string; apiKey: string; model: string } | undefined> {
    if (!model.trim()) return undefined;
    if (start) await this.ensureLemonade();
    const status = this.#lemonade.status;
    if (status.state !== "ready" || !status.baseUrl) return undefined;
    return { baseUrl: status.baseUrl, apiKey: this.#lemonade.apiKey, model };
  }

  /**
   * Load a model without making it the conversation's model.
   *
   * `loadModel` records what it loaded as `activeModel`, which is right for the
   * model you are talking to and wrong for every model that is not answering
   * you: the chat picker would start showing Whisper as the model in use, and
   * the startup default could become a speech model that cannot answer a
   * message. Lemonade holds several at once on separate backends -- measured,
   * chat on 8002 and Whisper on 8003 -- so nothing is given up by keeping the
   * records apart. Diffusion models arrive through here for the same reason,
   * and `sd-cpp` is already in NON_CHAT_RECIPES so one can never be handed a
   * conversation.
   */
  async loadAuxModel(name: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    await this.ensureLemonade();
    const installed = await this.#api.listModels().catch(() => []);
    /* Pulled first when it is not here, so the caller can show a download
       rather than a load that inexplicably takes twenty minutes. A request
       would have pulled it anyway -- measured at 19.7 s for Kokoro's 354 MB --
       but silently, in the middle of somebody dictating. */
    if (!installed.some((m) => m.id === name && m.downloaded !== false)) {
      await this.#api.pullModel(name, undefined, undefined, undefined, onProgress);
    }
    await this.#api.loadModel(name);
    await this.#lemonade.refreshHealth();
    this.#emit();
  }

  /** Every model the daemon knows about, with the labels that say what each is for. */
  async installedModels(): Promise<InstalledModel[]> {
    await this.ensureLemonade();
    return this.#api.listModels();
  }

  /* ------------------------------------------------------------ lifecycle -- */

  /** Start the backend and load the remembered model, for `startOnLaunch`. */
  async startOnLaunch(): Promise<void> {
    const wanted = this.#config.defaultModel ?? this.#config.activeModel;
    if (!this.#config.startOnLaunch || !wanted) return;
    await this.ensureLemonade();
    /* A record written before speech models were kept out of `activeModel`
       can still name one, and loading it at every launch would hold a
       transcription model open for a conversation it cannot answer. The
       catalogue knows what each model is without starting anything. */
    const recipe = (await this.catalog().catch(() => [])).find((e) => e.id === wanted)?.recipe;
    if (recipe && !isChatEngine(recipe)) {
      await this.update({ activeModel: undefined });
      return;
    }
    await this.#api.loadModel(wanted);
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
