/**
 * The runtime, exposed to the window.
 *
 * Everything here is a thin pass-through to Lemonade. That is deliberate and it
 * is most of the value of the change: the handlers this file used to carry --
 * release listings, build installs, device probes, GGUF planning, per-model
 * launch flags -- were MyRA reimplementing an inference stack, and each one
 * was a place for the two halves to disagree about what was installed.
 *
 * Every handler answers `{ ok }` rather than throwing across the bridge, so a
 * backend that is down shows up as a message in the pane rather than as an
 * unhandled rejection in the main process.
 */

import type { BrowserWindow } from "electron";
import { ipcMain, shell } from "electron";

import {
  isEnabled,
  readSource,
  REGISTRY_LABEL,
  type RegistrySource,
} from "../../core/runtime/registry.ts";
import type { RuntimeManager } from "./manager.ts";
import { browseHuggingFace, repoCard, repoDetail } from "./hfClient.ts";
import { listedId, type BrowseSort } from "../../core/runtime/hfBrowse.ts";
import { prepareCard } from "../../core/runtime/modelCard.ts";
import { checkImageModel } from "../../core/runtime/imageModel.ts";
import { deleteModel } from "./modelDelete.ts";
import { Downloads } from "../downloads.ts";
import { pollForModel } from "../../core/downloads/download.ts";
import { learnFacts } from "./modelFacts.ts";

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
  hfToken: () => Promise<string | undefined>,
  _window: () => BrowserWindow | undefined,
  /**
   * Called when a local model has been loaded on purpose.
   *
   * The runtime knows nothing about which model the conversation is set to, and
   * should not: that lives in settings, and this file is a pass-through to
   * Lemonade. So it says what happened and lets the caller decide what it means.
   */
  onModelLoaded: () => Promise<void> = async () => {},
): void {
  /* The reader the daemon's own start resolves for a gated pull, or for
     every start once "always send my token" is on -- see `setHfToken`'s own
     comment for why this is a thunk rather than the secret itself. */
  runtime.setHfToken(hfToken);

  /*
   * The download registry, owned here because this is where the daemon is.
   *
   * Every transfer used to be an awaited IPC reply, so it existed only for as
   * long as the page that asked for it. Now the page asks for one and returns
   * immediately; the record lives here and is pushed to whatever is on screen.
   */
  const downloads = new Downloads({
    /* An empty checkpoint means "the name is one the daemon already has in
       its own catalogue", which is how the Recommended tab's rows arrive
       here. The recipe and the source go with the checkpoint and not
       without it: Lemonade resolves a registered name from its own entry,
       and a request that named a source alongside it would be asking the
       daemon to reconcile two answers to the same question. So a catalogue
       pull sends exactly `{model_name}`, byte for byte what the awaited
       handler this replaced sent. */
    pull: ({ name, checkpoint, source, recipe, signal, onProgress }) =>
      runtime.api.pullModel(
        name,
        checkpoint || undefined,
        recipe,
        checkpoint ? (source as RegistrySource) : undefined,
        onProgress,
        signal,
      ),
    remove: (name) => runtime.api.deleteModel(name),
    publish: (list) => send("myra:downloads", list),
    /* A finished download is a new entry in the model list, and the page
       showing that list has no other way to learn it arrived. */
    onFinished: (name) => {
      /*
       * Confirmed present before the page is told to look, not the instant
       * the transfer's own HTTP stream closes.
       *
       * That stream closing is a fact about the connection, and for a
       * repository pulled as several files it can only close once -- after
       * the last of them -- which is exactly the case that left "My models"
       * showing nothing for a model whose bytes were already on disk: the
       * daemon's own index had not caught up with what it had just finished
       * writing. `pollForModel` costs nothing in the ordinary case, where the
       * very first look already finds it.
       */
      /* The id the daemon reports, which is the pull's name without its
         required `user.` namespace -- see `listedId`. */
      const id = listedId(name);
      void pollForModel(id, () => runtime.api.listModels())
        .catch(() => undefined)
        .then(async (model) => {
          send("myra:models-changed");
          /*
           * The file MyRA just finished downloading, read before it is asked
           * about over the network -- `learnShapeFromFile` never overwrites a
           * shape this same read already recorded, and `learnFacts` below
           * never destroys one with no repository to check against (see
           * modelFacts.test.ts), so the order here is the safe one: the read
           * that needs no network first, then the one that does. Without
           * this, a model whose repository has a `config.json` never has its
           * GGUF header read at all until `#autoTuneLoad` does it lazily, on
           * the user's first load -- while the file was already on disk and
           * the user was already waiting to download it, not to load it.
           */
          await runtime.learnShape(id);
          /*
           * The one moment MyRA asks Hugging Face what this model is.
           *
           * Here rather than at load time, and here rather than on a timer:
           * the bytes have just come from the same host, the user is plainly
           * online, and they are waiting for this model anyway. A load must
           * never become a network request -- see the note in main/review.ts
           * about a question that started behaving like one.
           */
          void learnFacts(id, model?.checkpoint).catch(() => undefined);
        });
    },
  });
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
      /*
       * The model a message would actually go to, resolved exactly as
       * `chatEndpoint` resolves it. The bar used to name `activeModel`
       * directly, which is a record of what was loaded rather than of what
       * chat uses -- so a dictation left "Whisper-Large-v3-Turbo" sitting in
       * the conversation's model picker. One answer, computed once.
       */
      chat: runtime.chatModel(),
      /* Everything the daemon is holding, not just the one it touched last.
         The bars use it to say whether the model they name is actually in
         memory, and the menus to offer each one an eject of its own. */
      resident: runtime.lemonade.status.health?.loaded ?? [],
      log: runtime.lemonade.status.log.slice(-40),
    },
  });

  runtime.onChange(() => send("myra:runtime", state()));

  ipcMain.handle("myra:runtime-state", () => state());

  ipcMain.handle("myra:runtime-config", async (_e, patch: Record<string, unknown>) =>
    runtime.update(patch));

  /**
   * Bring the backend up, installing it on first use.
   *
   * Progress is pushed rather than returned: the first call downloads Lemonade
   * and then, usually, an engine of several hundred megabytes, and a promise
   * that resolves at the end of that says nothing while it matters.
   */
  ipcMain.handle("myra:lemonade-ensure", async () => {
    try {
      await runtime.ensureLemonade({
        onPhase: (what) => send("myra:runtime-phase", { what }),
        onProgress: (p) => send("myra:runtime-download", {
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

  ipcMain.handle("myra:lemonade-info", async () => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, info: await runtime.api.systemInfo() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:lemonade-install-backend", async (_e, recipe: string, backend: string) => {
    try {
      await runtime.ensureLemonade();
      await runtime.api.installBackend(String(recipe), String(backend));
      /* Before reporting success: on a system older than the engine build, a
         freshly installed engine cannot start, and the moment it was installed
         is the only moment anybody is watching. */
      await runtime.repairInstalledEngines();
      return { ok: true, info: await runtime.api.systemInfo() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Ask GitHub whether a newer engine build exists.
   *
   * Registered as its own channel rather than folded into `lemonade-info`,
   * because the two have different costs and different consequences:
   * `lemonade-info` is a loopback call the screen makes on every open, and
   * this one leaves the machine. Nothing calls it except the button.
   */
  ipcMain.handle("myra:engine-updates-check", async () => {
    try {
      return { ok: true, check: await runtime.checkEngineUpdates() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Which build each backend is on, and which one Lemonade shipped with. */
  ipcMain.handle("myra:engine-versions", async () => {
    try {
      return { ok: true, ...(await runtime.engineVersions()) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, pins: {}, shipped: {} };
    }
  });

  /**
   * Move one backend to a build, or -- with no version -- back to the shipped one.
   *
   * Returns the daemon's own view afterwards so the screen redraws from what
   * is on the disk rather than from what was asked for.
   */
  ipcMain.handle(
    "myra:engine-update",
    async (_e, recipe: string, backend: string, version?: string | null) => {
      try {
        const result = await runtime.updateEngine(
          String(recipe),
          String(backend),
          version ? String(version) : undefined,
          { onPhase: (what) => send("myra:runtime-phase", { what }) },
        );
        return { ok: true, ...result, info: await runtime.api.systemInfo() };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle("myra:lemonade-downloads", async () => {
    try {
      return { ok: true, jobs: await runtime.api.downloads() };
    } catch {
      // Polled on a timer; a failure here is not worth a dialog.
      return { ok: false, jobs: [] };
    }
  });

  ipcMain.handle("myra:lemonade-catalog", async () => {
    try {
      return { ok: true, catalog: await runtime.catalog() };
    } catch (err) {
      return { ok: false, error: (err as Error).message, catalog: [] };
    }
  });

  ipcMain.handle("myra:lemonade-models", async () => {
    try {
      await runtime.ensureLemonade();
      return {
        ok: true,
        /* Not `api.listModels()`: a model found in LM Studio gets `vision`
           added from the projector beside it, and the list on screen has to
           agree with the answer the composer gives an attached image. */
        models: await runtime.installedModels(),
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
  ipcMain.handle("myra:lemonade-rescan", async () => {
    try {
      return { ok: true, found: await runtime.rescanModels() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:lemonade-load", async (_e, name: string) => {
    try {
      await runtime.loadModel(String(name));
      await onModelLoaded();
      return { ok: true, loaded: runtime.lemonade.status.health?.modelLoaded };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:lemonade-unload", async () => {
    try {
      await runtime.unloadModel();
      return { ok: true };
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
   * would otherwise reach ModelScope, and "MyRA never contacts it" has to be
   * true of the process that holds the socket, not of one screen.
   */
  const refuse = (source: RegistrySource): { ok: false; error: string } => ({
    ok: false,
    error: `${REGISTRY_LABEL[source]} is turned off in this build of MyRA.`,
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
  /**
   * One repository: its files, and the facts a person chooses on.
   *
   * The file list is here because `/pull/variants` cannot describe anything but
   * GGUF, ONNX RyzenAI and Lemonade's own collections. The licence, the base
   * model and the context length come from the same response and used to be
   * thrown away.
   */
  ipcMain.handle("myra:hf-detail", async (_e, repo: unknown) => {
    try {
      return { ok: true, detail: await repoDetail(String(repo ?? "")) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * The model card, prepared for the window.
   *
   * Prepared here rather than there because the preparation is the expensive,
   * fiddly half -- front matter, embedded HTML, a size cap -- and because the
   * cap has to be applied before the text crosses the bridge to be worth
   * anything. A repository with no README answers `{ ok: true }` and no card,
   * which is a fact rather than a failure.
   */
  ipcMain.handle("myra:hf-card", async (_e, repo: unknown) => {
    try {
      const readme = await repoCard(String(repo ?? ""));
      return { ok: true, ...(readme === undefined ? {} : { card: prepareCard(readme) }) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:hf-browse", async (_e, q: unknown) => {
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
          /* A list, capped: several publishers mean several requests to
             somebody's registry, and an unbounded array from a window would be
             an unbounded fan-out. */
          ...(Array.isArray(raw["authors"])
            ? {
                authors: (raw["authors"] as unknown[])
                  .filter((a): a is string => typeof a === "string" && a.length > 0)
                  .slice(0, 8)
                  .map((a) => a.slice(0, 200)),
              }
            : {}),
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
    "myra:registry-variants",
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
   * Fetch a model, and hand back a handle to the transfer rather than the file.
   *
   * The only way a download starts. There used to be a second one --
   * `myra:lemonade-pull`, which awaited the whole transfer and so existed
   * only for as long as the page that called it -- and the Recommended tab
   * was still on it, so a catalogue model downloaded from there had no
   * progress bar off that page, no pause and no cancel, while a searched one
   * had all three. Two paths to the same daemon endpoint differing only in
   * which of them a user happened to press is not a distinction worth
   * keeping, so there is one.
   *
   * A checkpoint may be empty, and that is what says which kind of pull this
   * is: given one, it names a specific quantisation in a specific repository
   * and the `source` decides which country the bytes come from; empty, the
   * name is one the daemon already knows from its own bundled catalogue and
   * it resolves the address itself.
   *
   * `gated` is the caller's own answer, already known from the registry --
   * see `ModelCard`'s own `detail.gated` -- never re-asked here. In "only for
   * models that need it" mode a gated repository needs the daemon restarted
   * to carry the token first, which `ensureLemonade` below cannot do on its
   * own: it is a no-op once the daemon is already running. "Always send my
   * token" needs none of this, because every start already carries one.
   */
  ipcMain.handle(
    "myra:registry-pull",
    async (
      _e, name: string, checkpoint: string, source: RegistrySource, recipe?: string, gated?: boolean,
    ) => {
      if (!isEnabled(readSource(source))) return refuse(readSource(source));
      if (gated && !runtime.hfTokenAlways) {
        if (!(await hfToken())) {
          return {
            ok: false,
            error:
              "This repository is gated and needs a Hugging Face access token. " +
              "Add one in Settings → Runtime, under “Hugging Face token”.",
          };
        }
        try {
          await runtime.restartForHfToken();
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      }
      try {
        await runtime.ensureLemonade();
        /* Returns as soon as the transfer is registered, not when it finishes.
           Awaiting a 30 GB pull here is what tied a download to the lifetime
           of one screen: the reply never came, so the only record of it was
           the React state waiting for it. */
        const installed = await runtime.api.listModels().catch(() => []);
        const record = downloads.start({
          name: String(name),
          /* Never `String(undefined)`: an absent checkpoint is the catalogue
             case, and the literal "undefined" would be sent to the daemon as
             a repository address. */
          checkpoint: checkpoint ? String(checkpoint) : "",
          source: readSource(source),
          recipe: recipe ? String(recipe) : "llamacpp",
          /* So cancelling can tell "throw away what I just fetched" from
             "delete the copy I already had". */
          replacing: installed.some((m) => m.id === String(name)),
        });
        return { ok: true, id: record.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /* --------------------------------------------------------- downloads -- */

  /**
   * The controls on a transfer.
   *
   * Pause and cancel are the same abort underneath -- lemond stops the moment
   * the client goes away -- and differ in what happens to the bytes: a pause
   * keeps the partial file so the next attempt resumes from it, a cancel asks
   * the daemon to delete what it fetched.
   */
  ipcMain.handle("myra:downloads-list", () => downloads.list());
  ipcMain.handle("myra:download-pause", (_e, id: string) => {
    downloads.pause(String(id));
    return { ok: true };
  });
  ipcMain.handle("myra:download-resume", (_e, id: string) => {
    downloads.resume(String(id));
    return { ok: true };
  });
  ipcMain.handle("myra:download-cancel", async (_e, id: string) => {
    await downloads.cancel(String(id));
    return { ok: true };
  });
  ipcMain.handle("myra:download-dismiss", (_e, id: string) => {
    if (id) downloads.dismiss(String(id));
    else downloads.dismissSettled();
    return { ok: true };
  });

  /**
   * Add a diffusion model by naming its parts, for one the catalogue lacks.
   *
   * The escape hatch for the one kind of model registry search cannot offer --
   * see `browsable` in hfBrowse.ts. Registering and downloading are separate
   * here on purpose: this writes the definition, and the transfer that follows
   * is the ordinary `myra:registry-pull` by name with no checkpoint, which is
   * what makes the daemon fetch every role and gives the new model the same
   * progress, pause and cancel as any other.
   */
  ipcMain.handle(
    "myra:register-image-model",
    async (_e, name: string, parts: Record<string, string>, source: RegistrySource) => {
      const chosen = readSource(source);
      if (!isEnabled(chosen)) return refuse(chosen);
      const checked = checkImageModel({ name: String(name ?? ""), parts: parts ?? {} });
      if (!checked.ok) return { ok: false, field: checked.field, error: checked.error };
      try {
        await runtime.ensureLemonade();
        await runtime.api.registerModel(
          checked.record.modelName, checked.record.checkpoints, checked.record.recipe, chosen,
        );
        return { ok: true, name: checked.record.modelName };
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
   * sentences are better than anything MyRA would compose, as well as being
   * guaranteed to match what actually gets rejected. So errors are passed
   * through rather than replaced.
   */
  ipcMain.handle("myra:model-options", async (_e, name: string) => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, options: await runtime.api.modelOptions(String(name)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "myra:model-options-set",
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

  ipcMain.handle("myra:model-options-reset", async (_e, name: string) => {
    try {
      await runtime.ensureLemonade();
      return { ok: true, options: await runtime.api.resetModelOptions(String(name)) };
    } catch (err) {
      return { ok: false, error: reasonFrom(err) };
    }
  });

  /**
   * Remove a model from this machine.
   *
   * The decision about whose file it is happens in the main process, from the
   * index's own symlinks, and never from the id the window sent -- see
   * `modelDelete.ts`. The window's part is asking, and showing the warning that
   * `deletePrompt` wrote for whichever owner it turned out to be.
   */
  ipcMain.handle("myra:lemonade-delete-model", async (_e, id: unknown) => {
    try {
      await runtime.ensureLemonade();
      const result = await deleteModel(String(id ?? ""), {
        deleteViaDaemon: (name) => runtime.api.deleteModel(name),
        foreign: runtime.foreignModels,
        modelsDir: runtime.modelsDir,
        indexDir: runtime.indexDir,
        rescan: () => runtime.rescanModels(),
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: reasonFrom(err) };
    }
  });

  /**
   * Show a model's file in the desktop's own file manager.
   *
   * Offered beside the delete for a model MyRA does not own, because "the file
   * is at <path>" is a sentence somebody should be able to check rather than
   * take on trust before agreeing to a deletion.
   */
  ipcMain.handle("myra:model-reveal", async (_e, id: unknown) => {
    const model = runtime.foreignModels.find((m) => m.id === String(id ?? ""));
    const path = model?.path;
    if (!path) return { ok: false, error: "MyRA has no record of where that file is." };
    shell.showItemInFolder(path);
    return { ok: true };
  });

  ipcMain.handle("myra:lemonade-stop", async () => {
    await runtime.stop();
    return { ok: true };
  });
}
