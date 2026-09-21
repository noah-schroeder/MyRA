/**
 * Removing a model, whoever it belongs to.
 *
 * Three cases, and the daemon can only do one of them. `DELETE /api/delete`
 * removes what Lemonade downloaded; asked about anything reached through
 * `extra_models_dir` it answers 500 with
 *
 *     Cannot delete extra models via API. Models in --extra-models-dir are
 *     user-managed. Delete the file directly from: <path>
 *
 * which is a handover rather than a failure. That path is inside MyRA's
 * **index** -- a tree of symlinks rebuilt from scratch on every start -- so
 * deleting it would remove a link and leave the gigabytes exactly where they
 * were, and the model would be back after the next rescan. What has to go is
 * whatever the links point at.
 *
 * Hence the two rules this file is built on:
 *
 * 1. **The real path comes from `realpath`, never from the id.** An id is a
 *    directory name in an index MyRA builds, and building a delete out of
 *    string concatenation on a name that came back from a window is how a
 *    delete ends up somewhere else.
 * 2. **A resolved target must be inside a directory MyRA already knows.**
 *    Either its own models folder, or the library of the application the index
 *    recorded this model as belonging to. A link pointing anywhere else is
 *    refused rather than followed -- there is no legitimate way for one to
 *    exist, and "the symlink said so" is not a reason to delete a file.
 *
 * The user asked for LM Studio's and Ollama's models to stay deletable, with a
 * warning first. The warning is [modelOwner.ts](../../core/runtime/modelOwner.ts)'s
 * job; the deleting is this one's, and it is why rule 2 is scoped to that one
 * model's own library rather than to MyRA's directories alone.
 */

import { realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ForeignModel } from "../../core/runtime/foreign.ts";
import { ownerOf, type Owner } from "../../core/runtime/modelOwner.ts";
import { EXTRA_MODEL_REFUSAL, LemonadeApiError } from "./lemonadeApi.ts";
import { assertModelId } from "../../core/runtime/runtimeConfig.ts";
import { inside, resolveTargets } from "./modelFiles.ts";

export interface DeleteResult {
  owner: Owner;
  /** What was actually removed, for a message that can be checked. */
  removed: string[];
  /** Whether the caller still has to restart the daemon for the row to go. */
  restarted: boolean;
}

export interface DeleteDeps {
  deleteViaDaemon: (id: string) => Promise<void>;
  /** What the last index build recorded, which is the only record of ownership. */
  foreign: readonly ForeignModel[];
  /** MyRA's own models folder. */
  modelsDir: string;
  /** The symlink tree the daemon is pointed at. */
  indexDir: string;
  /** Rebuild the index and restart the daemon so the row goes away. */
  rescan: () => Promise<unknown>;
}

/**
 * Delete one model by the id the daemon lists it under.
 *
 * Ordered so that the cheap, reversible thing is tried first: Lemonade's own
 * delete needs no restart and touches nothing outside its cache. Only its
 * refusal sends this down the path that removes files directly.
 */
export async function deleteModel(id: string, deps: DeleteDeps): Promise<DeleteResult> {
  const foreign = deps.foreign.find((m) => m.id === id);
  let owner = ownerOf({ ...(foreign ? { foreign: foreign.source } : {}) });

  if (!foreign) {
    try {
      await deps.deleteViaDaemon(id);
      return { owner: "myra", removed: [id], restarted: false };
    } catch (err) {
      /* Anything but the handover is a real failure and is reported as one.
         Falling through on every error would turn "the daemon is not running"
         into an unexplained file deletion. */
      const message = err instanceof LemonadeApiError ? err.message : String((err as Error).message);
      if (!message.includes(EXTRA_MODEL_REFUSAL)) throw err;
      /* The refusal is what proves this one is MyRA's folder rather than the
         daemon's cache. Taken from the answer rather than from the `source`
         field, because the daemon is the thing that knows. */
      owner = ownerOf({ source: "extra_models_dir" });
    }
  }

  /* The roots this model's files are allowed to be under. For a foreign model
     that is the library the index recorded; for anything else, MyRA's own
     folder. Nothing widens this set at runtime. */
  const roots = foreign ? [dirname(await realpath(foreign.path))] : [deps.modelsDir];
  /* Asserted, like every other id that lands in a path. This one was the
     exception: `id` came off IPC and was joined onto the index directory with
     no guard, so the only thing standing between it and an arbitrary unlink
     was `roots` -- and `roots` is `deps.modelsDir`, which the window could
     set. Both halves needed fixing; either alone left the primitive. */
  const targets = await resolveTargets(join(deps.indexDir, assertModelId(id)), roots, "deleted");
  if (!targets.length) {
    throw new Error(
      `MyRA could not find the files for ${id}. Nothing has been deleted.`,
    );
  }

  const removed: string[] = [];
  for (const target of targets) {
    await rm(target, { force: true });
    removed.push(target);
  }
  /* The directory a model sat in, but only if this emptied it and only inside
     a root -- a shared folder that still holds another model stays. */
  for (const dir of new Set(targets.map((t) => dirname(t)))) {
    if (!roots.some((root) => inside(root, dir) && resolve(root) !== resolve(dir))) continue;
    await rmdir(dir).catch(() => {});
  }

  /* Lemonade read `extra_models_dir` once at startup, so until it is restarted
     the model it can no longer open is still on the list. */
  await deps.rescan();
  return { owner, removed, restarted: true };
}
