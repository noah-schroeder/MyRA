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

import {
  isEnabled,
  readSource,
  REGISTRY_LABEL,
  type RegistrySource,
} from "../../core/runtime/registry.ts";
import type { RuntimeManager } from "./manager.ts";
import { browseHuggingFace, repoFiles } from "./hfClient.ts";
import type { BrowseSort } from "../../core/runtime/hfBrowse.ts";

/**
 * The daemon's own words, without the plumbing around them.
 *
 * The client wraps a failure as `/models/x/options failed (400): {"error":"…"}`,
 * which is right for a log and useless in a form field beside the control that
 * caused it.
 */
function reasonFrom(err: unknown): string {
  const message = (err as Error).message ?? "";
  const inner = /\{"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  return (inner?.[1] ?? message.replace(/^\/\S+\s+failed\s+\(\d+\):\s*/, "")).trim() || message;
}

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
      /* What the bar needs to say something true while a load is in flight,
         and to prove afterwards that it really loaded. */
      loading: runtime.loadingModel,
      active: runtime.lemonade.status.health?.active,
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
        /* Where each found model came from, so the list can say "LM Studio"
           rather than leaving a person to recognise their own filenames. */
        foreign: runtime.foreignModels,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message, models: [] };
    }
  });

  /* Lemonade reads `extra_models_dir` once at startup, so picking up a model
     added in LM Studio a minute ago means restarting the daemon. Explicit
     rather than automatic: it drops whatever is loaded. */
  ipcMain.handle("karen:lemonade-rescan", async () => {
    try {
      return { ok: true, found: await runtime.rescanModels() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
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

  /**
   * Search one registry.
   *
   * One call per registry rather than one call that searches both: a combined
   * call would have to decide what to do when one registry answers and the
   * other does not, and the honest answer -- show what came back and say which
   * one failed -- is only possible if the caller can see the two separately.
   */
  /**
   * The one place a disabled registry is actually stopped.
   *
   * Checked here rather than only in the pane because the renderer is not the
   * security boundary: a stale window, a restored state, or a future caller
   * would otherwise reach ModelScope, and "Karen never contacts it" has to be
   * true of the process that holds the socket, not of one screen.
   */
  const refuse = (source: RegistrySource): { ok: false; error: string } => ({
    ok: false,
    error: `${REGISTRY_LABEL[source]} is turned off in this build of Karen.`,
  });

  /**
   * Browse the registry itself, rather than through Lemonade's one-knob search.
   *
   * The fields are picked out and retyped rather than forwarded: this handler
   * is the boundary between a renderer and a host on the internet, and the
   * only thing that should cross it is a small set of values whose shape is
   * known here. `browseParams` decides what the query string says, so no input
   * from the window can reach the URL except as a value in a named field.
   */
  /** The files in one repository, for the kinds `/pull/variants` cannot describe. */
  ipcMain.handle("karen:hf-files", async (_e, repo: unknown) => {
    try {
      return { ok: true, files: await repoFiles(String(repo ?? "")) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:hf-browse", async (_e, q: unknown) => {
    const raw = (q ?? {}) as Record<string, unknown>;
    const pick = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === "string" && v ? v.slice(0, 200) : undefined;
    };
    try {
      return {
        ok: true,
        result: await browseHuggingFace({
          ...(pick("query") ? { query: pick("query") } : {}),
          ...(pick("author") ? { author: pick("author") } : {}),
          ...(pick("kind") ? { kind: pick("kind") } : {}),
          ...(pick("sort") ? { sort: pick("sort") as BrowseSort } : {}),
          ggufOnly: raw["ggufOnly"] === true,
        }),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "karen:registry-variants",
    async (_e, checkpoint: string, source: RegistrySource) => {
      if (!isEnabled(readSource(source))) return refuse(readSource(source));
      try {
        await runtime.ensureLemonade();
        return { ok: true, variants: await runtime.api.repoVariants(String(checkpoint), readSource(source)) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /**
   * Download a specific quantisation from a specific registry.
   *
   * Separate from `lemonade-pull`, which pulls a catalogue entry by name. This
   * one carries a checkpoint and a source chosen in the search UI, and both
   * have to survive the trip: the source decides which country the bytes come
   * from.
   */
  ipcMain.handle(
    "karen:registry-pull",
    async (_e, name: string, checkpoint: string, source: RegistrySource, recipe?: string) => {
      if (!isEnabled(readSource(source))) return refuse(readSource(source));
      try {
        await runtime.ensureLemonade();
        await runtime.api.pullModel(
          String(name),
          String(checkpoint),
          recipe ? String(recipe) : "llamacpp",
          readSource(source),
        );
        return { ok: true, models: await runtime.api.listModels() };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /* ---------------------------------------------- per-model load options -- */

  /**
   * Read, write and reset one model's load settings.
   *
   * The daemon's own validation is the only validation: it answers
   * `'ctx_size' must be a positive whole number, or -1 to size it
   * automatically` and `Unknown option 'x' for recipe 'llamacpp'`, and those
   * sentences are better than anything Karen would compose, as well as being
   * guaranteed to match what actually gets rejected. So errors are passed
   * through rather than replaced.
   */
  ipcMain.handle("karen:model-options", async (_e, name: string) => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, options: await runtime.api.modelOptions(String(name)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "karen:model-options-set",
    async (_e, name: string, patch: Record<string, unknown>) => {
      try {
        await runtime.ensureLemonade();
        const options = await runtime.api.setModelOptions(String(name), patch ?? {});
        return { ok: true, options };
      } catch (err) {
        return { ok: false, error: reasonFrom(err) };
      }
    },
  );

  ipcMain.handle("karen:model-options-reset", async (_e, name: string) => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, options: await runtime.api.resetModelOptions(String(name)) };
    } catch (err) {
      return { ok: false, error: reasonFrom(err) };
    }
  });

  ipcMain.handle("karen:lemonade-stop", async () => {
    await runtime.stop();
    return { ok: true };
  });
}
