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

import { newestBuild, type Backend, type Release } from "../../core/runtime/assets.ts";
import type { Device } from "../../core/runtime/devices.ts";
import {
  downloadUrl, groupFiles, infoUrl, parseTree, quantOf, searchUrl, treeUrl,
  GatedError, type HfModel, type ModelFile,
} from "../../core/runtime/hf.ts";
import { fitModel } from "../../core/runtime/fit.ts";
import { downloadFile } from "./download.ts";
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
  /** Devices from the most recent probe, so model sizing has a VRAM figure. */
  let devices: Device[] = [];
  /** Cancels whatever long download is in flight. */
  let inFlight: AbortController | undefined;

  const push = (): void => {
    void snapshot(runtime).then((state) => send("karen:runtime", state));
  };
  runtime.onChange(push);

  ipcMain.handle("karen:runtime-state", async () => ({ ...(await snapshot(runtime)), devices }));

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
      devices = result.devices;
      return { ok: true, note: result.note, devices, build: result.build.id };
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

  ipcMain.handle("karen:runtime-install", async (_e, tag: string, backend: Backend) => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const releases = await runtime.fetchReleases(inFlight.signal);
      const release = releases.find((r: Release) => r.tag_name === tag) ?? newestBuild(releases);
      if (!release) return { ok: false, error: "That build no longer exists upstream." };

      const result = await runtime.installBuild(release, backend, inFlight.signal);
      devices = result.devices;
      // Only now does it become the active one: a build that failed to install
      // or probe must never displace one that works.
      await runtime.update({ activeBuild: result.build.id, backendOverride: backend });
      return { ok: true, devices, accelerated: result.accelerated, build: result.build.id };
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
    devices = parseDevices(await listDevices(build.binary));
    return { ok: true, devices };
  });

  ipcMain.handle("karen:runtime-cancel", async () => {
    inFlight?.abort();
    inFlight = undefined;
    return { ok: true };
  });

  /* ------------------------------------------------------------- models --- */

  ipcMain.handle("karen:runtime-models", async (): Promise<LocalModel[]> => runtime.listModels(devices));

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
      const machine = runtime.machine(devices);
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
          fit: fitModel(f.size, machine, { context: runtime.config.contextSize ?? 8192 }),
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
    const machine = runtime.machine(devices);
    return {
      shape,
      fit: fitModel(size, machine, {
        ...(shape ? { shape } : {}),
        context: runtime.config.contextSize ?? 8192,
      }),
      largestContext: runtime.largestContextFor(size, devices, shape),
    };
  });

  ipcMain.handle("karen:hf-download", async (_e, repo: string, parts: { path: string; size: number; sha256?: string }[]) => {
    inFlight?.abort();
    inFlight = new AbortController();
    const signal = inFlight.signal;
    const token = await hfToken();
    const dir = join(runtime.config.modelsDir, repo.replace("/", "__"));

    try {
      let done = 0;
      const total = parts.reduce((n, p) => n + p.size, 0);
      for (const part of parts) {
        const name = part.path.slice(part.path.lastIndexOf("/") + 1);
        await downloadFile(downloadUrl(repo, part.path), join(dir, name), {
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
