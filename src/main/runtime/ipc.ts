/**
 * The runtime's window onto the renderer.
 *
 * Everything expensive is push-based: a download reports progress by emitting
 * state rather than by being polled, because a renderer polling a 30 GB
 * download is how progress bars come to stutter.
 *
 * Nothing here is reachable by the model. These are user actions -- a button in
 * Settings -- and there is deliberately no tool that can install a runtime,
 * download a model, or start a process.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";

import {
  availableBackends, newestBuild, type Backend, type Release,
} from "../../core/runtime/assets.ts";
import {
  downloadUrl, groupFiles, infoUrl, parseTree, quantOf, repoId, searchUrl, treeUrl,
  GatedError, type HfModel, type ModelFile,
} from "../../core/runtime/hf.ts";
import { fitModel } from "../../core/runtime/fit.ts";
import { explainNoCudaDevice } from "../../core/runtime/nvidia.ts";
import { downloadFile } from "./download.ts";
import type { LaunchSettings } from "../../core/runtime/launch.ts";
import { BASELINE_BUILD, RuntimeManager, type LocalModel } from "./manager.ts";

/** One place that decides what the renderer knows. */
async function snapshot(runtime: RuntimeManager): Promise<Record<string, unknown>> {
  const build = await runtime.activeBuild();
  const builds = await runtime.installedBuilds();
  return {
    config: runtime.config,
    phase: runtime.phase,
    server: runtime.server.status,
    suggestion: runtime.suggestion(),
    activeBuild: build ? { id: build.id, tag: build.tag, backend: build.backend } : undefined,
    builds: builds.map((b) => ({ id: b.id, tag: b.tag, backend: b.backend })),
    baseline: BASELINE_BUILD,
  };
}

export function installRuntimeIpc(
  runtime: RuntimeManager,
  send: (channel: string, payload?: unknown) => void,
  hfToken: () => Promise<string | undefined>,
  _window: () => BrowserWindow | undefined,
): void {
  /** Cancels whatever long download is in flight. */
  let inFlight: AbortController | undefined;

  const push = (): void => {
    // Devices and the machine figures ride along, because every consumer of
    // this state wants them: the hub sizes models against VRAM, and a pushed
    // update that dropped them would blank the numbers on every re-render.
    void snapshot(runtime).then((state) =>
      send("karen:runtime", { ...state, devices: runtime.devices, machine: runtime.machine(runtime.devices) }),
    );
  };
  runtime.onChange(push);

  ipcMain.handle("karen:runtime-state", async () => ({
    ...(await snapshot(runtime)),
    devices: runtime.devices,
    machine: runtime.machine(runtime.devices),
    /*
     * Which backends this machine can actually be given.
     *
     * Sent from here because only the main process knows the platform. The
     * Runtime pane used to carry its own hardcoded list of all five, so it
     * offered Metal on Linux and described CUDA as "Windows only" -- which,
     * once Linux CUDA started working, was a label telling the user not to
     * pick the thing they wanted.
     */
    backends: availableBackends(process.platform, process.arch),
  }));

  /*
   * Why a build found no GPU, asked only when one did not.
   *
   * Separate from runtime-state because it shells out to nvidia-smi, and the
   * state is read on every render. A diagnosis nobody asked for is not worth a
   * process launch.
   */
  ipcMain.handle("karen:runtime-diagnose", async () => {
    /*
     * Probe again if nothing is remembered.
     *
     * The log is held in memory, so it is empty on every fresh launch -- and
     * the person who most needs this is looking at an already-installed build
     * after a restart, which is exactly when there would have been nothing to
     * show. The probe takes a second and prints the one thing that explains the
     * failure, so it is worth re-running rather than reporting its absence.
     */
    if (!runtime.probeLog) {
      const { listDevices } = await import("./server.ts");
      const build = await runtime.activeBuild();
      if (build) runtime.setProbeLog(await listDevices(build.binary));
    }
    const info = await runtime.nvidia();
    return {
      nvidia: info,
      probeLog: runtime.probeLog,
      explanation: explainNoCudaDevice(info),
    };
  });

  ipcMain.handle("karen:runtime-config", async (_e, patch: Record<string, unknown>) =>
    runtime.update(patch),
  );

  ipcMain.handle("karen:runtime-detect", async () => {
    const gpu = await runtime.detect();
    return { gpu, suggestion: runtime.suggestion() };
  });

  /**
   * First-run setup: detect, install, probe, fall back to CPU if the probe
   * disagrees with the guess.
   */
  ipcMain.handle("karen:runtime-setup", async () => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const result = await runtime.setUp(inFlight.signal);
      runtime.setDevices(result.devices);
      return { ok: true, note: result.note, devices: runtime.devices, build: result.build.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      inFlight = undefined;
      push();
    }
  });

  /**
   * The update button. No background checks anywhere in this app -- this runs
   * when, and only when, someone presses it.
   */
  ipcMain.handle("karen:runtime-check-updates", async () => {
    try {
      const releases = await runtime.fetchReleases();
      const newest = newestBuild(releases);
      const current = (await runtime.activeBuild())?.tag;
      return {
        ok: true,
        current,
        newest: newest?.tag_name,
        publishedAt: newest?.published_at,
        /* Upstream ships several builds a day, so "newer exists" is not the
         * same recommendation it would be for a normal release feed, and the
         * UI says so rather than implying the user is behind. */
        behind: current && newest ? Number(newest.tag_name.slice(1)) - Number(current.slice(1)) : 0,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Install a newer build. The button that says "update" now updates.
   *
   * Deliberately the same code path as any other install -- download, verify,
   * unpack, probe, and only then switch -- because an update is exactly that
   * with the tag filled in for you. The previous build stays on disk, so if the
   * nightly you just moved to is broken, the fix is one click and no download.
   */
  ipcMain.handle("karen:runtime-update", async (_e, tag?: string) => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const current = await runtime.activeBuild();
      if (!current) return { ok: false, error: "No runtime is installed yet." };

      const releases = await runtime.fetchReleases(inFlight.signal);
      const release = tag
        ? releases.find((r: Release) => r.tag_name === tag)
        : newestBuild(releases);
      if (!release) {
        return { ok: false, error: "That build is no longer offered upstream." };
      }
      if (release.tag_name === current.tag) {
        return { ok: true, unchanged: true, build: current.id };
      }

      const backend = runtime.config.backendOverride ?? current.backend;
      const result = await runtime.installBuild(release, backend, inFlight.signal);
      // The old build is untouched on disk; the pointer moves only after the
      // new one has proved it starts, and the running model is unloaded so the
      // engine the app reports is the engine it is running.
      const { unloaded } = await runtime.useBuild(result.build.id);
      runtime.setDevices(result.devices);
      return {
        ok: true,
        build: result.build.id,
        from: current.id,
        devices: runtime.devices,
        accelerated: result.accelerated,
        ...(unloaded ? { unloaded } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      inFlight = undefined;
      push();
    }
  });

  /** Roll back, or move between backends already downloaded. No network. */
  ipcMain.handle("karen:runtime-activate", async (_e, id: string) => {
    try {
      const { build, unloaded } = await runtime.useBuild(id, true);
      const { listDevices } = await import("./server.ts");
      const { parseDevices } = await import("../../core/runtime/devices.ts");
      runtime.setDevices(parseDevices(await listDevices(build.binary)));
      return { ok: true, build: build.id, devices: runtime.devices, ...(unloaded ? { unloaded } : {}) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      push();
    }
  });

  ipcMain.handle("karen:runtime-remove-build", async (_e, id: string) => {
    try {
      await runtime.removeBuild(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:runtime-install", async (_e, tag: string, backend: Backend) => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const releases = await runtime.fetchReleases(inFlight.signal);
      const release = releases.find((r: Release) => r.tag_name === tag) ?? newestBuild(releases);
      if (!release) return { ok: false, error: "That build no longer exists upstream." };

      const result = await runtime.installBuild(release, backend, inFlight.signal);
      runtime.setDevices(result.devices);
      // Only now does it become the active one: a build that failed to install
      // or probe must never displace one that works.
      const { unloaded } = await runtime.useBuild(result.build.id, true);
      return {
        ok: true,
        devices: runtime.devices,
        accelerated: result.accelerated,
        build: result.build.id,
        ...(unloaded ? { unloaded } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      inFlight = undefined;
      push();
    }
  });

  ipcMain.handle("karen:runtime-probe", async () => {
    const build = await runtime.activeBuild();
    if (!build) return { ok: false, error: "No runtime is installed." };
    const { listDevices } = await import("./server.ts");
    const { parseDevices } = await import("../../core/runtime/devices.ts");
    runtime.setDevices(parseDevices(await listDevices(build.binary)));
    return { ok: true, devices: runtime.devices };
  });

  ipcMain.handle("karen:runtime-cancel", async () => {
    inFlight?.abort();
    inFlight = undefined;
    return { ok: true };
  });

  /* ------------------------------------------------------------- models --- */

  ipcMain.handle("karen:runtime-models", async (): Promise<LocalModel[]> => runtime.listModels(runtime.devices));

  /**
   * What a configuration costs, without committing to it.
   *
   * The renderer sends the controls' current position and gets back the memory
   * figure and the exact command line. Nothing is stored, so dragging a slider
   * does not write to disk on every frame -- and the number on screen comes
   * from the same function that builds the flags, which is the property that
   * was missing before.
   */
  ipcMain.handle("karen:runtime-plan", async (_e, path: string, override?: Record<string, unknown>) =>
    runtime.plan(path, runtime.devices, override as Partial<LaunchSettings> | undefined),
  );

  ipcMain.handle("karen:runtime-set-launch", async (_e, path: string, patch: Record<string, unknown>) => {
    try {
      const settings = await runtime.setLaunchSettings(path, patch as Partial<LaunchSettings>);
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:runtime-delete-model", async (_e, path: string) => {
    try {
      await runtime.deleteModel(path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:runtime-start", async (_e, modelPath?: string) => {
    try {
      if (modelPath) await runtime.update({ activeModel: modelPath });
      const status = await runtime.startServer(modelPath);
      return { ok: status.state === "ready", status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:runtime-stop", async () => {
    await runtime.stopServer();
    return { ok: true };
  });

  /* --------------------------------------------------------- huggingface -- */

  ipcMain.handle("karen:hf-search", async (_e, query: string, sort?: string) => {
    try {
      const token = await hfToken();
      const res = await fetch(searchUrl(query, { ...(sort ? { sort } : {}) }), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, error: `HuggingFace answered ${res.status}.` };
      const models = (await res.json()) as HfModel[];
      return {
        ok: true,
        models: models.map((m) => ({
          id: m.id,
          downloads: m.downloads,
          likes: m.likes,
          gated: m.gated ?? false,
          /* Tags carry the things a person actually chooses on -- the base
           * architecture, the licence, whether it is an instruct tune -- and
           * are shown as text, never interpreted. */
          ...(m.tags ? { tags: m.tags.slice(0, 12) } : {}),
          ...(m.lastModified ? { lastModified: m.lastModified } : {}),
        })),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:hf-files", async (_e, repo: string) => {
    try {
      const token = await hfToken();
      const headers = token ? { authorization: `Bearer ${token}` } : {};

      const info = await fetch(infoUrl(repo), { headers, signal: AbortSignal.timeout(20_000) });
      if (info.ok) {
        const meta = (await info.json()) as HfModel;
        // A gated repo needs a licence accepted on the website; a 401 later
        // would read as a broken app rather than a step the user has to take.
        if (meta.gated && !token) return { ok: false, error: new GatedError(repo).message, gated: true };
      }

      const res = await fetch(treeUrl(repo), { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: new GatedError(repo).message, gated: true };
        }
        return { ok: false, error: `HuggingFace answered ${res.status}.` };
      }

      const files = groupFiles(parseTree(await res.json()));
      const machine = runtime.machine(runtime.devices);
      return {
        ok: true,
        files: files.map((f) => ({
          label: f.label,
          entry: f.entry,
          size: f.size,
          /* The parts themselves, with their hashes -- not a count. A sharded
           * model is useless in part, and downloading only `entry` would fetch
           * one fifth of a model and verify none of it. */
          parts: f.parts.map((part) => ({
            path: part.path,
            size: part.size,
            ...(part.sha256 ? { sha256: part.sha256 } : {}),
          })),
          quant: quantOf(f.entry),
          fit: fitModel(f.size, machine, { context: 8192 }),
        })),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Read the header of a model on the Hub before downloading it.
   *
   * One Range request. Turns "18 GB, hope it fits" into a real answer, which
   * matters most for exactly the people who cannot afford to be wrong about it.
   */
  ipcMain.handle("karen:hf-inspect", async (_e, repo: string, entry: string, size: number) => {
    const token = await hfToken();
    const shape = await runtime.readRemoteShape(downloadUrl(repo, entry), token);
    const machine = runtime.machine(runtime.devices);
    return {
      shape,
      fit: fitModel(size, machine, {
        ...(shape ? { shape } : {}),
        context: 8192,
      }),
      largestContext: runtime.largestContextFor(size, runtime.devices, shape),
    };
  });

  ipcMain.handle("karen:hf-download", async (_e, repo: string, parts: { path: string; size: number; sha256?: string }[]) => {
    inFlight?.abort();
    inFlight = new AbortController();
    const signal = inFlight.signal;
    const token = await hfToken();
    // Validated, then flattened: `repoId` guarantees exactly one slash, so the
    // replace below cannot leave one behind for `join` to interpret.
    let id: string;
    try {
      id = repoId(repo);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const dir = join(runtime.config.modelsDir, id.replaceAll("/", "__"));

    try {
      let done = 0;
      const total = parts.reduce((n, p) => n + p.size, 0);
      for (const part of parts) {
        const name = part.path.slice(part.path.lastIndexOf("/") + 1);
        await downloadFile(downloadUrl(id, part.path), join(dir, name), {
          ...(part.sha256 ? { sha256: part.sha256 } : {}),
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          signal,
          onProgress: (p) =>
            send("karen:runtime-download", {
              what: name,
              receivedBytes: done + p.receivedBytes,
              totalBytes: total,
              bytesPerSecond: p.bytesPerSecond,
            }),
        });
        done += part.size;
      }
      send("karen:runtime-download", { what: "", receivedBytes: total, totalBytes: total, bytesPerSecond: 0 });
      const first = parts[0]!.path;
      return { ok: true, path: join(dir, first.slice(first.lastIndexOf("/") + 1)) };
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      send("karen:runtime-download", undefined);
      return { ok: false, error: aborted ? "Download cancelled." : (err as Error).message };
    } finally {
      inFlight = undefined;
    }
  });
}

export type { ModelFile };
