/**
 * The bundled runtime, from "this machine has an AMD card" to "a model is
 * answering on 127.0.0.1".
 *
 * The order of operations here is the whole design, and it is not arbitrary:
 *
 *     detect GPU  ->  download a build  ->  PROBE it  ->  size models  ->  run
 *
 * The probe sits in the middle because Electron reports the GPU's vendor and
 * never its memory. Only `llama-server --list-devices` knows how much VRAM
 * there is, so a model cannot honestly be recommended until a runtime is
 * installed. That is why the runtime is installed first, and it is also what
 * turns the vendor-id guess into a fact -- a vendor id proves a card exists, not
 * that a working driver is installed.
 *
 * Everything here is opt-in. Karen works perfectly well against an endpoint the
 * user points it at; this exists so that they do not have to have one.
 */

import { app } from "electron";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, totalmem } from "node:os";

import { CONFIG_DIR } from "../../core/paths.ts";
import {
  newestBuild, pickAsset, pickCudart, sha256Of, type Backend, type Release, type ReleaseAsset,
} from "../../core/runtime/assets.ts";
import {
  hasAccelerator, largestDeviceBytes, parseDevices, suggestBackend, type Device, type GpuInfo,
} from "../../core/runtime/devices.ts";
import { modelShape, parseGguf, type ModelShape } from "../../core/runtime/gguf.ts";
import { fitModel, largestContext, type Fit } from "../../core/runtime/fit.ts";
import { dedupeFound, knownStores, scanStore, type FoundModel, type WalkFs } from "../../core/runtime/scan.ts";
import { downloadFile, extractArchive, findExecutable } from "./download.ts";
import { buildDir, defaultModelsDir, stagingDir } from "./paths.ts";
import { LlamaServer, listDevices, type ServerStatus } from "./server.ts";

const RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30";
const CONFIG_PATH = join(CONFIG_DIR, "runtime.json");

/**
 * The build a fresh install gets.
 *
 * Pinned rather than "whatever is newest", because upstream ships nightlies --
 * seven builds landed on the day this was written -- and "latest" therefore
 * means "a build nobody has run". The update button can move past this; a first
 * install should not start on an unknown quantity.
 */
export const BASELINE_BUILD = "b10628";

export interface RuntimeConfig {
  /** `b10628-vulkan`, naming an installed build directory. */
  activeBuild?: string;
  /** Set when the user overrides the detected backend. */
  backendOverride?: Backend;
  modelsDir: string;
  /** Start the server when the app opens. Off by default: an 8 GB process
   *  should not appear because someone opened a window. */
  startOnLaunch: boolean;
  /** The model to start, as an absolute path. */
  activeModel?: string;
  contextSize?: number;
  /**
   * Send chat and research to the model Karen is serving.
   *
   * Separate from the endpoint settings rather than overwriting them: someone
   * who configures their own endpoint and then tries the bundled runtime should
   * get their own back by switching this off, not by retyping a URL.
   */
  useForChat: boolean;
}

const DEFAULTS: Omit<RuntimeConfig, "modelsDir"> = { startOnLaunch: false, useForChat: true };

export interface InstalledBuild {
  id: string;
  tag: string;
  backend: Backend;
  dir: string;
  binary: string;
  devices: Device[];
}

export interface LocalModel {
  path: string;
  name: string;
  size: number;
  /** "Downloaded by Karen", or the app whose directory it was found in. */
  source: string;
  shape?: ModelShape;
  fit?: Fit;
}

export type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; what: string; receivedBytes: number; totalBytes?: number; bytesPerSecond: number }
  | { kind: "extracting"; what: string }
  | { kind: "probing"; what: string };

export class RuntimeManager {
  #config: RuntimeConfig = { ...DEFAULTS, modelsDir: "" };
  #server = new LlamaServer();
  #phase: Phase = { kind: "idle" };
  #gpu: GpuInfo = { vendorIds: [], supportsVulkan: false };
  /** The binary the running server was launched from, which is not necessarily
   *  the active build's: an update switches the pointer, not the process. */
  #serverBinary: string | undefined;
  #listeners = new Set<() => void>();

  get server(): LlamaServer {
    return this.#server;
  }
  get config(): RuntimeConfig {
    return this.#config;
  }
  get phase(): Phase {
    return this.#phase;
  }
  /**
   * The build the running process came from, which after an update is not the
   * active one: switching builds moves a pointer, and a loaded model carries on
   * executing the binary it was started with until it is restarted.
   */
  get serverBuild(): string | undefined {
    if (!this.#serverBinary) return undefined;
    const root = join(buildDir("x", "y"), "..");
    const rest = this.#serverBinary.slice(root.length + 1);
    return rest.split(/[/\\]/)[0];
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.#emit();
  }

  async load(): Promise<RuntimeConfig> {
    this.#config = { ...DEFAULTS, modelsDir: defaultModelsDir() };
    try {
      const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<RuntimeConfig>;
      this.#config = { ...this.#config, ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.#server.onChange(() => this.#emit());
    /*
     * Detect now, not on first use. `suggestion()` is read the moment the
     * Runtime pane opens, and without this it answers from an empty GpuInfo --
     * so a machine with a card is told "no GPU was detected" until something
     * else happens to call detect(). Cheap, and app is already ready here.
     */
    await this.detect();
    return this.#config;
  }

  async update(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
    this.#config = { ...this.#config, ...patch };
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(this.#config, null, 2) + "\n", { mode: 0o600 });
    this.#emit();
    return this.#config;
  }

  /* ------------------------------------------------------------ detection -- */

  /**
   * What Chromium can see. Verified to work: on the machine this was written
   * on it reported vendor 0x1AF4 (virtio) and `hardwareSupportsVulkan: false`,
   * both correct for a QEMU guest.
   */
  async detect(): Promise<GpuInfo> {
    try {
      const info = (await app.getGPUInfo("complete")) as {
        gpuDevice?: { vendorId?: number }[];
        auxAttributes?: { hardwareSupportsVulkan?: boolean };
      };
      this.#gpu = {
        vendorIds: (info.gpuDevice ?? []).map((d) => d.vendorId).filter((v): v is number => typeof v === "number"),
        supportsVulkan: info.auxAttributes?.hardwareSupportsVulkan === true,
      };
    } catch {
      // A headless or degraded session reports nothing useful. CPU is correct
      // in that case anyway.
      this.#gpu = { vendorIds: [], supportsVulkan: false };
    }
    return this.#gpu;
  }

  suggestion(): { backend: Backend; reason: string } {
    const chosen = this.#config.backendOverride;
    if (chosen) return { backend: chosen, reason: "Chosen by you in Settings." };
    return suggestBackend(process.platform, process.arch, this.#gpu);
  }

  /* -------------------------------------------------------------- builds --- */

  /**
   * Ask GitHub what exists.
   *
   * Deliberately not `releases/latest`: that endpoint answers `v0.3.0`, a
   * release carrying one text file, because every real build is flagged as a
   * prerelease and is therefore filtered out of "latest". One unauthenticated
   * request, only ever on a button press -- the limit is 60/hour and a button
   * cannot exhaust it.
   */
  async fetchReleases(signal?: AbortSignal): Promise<Release[]> {
    const res = await fetch(RELEASES, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Karen" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 403
          ? "GitHub is rate-limiting this machine. Try again in an hour."
          : `GitHub answered ${res.status} ${res.statusText}.`,
      );
    }
    return (await res.json()) as Release[];
  }

  async installedBuilds(): Promise<InstalledBuild[]> {
    const root = join(buildDir("x", "y"), "..");
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const out: InstalledBuild[] = [];
    for (const id of names) {
      const dir = join(root, id);
      const binary = await findExecutable(dir, "llama-server");
      if (!binary) continue;
      const dash = id.lastIndexOf("-");
      out.push({
        id,
        tag: id.slice(0, dash),
        backend: id.slice(dash + 1) as Backend,
        dir,
        binary,
        devices: [],
      });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  }

  async activeBuild(): Promise<InstalledBuild | undefined> {
    const builds = await this.installedBuilds();
    return builds.find((b) => b.id === this.#config.activeBuild) ?? builds[0];
  }

  /**
   * Switch to a build that is already on disk.
   *
   * Builds install side by side and never overwrite each other, so a bad
   * update is recoverable without another download -- but only if something
   * can select the older one, which until now nothing could. The server is
   * stopped first: it is a running process holding the old binary open, and
   * "the active build changed" is not a thing a loaded model notices.
   */
  async activate(id: string): Promise<InstalledBuild> {
    const build = (await this.installedBuilds()).find((b) => b.id === id);
    if (!build) throw new Error(`${id} is not installed.`);
    await this.stopServer();
    await this.update({ activeBuild: build.id, backendOverride: build.backend });
    return build;
  }

  /**
   * Remove a build's files. Refuses the active one.
   *
   * Each build is 30-500 MB and they accumulate one per update, so something
   * has to be able to remove them; refusing the active one means the only way
   * to end up with none is to ask for that explicitly.
   */
  async removeBuild(id: string): Promise<void> {
    if (id === (await this.activeBuild())?.id) {
      throw new Error("That is the build in use. Switch to another one first.");
    }
    const build = (await this.installedBuilds()).find((b) => b.id === id);
    if (!build) return;
    /*
     * A server started before an update is still executing the OLD build's
     * binary -- switching the active build does not restart a loaded model --
     * so the build being removed can be the one currently running. Unlinking an
     * open file is harmless on Unix and fails outright on Windows, so stop it
     * rather than rely on which of those two this is.
     */
    if (this.#serverBinary?.startsWith(build.dir)) await this.stopServer();
    await rm(build.dir, { recursive: true, force: true });
    this.#emit();
  }

  /**
   * Download, unpack and probe one build.
   *
   * The new build is installed alongside whatever is already there and only
   * becomes active once its probe succeeds, so an update cannot leave the app
   * unable to start a model. A build whose probe finds no accelerator is still
   * installed -- it is a working CPU runtime -- but the caller is told, and can
   * fall back.
   */
  async installBuild(
    release: Release,
    backend: Backend,
    signal?: AbortSignal,
  ): Promise<{ build: InstalledBuild; devices: Device[]; accelerated: boolean }> {
    const target = { platform: process.platform, arch: process.arch, backend };
    const asset = pickAsset(release, target);
    if (!asset) {
      throw new Error(
        `llama.cpp publishes no ${backend} build for ${process.platform}/${process.arch}. ` +
          `Choose a different backend in Settings.`,
      );
    }

    const id = `${release.tag_name}-${backend}`;
    const dir = buildDir(release.tag_name, backend);
    const staging = join(stagingDir(), id);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    const fetchAsset = async (a: ReleaseAsset): Promise<string> => {
      const path = join(staging, a.name);
      this.#setPhase({ kind: "downloading", what: a.name, receivedBytes: 0, bytesPerSecond: 0 });
      const digest = sha256Of(a);
      await downloadFile(a.browser_download_url, path, {
        ...(digest ? { sha256: digest } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (p) =>
          this.#setPhase({
            kind: "downloading",
            what: a.name,
            receivedBytes: p.receivedBytes,
            ...(p.totalBytes ? { totalBytes: p.totalBytes } : {}),
            bytesPerSecond: p.bytesPerSecond,
          }),
      });
      return path;
    };

    const archives = [await fetchAsset(asset)];
    // Windows CUDA ships its toolkit DLLs separately and will not start without
    // them, so the pair is downloaded as one unit or not at all.
    const cudart = pickCudart(release, asset);
    if (cudart) archives.push(await fetchAsset(cudart));

    this.#setPhase({ kind: "extracting", what: release.tag_name });
    const unpacked = join(staging, "unpacked");
    for (const archive of archives) await extractArchive(archive, unpacked);

    const binary = await findExecutable(unpacked, "llama-server");
    if (!binary) throw new Error("the downloaded archive contains no llama-server binary.");

    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, ".."), { recursive: true });
    await rename(unpacked, dir);
    await rm(staging, { recursive: true, force: true });

    const installed = (await this.installedBuilds()).find((b) => b.id === id);
    if (!installed) throw new Error("the build did not install correctly.");

    this.#setPhase({ kind: "probing", what: id });
    const devices = parseDevices(await listDevices(installed.binary));
    installed.devices = devices;
    this.#setPhase({ kind: "idle" });

    return { build: installed, devices, accelerated: hasAccelerator(devices) };
  }

  /**
   * The whole first-run path: pick a backend, install it, and fall back to CPU
   * if the probe says the accelerated build found nothing.
   */
  async setUp(signal?: AbortSignal): Promise<{ build: InstalledBuild; devices: Device[]; note: string }> {
    await this.detect();
    const releases = await this.fetchReleases(signal);
    const pinned = releases.find((r) => r.tag_name === BASELINE_BUILD);
    const release = pinned ?? newestBuild(releases);
    if (!release) throw new Error("no llama.cpp build releases were found.");

    const { backend, reason } = this.suggestion();
    let result = await this.installBuild(release, backend, signal);
    let note = reason;

    if (!result.accelerated && backend !== "cpu" && backend !== "metal") {
      // The guess was wrong -- a card with no working driver, most likely. CPU
      // always works, and finding this out now is the point of probing.
      note =
        `The ${backend} build did not find a usable GPU on this machine, so Karen installed ` +
        `the processor build instead. This is usually a missing or outdated graphics driver.`;
      result = await this.installBuild(release, "cpu", signal);
    }

    await this.update({ activeBuild: result.build.id });
    return { build: result.build, devices: result.devices, note };
  }

  /* -------------------------------------------------------------- models --- */

  machine(devices: Device[]): { vramBytes?: number; ramBytes: number } {
    const vram = largestDeviceBytes(devices);
    return { ...(vram !== undefined ? { vramBytes: vram } : {}), ramBytes: totalmem() };
  }

  /** Models we downloaded, plus anything found in another app's store. */
  async listModels(devices: Device[] = []): Promise<LocalModel[]> {
    const fs: WalkFs = {
      async readdir(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      },
      async size(path) {
        return (await stat(path)).size;
      },
    };

    const ours = await scanStore({ label: "Karen", dir: this.#config.modelsDir, depth: 3 }, fs);
    const borrowed: FoundModel[] = [];
    for (const store of knownStores(homedir())) {
      borrowed.push(...(await scanStore(store, fs)));
    }

    const machine = this.machine(devices);
    const rows: LocalModel[] = [];
    for (const found of dedupeFound([...ours, ...borrowed])) {
      const shape = await this.readShape(found.path).catch(() => undefined);
      rows.push({
        path: found.path,
        name: found.name,
        size: found.size,
        source: found.source,
        ...(shape ? { shape } : {}),
        fit: fitModel(found.size, machine, {
          ...(shape ? { shape } : {}),
          context: this.#config.contextSize ?? 8192,
        }),
      });
    }
    return rows;
  }

  /** Read a local GGUF's header. Cheap: only the first few megabytes are touched. */
  async readShape(path: string, bytes = 4 * 1024 * 1024): Promise<ModelShape> {
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return modelShape(parseGguf(buf.subarray(0, bytesRead)));
    } finally {
      await handle.close();
    }
  }

  /**
   * The header of a model that has not been downloaded yet.
   *
   * A Range request for the first few megabytes, which is what makes it
   * possible to say "this needs 19 GB with your context settings" *before*
   * someone commits to the download rather than after.
   */
  async readRemoteShape(url: string, token?: string): Promise<ModelShape | undefined> {
    try {
      const res = await fetch(url, {
        headers: {
          range: "bytes=0-4000000",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok && res.status !== 206) return undefined;
      return modelShape(parseGguf(new Uint8Array(await res.arrayBuffer())));
    } catch {
      return undefined;
    }
  }

  largestContextFor(size: number, devices: Device[], shape?: ModelShape): number | undefined {
    return largestContext(size, this.machine(devices), shape);
  }

  async deleteModel(path: string): Promise<void> {
    // Only ever inside our own directory. Another application's files are
    // scanned, never managed -- deleting them would be indefensible.
    const root = this.#config.modelsDir;
    const { resolve } = await import("node:path");
    const full = resolve(path);
    if (!full.startsWith(resolve(root) + "/") && !full.startsWith(resolve(root) + "\\")) {
      throw new Error("That model is managed by another application, so Karen will not delete it.");
    }
    await rm(full, { force: true });
    this.#emit();
  }

  /* -------------------------------------------------------------- running -- */

  async startServer(modelPath?: string): Promise<ServerStatus> {
    const build = await this.activeBuild();
    if (!build) throw new Error("No llama.cpp runtime is installed yet.");
    const model = modelPath ?? this.#config.activeModel;
    if (!model) throw new Error("No model has been chosen.");
    // Re-checked every launch: a path into another app's store may be gone,
    // and "model not found" six weeks later is the failure that causes.
    await stat(model).catch(() => {
      throw new Error(`That model file is no longer at ${model}. It may have been moved or deleted.`);
    });
    this.#serverBinary = build.binary;
    return this.#server.start({
      binary: build.binary,
      modelPath: model,
      ...(this.#config.contextSize !== undefined ? { contextSize: this.#config.contextSize } : {}),
    });
  }

  /**
   * The endpoint chat should use, or undefined to fall back to the user's own.
   *
   * Only while the server is actually ready: pointing at a port that is not
   * listening produces a connection error where "you have not started a model"
   * is the truth.
   */
  chatEndpoint(): { baseUrl: string; apiKey: string } | undefined {
    const status = this.#server.status;
    if (!this.#config.useForChat || status.state !== "ready" || !status.baseUrl) return undefined;
    return { baseUrl: status.baseUrl, apiKey: this.#server.apiKey };
  }

  async stopServer(): Promise<void> {
    await this.#server.stop();
    this.#serverBinary = undefined;
  }

  killNow(): void {
    this.#server.killNow();
  }
}
