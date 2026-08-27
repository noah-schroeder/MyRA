/**
 * The runtime, exposed to the window.
 *
 * Everything here is a thin pass-through to Lemonade. That is deliberate and it
 * is most of the value of the change: the handlers this file used to carry --
 * release listings, build installs, device probes, GGUF planning, per-model
 * launch flags -- were Karen reimplementing an inference stack, and each one
 * was a place for the two halves to disagree about what was installed.
 *
 * Every handler answers `{ ok }` rather than throwing across the bridge, so a
 * backend that is down shows up as a message in the pane rather than as an
 * unhandled rejection in the main process.
 */

import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";

import type { RuntimeManager } from "./manager.ts";

export function installRuntimeIpc(
  runtime: RuntimeManager,
  send: (channel: string, payload?: unknown) => void,
  _hfToken: () => Promise<string | undefined>,
  _window: () => BrowserWindow | undefined,
): void {
  const state = (): unknown => ({
    config: runtime.config,
    lemonade: {
      state: runtime.lemonade.status.state,
      error: runtime.lemonade.status.error,
      loaded: runtime.lemonade.status.health?.modelLoaded,
      log: runtime.lemonade.status.log.slice(-40),
    },
  });

  runtime.onChange(() => send("karen:runtime", state()));

  ipcMain.handle("karen:runtime-state", () => state());

  ipcMain.handle("karen:runtime-config", async (_e, patch: Record<string, unknown>) =>
    runtime.update(patch));

  /**
   * Bring the backend up, installing it on first use.
   *
   * Progress is pushed rather than returned: the first call downloads Lemonade
   * and then, usually, an engine of several hundred megabytes, and a promise
   * that resolves at the end of that says nothing while it matters.
   */
  ipcMain.handle("karen:lemonade-ensure", async () => {
    try {
      await runtime.ensureLemonade({
        onPhase: (what) => send("karen:runtime-phase", { what }),
        onProgress: (p) => send("karen:runtime-download", {
          what: p.what,
          receivedBytes: p.receivedBytes,
          ...(p.totalBytes ? { totalBytes: p.totalBytes } : {}),
          bytesPerSecond: p.bytesPerSecond,
        }),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-info", async () => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, info: await runtime.api.systemInfo() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-install-backend", async (_e, recipe: string, backend: string) => {
    try {
      await runtime.ensureLemonade();
      await runtime.api.installBackend(String(recipe), String(backend));
      return { ok: true, info: await runtime.api.systemInfo() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-downloads", async () => {
    try {
      return { ok: true, jobs: await runtime.api.downloads() };
    } catch {
      // Polled on a timer; a failure here is not worth a dialog.
      return { ok: false, jobs: [] };
    }
  });

  ipcMain.handle("karen:lemonade-catalog", async () => {
    try {
      return { ok: true, catalog: await runtime.catalog() };
    } catch (err) {
      return { ok: false, error: (err as Error).message, catalog: [] };
    }
  });

  ipcMain.handle("karen:lemonade-models", async () => {
    try {
      await runtime.ensureLemonade();
      return {
        ok: true,
        models: await runtime.api.listModels(),
        loaded: runtime.lemonade.status.health?.modelLoaded,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message, models: [] };
    }
  });

  ipcMain.handle("karen:lemonade-load", async (_e, name: string) => {
    try {
      await runtime.loadModel(String(name));
      return { ok: true, loaded: runtime.lemonade.status.health?.modelLoaded };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-unload", async () => {
    try {
      await runtime.unloadModel();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-pull", async (_e, name: string, checkpoint?: string) => {
    try {
      await runtime.ensureLemonade();
      await runtime.api.pullModel(String(name), checkpoint ? String(checkpoint) : undefined);
      return { ok: true, models: await runtime.api.listModels() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:lemonade-stop", async () => {
    await runtime.stop();
    return { ok: true };
  });
}
