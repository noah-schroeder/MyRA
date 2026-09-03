/**
 * Image generation, wired to the window.
 *
 * The split is the same one meetings uses: core does the work and knows nothing
 * about Electron, this file owns the files and the IPC, and the renderer draws.
 *
 * What is particular to this feature is that a generation is BOTH handed back
 * and written down. The bytes cross the bridge because the window is sandboxed
 * and has no filesystem, and the file is written because a generated figure is
 * a thing somebody wants next week -- unlike an utterance, which speech.ts is
 * right to keep in memory and forget. So the reply carries the image and the
 * gallery reads the folder, and neither is derived from the other.
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dialog, ipcMain, shell } from "electron";

import { generate, extensionFor, type Generated } from "../core/images/generate.ts";
import { composeNegative, composePrompt, presetById } from "../core/images/presets.ts";
import {
  assertImageId, byNewest, idOfSidecar, imageId, parseRecord, sidecarName, type ImageRecord,
} from "../core/images/store.ts";
import { makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import { modelOptions, resolveMediaModel, type MediaDeps, type ResolvedModel } from "./models.ts";

export type ImageDeps = MediaDeps;

/** What the page sends when the Generate button is pressed. */
export interface GenerateRequest {
  /** What the user typed. Stored as typed; the scaffold is added here. */
  prompt: string;
  negative?: string;
  preset?: string;
}

export async function resolveImage(
  deps: Pick<ImageDeps, "config" | "vault" | "runtime">,
  { start = false }: { start?: boolean } = {},
): Promise<ResolvedModel> {
  return resolveMediaModel(deps, "image", deps.config.current.image.model, { start });
}

function rootOf(deps: Pick<ImageDeps, "config">): string {
  return deps.config.current.imagesRoot;
}

/**
 * Generate one image and file it.
 *
 * The order of the two writes is the whole of the crash-safety story. The image
 * goes down first under a temporary name and is renamed into place; the sidecar
 * is written last; and `listImages` enumerates sidecars. So an interrupted
 * generation leaves at worst an orphan .png that nothing lists, and never a
 * half-written picture presented as a finished one -- the same rule
 * research/run.ts uses, where a stage's output file is its own done-marker.
 */
export async function generateAndSave(
  deps: Pick<ImageDeps, "config" | "vault" | "runtime">,
  request: GenerateRequest,
  signal?: AbortSignal,
): Promise<ImageRecord> {
  const typed = request.prompt.trim();
  if (!typed) throw new Error("There was nothing to draw.");

  const resolved = await resolveImage(deps, { start: true });
  const preset = presetById(request.preset);
  const settings = deps.config.current;
  const sentPrompt = composePrompt(typed, preset);
  /* Both are kept. The composed one is what was sent and is the honest record
     of how the picture was made; the typed one is what "use this prompt again"
     puts back in the box -- reusing the composed one would fold the preset's
     avoid terms in a second time on every repeat. */
  const negative = request.negative?.trim() ?? "";
  const sentNegative = composeNegative(negative, preset);

  const started = Date.now();
  let made: Generated;
  try {
    made = await generate({
      endpoint: resolved.endpoint,
      prompt: sentPrompt,
      ...(sentNegative ? { negative: sentNegative } : {}),
      ...(settings.image.size ? { size: settings.image.size } : {}),
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new Error((err as Error).message);
  }

  const root = rootOf(deps);
  await makeOwnDir(root);

  /* Real entropy in the id, not a hash of the minute: two generations started
     inside the same minute would otherwise collide on the filename and the
     second would overwrite the first. */
  const id = imageId(typed, new Date(started), randomBytes(2).toString("hex"));
  const file = `${id}.${extensionFor(made.mime)}`;

  const temp = join(root, `.${file}.partial`);
  await writeFile(temp, made.image, { mode: OWNER_ONLY_FILE });
  await rename(temp, join(root, file));

  const record: ImageRecord = {
    id,
    prompt: typed,
    sentPrompt,
    negative,
    sentNegative,
    size: settings.image.size,
    model: settings.image.model,
    ...(preset ? { preset: preset.id } : {}),
    external: resolved.external,
    at: new Date(started).toISOString(),
    file,
    mime: made.mime,
    bytes: made.image.length,
    seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
  };
  await writeFile(join(root, sidecarName(id)), JSON.stringify(record, null, 2), {
    mode: OWNER_ONLY_FILE,
  });
  return record;
}

/**
 * Every finished generation, newest first.
 *
 * Sidecars are enumerated and a malformed one is skipped rather than thrown on:
 * this is a folder the user is invited to open, so eventually one of these gets
 * edited by hand or truncated by a full disk, and a gallery that dies on the
 * fifth of two hundred images is worse than one that shows a hundred and
 * ninety-nine.
 */
export async function listImages(deps: Pick<ImageDeps, "config">): Promise<ImageRecord[]> {
  const root = rootOf(deps);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return []; // Nothing generated yet is not an error.
  }
  const out: ImageRecord[] = [];
  for (const name of names) {
    const id = idOfSidecar(name);
    if (!id) continue;
    try {
      const record = parseRecord(JSON.parse(await readFile(join(root, name), "utf8")), id);
      /* The image itself has to be there. A sidecar whose picture was deleted
         from the file manager is a row that cannot be opened. */
      if (record && (await stat(join(root, record.file)).then(() => true, () => false))) {
        out.push(record);
      }
    } catch {
      continue;
    }
  }
  return out.sort(byNewest);
}

async function recordFor(deps: Pick<ImageDeps, "config">, id: string): Promise<ImageRecord> {
  const root = rootOf(deps);
  const raw = JSON.parse(await readFile(join(root, sidecarName(assertImageId(id))), "utf8"));
  const record = parseRecord(raw, id);
  if (!record) throw new Error(`no image named ${JSON.stringify(id)}`);
  return record;
}

export function installImageIpc(deps: ImageDeps): void {
  const { runtime, send } = deps;

  /* The generation in flight, so the page's Cancel button has something to
     pull. One at a time deliberately: two diffusion passes on an 8 GB card is
     the same out-of-memory failure meetings avoids by transcribing serially. */
  let running: AbortController | undefined;

  ipcMain.handle("karen:image-models", async () => {
    try {
      return { ok: true, options: await modelOptions(deps, "image") };
    } catch (err) {
      return { ok: false, error: (err as Error).message, options: [] };
    }
  });

  /**
   * Download and load a local image model.
   *
   * Progress is pushed on a channel rather than returned, for the reason the
   * audio and chat downloads are: this is where a multi-gigabyte diffusion
   * model arrives, and a promise that settles in twenty minutes is a button
   * that says nothing.
   */
  ipcMain.handle("karen:image-load", async (_e, model: string) => {
    try {
      await runtime.loadAuxModel(model, (p) => send("karen:image-progress", { model, ...p }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:image-generate", async (_e, request: GenerateRequest) => {
    if (running) return { ok: false, error: "An image is already being generated." };
    running = new AbortController();
    try {
      const record = await generateAndSave(deps, request, running.signal);
      const bytes = await readFile(join(rootOf(deps), record.file));
      /* A plain Uint8Array: a Node Buffer crosses the bridge as an object with
         a `data` array, which is structurally cloneable and useless to
         `new Blob()` on the far side. */
      return { ok: true, record, image: new Uint8Array(bytes) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      running = undefined;
    }
  });

  ipcMain.handle("karen:image-cancel", () => {
    running?.abort();
    return { ok: true };
  });

  ipcMain.handle("karen:image-list", async () => {
    try {
      return { ok: true, images: await listImages(deps) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, images: [] };
    }
  });

  /** One image's bytes, for a gallery row the user clicked on. */
  ipcMain.handle("karen:image-read", async (_e, id: string) => {
    try {
      const record = await recordFor(deps, id);
      const bytes = await readFile(join(rootOf(deps), record.file));
      return { ok: true, image: new Uint8Array(bytes), mime: record.mime };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:image-delete", async (_e, id: string) => {
    try {
      const record = await recordFor(deps, id);
      const root = rootOf(deps);
      /* The sidecar goes first. It is the done-marker, so removing it is what
         makes the image gone as far as the app is concerned -- and if the
         second unlink fails, what is left is an orphan file rather than a row
         pointing at nothing. */
      await rm(join(root, sidecarName(id)), { force: true });
      await rm(join(root, record.file), { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:image-reveal", async (_e, id: string) => {
    try {
      const record = await recordFor(deps, id);
      shell.showItemInFolder(join(rootOf(deps), record.file));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Save a copy wherever the user wants it.
   *
   * A copy, not a move: the images folder is the record, and a figure dragged
   * into a paper should not disappear from the gallery it was found in.
   */
  ipcMain.handle("karen:image-save-copy", async (_e, id: string) => {
    try {
      const record = await recordFor(deps, id);
      const chosen = await dialog.showSaveDialog({
        title: "Save a copy of this image",
        defaultPath: record.file,
      });
      if (chosen.canceled || !chosen.filePath) return { ok: true, saved: false };
      await mkdir(join(chosen.filePath, ".."), { recursive: true }).catch(() => undefined);
      /* Copied to where the user pointed, and NOT re-chmodded: a directory the
         user chose is theirs, which is the rule paths.ts states. */
      await copyFile(join(rootOf(deps), record.file), chosen.filePath);
      return { ok: true, saved: true, path: chosen.filePath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:image-folder", async () => {
    try {
      const root = rootOf(deps);
      await makeOwnDir(root);
      await shell.openPath(root);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
