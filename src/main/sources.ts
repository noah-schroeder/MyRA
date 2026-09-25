/**
 * Papers uploaded into a project: the IPC.
 *
 * The disk lives in [core/sources/store.ts](../core/sources/store.ts), which
 * imports no Electron and is tested; this file adds the window's channels and
 * the one thing only Electron can do, opening a file in the system viewer.
 *
 * The paper arrives as BYTES, never as a path -- review.ts's reasoning,
 * unchanged: `webUtils.getPathForFile` would hand main an arbitrary absolute
 * path to read for the sake of a convenience, and `arrayBuffer()` on a dropped
 * `File` is a plain web API the sandbox already allows.
 */

import { ipcMain, shell } from "electron";

import type { ConfigStore } from "../core/config.ts";
import { outline } from "../core/sources/fulltext.ts";
import { assertSourceId, editSource, type Source, type SourceEdit } from "../core/sources/source.ts";
import {
  addSource, readSource, readSourceText, removeSource, saveSource, sourceFile,
} from "../core/sources/store.ts";
import { extractPages } from "./extractPages.ts";
import { fileInProject, readProject } from "./projectStore.ts";

/** A source as the project page shows it: the record, plus its outline when it has text. */
export interface SourceRow extends Source {
  outline?: string;
}

export function installSourceIpc(deps: { config: ConfigStore; send: (channel: string, payload?: unknown) => void }): void {
  const root = (): string => deps.config.current.sourcesRoot;

  ipcMain.handle("myra:source-add", async (_e, projectId: unknown, name: unknown, bytes: unknown) => {
    const id = String(projectId ?? "");
    if (!(await readProject(id))) return { ok: false, error: "That project could not be read." };
    if (typeof name !== "string" || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) {
      return { ok: false, error: "Nothing to add." };
    }
    const view =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array((bytes as ArrayBufferView).buffer, (bytes as ArrayBufferView).byteOffset, (bytes as ArrayBufferView).byteLength);
    try {
      const source = await addSource(root(), name, view, extractPages);
      /* Filed into THIS project, named explicitly, not "the active one": the
         paper was dropped on this project's page, and a paper that no project
         lists is a file nothing on screen would ever show again. `false` means
         the project was deleted in the gap since the check above -- the file
         addSource just wrote is removed rather than left orphaned on disk. */
      if (!(await fileInProject(id, [{ kind: "source", ref: source.id }]))) {
        await removeSource(root(), source.id);
        return { ok: false, error: "That project could not be read." };
      }
      deps.send("myra:project-sources-changed", { projectId: id });
      return { ok: true, source };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Every uploaded paper in a project, with its outline. */
  ipcMain.handle("myra:project-sources", async (_e, projectId: unknown) => {
    const project = await readProject(String(projectId ?? ""));
    if (!project) return { ok: false, error: "That project could not be read.", sources: [] };
    const rows: SourceRow[] = [];
    for (const member of project.members) {
      if (member.kind !== "source") continue;
      const source = await readSource(root(), member.ref);
      if (!source) continue;
      const text = source.text === "ok" ? await readSourceText(root(), source.id) : undefined;
      rows.push(text ? { ...source, outline: outline(text) } : source);
    }
    return { ok: true, sources: rows };
  });

  ipcMain.handle("myra:source-edit", async (_e, id: unknown, edit: unknown) => {
    const source = await readSource(root(), assertSourceId(String(id ?? "")));
    if (!source) return { ok: false, error: "That paper could not be read." };
    const row = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : {};
    const patch: SourceEdit = {};
    for (const key of ["title", "authors", "year", "doi"] as const) {
      if (typeof row[key] === "string") patch[key] = row[key] as string;
    }
    return { ok: true, source: await saveSource(root(), editSource(source, patch)) };
  });

  /* Deleting, not just removing from the project: an uploaded paper exists
     only because a project asked for it, so taking it out of the project
     would leave a file that no page lists. The next project read prunes the
     member, the way every other store's delete works. */
  ipcMain.handle("myra:source-delete", async (_e, id: unknown) => {
    await removeSource(root(), assertSourceId(String(id ?? "")));
    return { ok: true };
  });

  ipcMain.handle("myra:source-open", async (_e, id: unknown) => {
    const source = await readSource(root(), assertSourceId(String(id ?? "")));
    if (!source) return { ok: false, error: "That paper could not be read." };
    const failure = await shell.openPath(sourceFile(root(), source));
    return failure ? { ok: false, error: failure } : { ok: true };
  });
}
