/**
 * Projects, wired to the window and to the five stores.
 *
 * The split is the one meetings, images and papers already use:
 * [core/projects/](../core/projects/project.ts) holds the record and the export
 * layout and knows nothing about Electron; this file carries the IPC and builds
 * the five real stores; and [projectStore.ts](./projectStore.ts) owns the
 * records on disk, so the destructive path can be tested without Electron.
 *
 * The whole feature rests on one interface. `KindStore` is what a project needs
 * from a store -- list what is in it, remove one, and hand over what an export
 * should contain -- and every one of the five is expressed in a dozen lines
 * against its existing module. That is what keeps this from becoming a sixth
 * store with its own opinions about meetings: nothing here knows how a meeting
 * is laid out, only that `listMeetings` answers and `deleteMeeting` removes.
 */

import { access, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ipcMain, shell } from "electron";

import type { ConfigStore } from "../core/config.ts";
import { makePrivateDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import {
  addMembers, byNewest, countsOf, newProject, ownerOf, removeMembers, summaryOf,
  type Member, type MemberKind, type ProjectSummary,
} from "../core/projects/project.ts";
import { exportPlan, fileName, renderSession, type ExportItem } from "../core/projects/render.ts";
import {
  deleteProject, readAll, readAllPruned, readProject, setProjectsWatcher, writeProject,
  type ItemRow, type ProjectDetail, type ProjectStores,
} from "./projectStore.ts";

import { deleteSession, listSessions, loadSession } from "../core/sessions.ts";
import { deleteMeeting, listMeetings, NOTES_MD, TRANSCRIPT_MD } from "../core/meetings/store.ts";
import { deleteRun, listRuns } from "../core/research/run.ts";
import { researchRoot } from "../core/research/config.ts";
import { assemble } from "../core/papers/paper.ts";
import { deletePaper, listPapers, readPaperRecord } from "./papers.ts";
import { deleteImage, listImages, recordFor } from "./images.ts";

export interface ProjectDeps {
  config: ConfigStore;
  send: (channel: string, payload?: unknown) => void;
  stores: ProjectStores;
}

/* ------------------------------------------------------------------ *
 * The five stores                                                     *
 * ------------------------------------------------------------------ */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/**
 * The real five, each expressed against the module that already owns it.
 *
 * Meetings are the odd one: they are addressed by directory everywhere else in
 * the app, and what a project stores is the directory's **name**. An absolute
 * path would break the moment somebody moved their meetings folder in Settings,
 * which is a thing the app invites them to do.
 */
export function defaultStores(config: ConfigStore): ProjectStores {
  const meetingsRoot = (): string => config.current.meetingsRoot;
  const papersRoot = (): string => config.current.papersRoot;
  const deps = { config };

  return {
    chat: {
      list: async () =>
        (await listSessions()).map((s) => ({
          ref: s.id,
          title: s.title,
          at: s.updatedAt,
          note: `${s.messages} ${s.messages === 1 ? "message" : "messages"}`,
        })),
      remove: (ref) => deleteSession(ref),
      payload: async (ref) => {
        const session = await loadSession(ref);
        if (!session) return {};
        return {
          title: session.title,
          at: session.createdAt,
          text: renderSession(session.title, session.messages_, session.createdAt),
        };
      },
    },

    meeting: {
      list: async () =>
        (await listMeetings(meetingsRoot())).map((m) => ({
          ref: basename(m.dir),
          title: m.title,
          at: m.startedAt,
          note: [minutes(m.seconds), m.noted ? "noted" : m.transcribed ? "transcribed" : "not yet written up"]
            .filter(Boolean)
            .join(" · "),
        })),
      remove: (ref) => deleteMeeting(join(meetingsRoot(), ref)),
      payload: async (ref) => {
        const dir = join(meetingsRoot(), ref);
        const found = (await listMeetings(meetingsRoot())).find((m) => basename(m.dir) === ref);
        const files: { name: string; from: string }[] = [];
        for (const name of [NOTES_MD, TRANSCRIPT_MD]) {
          if (await exists(join(dir, name))) files.push({ name, from: join(dir, name) });
        }
        return {
          ...(found ? { title: found.title, at: found.startedAt, note: minutes(found.seconds) } : {}),
          ...(files.length ? { files } : {}),
        };
      },
    },

    run: {
      list: async () =>
        (await listRuns()).map((r) => ({
          ref: r.id,
          title: r.question,
          at: r.startedAt ?? "",
          note: r.funnel,
        })),
      remove: async (ref) => {
        await deleteRun(ref);
      },
      payload: async (ref) => {
        const found = (await listRuns()).find((r) => r.id === ref);
        return {
          ...(found ? { title: found.question, at: found.startedAt ?? "", note: found.funnel } : {}),
          dir: join(researchRoot(), ref),
        };
      },
    },

    paper: {
      list: async () =>
        (await listPapers(papersRoot())).map((p) => ({
          ref: p.id,
          title: p.title,
          at: p.updatedAt,
          note: `${p.drafted} of ${p.sections} ${p.sections === 1 ? "section" : "sections"} drafted`,
        })),
      remove: (ref) => deletePaper(papersRoot(), ref),
      payload: async (ref) => {
        const paper = await readPaperRecord(papersRoot(), ref);
        return paper ? { title: paper.title, at: paper.updatedAt, text: assemble(paper) } : {};
      },
    },

    image: {
      list: async () =>
        (await listImages(deps)).map((i) => ({
          ref: i.id,
          title: i.prompt || i.id,
          at: i.at,
          note: i.model,
        })),
      remove: (ref) => deleteImage(deps, ref),
      payload: async (ref) => {
        try {
          const record = await recordFor(deps, ref);
          return {
            title: record.prompt || record.id,
            at: record.at,
            note: record.prompt,
            files: [{ name: record.file, from: join(config.current.imagesRoot, record.file) }],
          };
        } catch {
          return {};
        }
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * IPC                                                                 *
 * ------------------------------------------------------------------ */

export function installProjectIpc(deps: ProjectDeps): void {
  const { config, send, stores } = deps;

  const summaries = async (): Promise<ProjectSummary[]> =>
    (await readAllPruned(stores)).map(summaryOf).sort(byNewest);

  /*
   * Re-entrant on purpose, and guarded.
   *
   * `summaries` prunes, pruning writes, and a write tells the watcher -- which
   * is this. The recursion terminates on its own, because the second pass finds
   * nothing left to prune, but the flag stops it making the round trip at all.
   */
  let publishing = false;
  const publish = async (): Promise<void> => {
    if (publishing) return;
    publishing = true;
    try {
      send("karen:projects", await summaries());
    } finally {
      publishing = false;
    }
  };

  /* Every write, wherever it came from. The ones that matter most are not from
     the window: a conversation files itself when its first turn finishes. */
  setProjectsWatcher(() => void publish());

  ipcMain.handle("karen:project-list", async () => ({ ok: true, projects: await summaries() }));

  ipcMain.handle("karen:project-create", async (_e, name: unknown) => {
    const project = await writeProject(newProject({ name: String(name ?? "") }));
    await publish();
    return { ok: true, project };
  });

  ipcMain.handle("karen:project-rename", async (_e, id: unknown, name: unknown) => {
    const project = await readProject(String(id));
    if (!project) return { ok: false, error: "That project could not be read." };
    const next = String(name ?? "").trim() || project.name;
    await writeProject({ ...project, name: next, updatedAt: new Date().toISOString() });
    await publish();
    return { ok: true };
  });

  /**
   * The project page's contents, resolved.
   *
   * Every member is turned into a row by asking its own store, so the titles
   * and the notes are the same ones that store's own page prints -- a project
   * that named a meeting differently from the Meetings page would be two
   * records of one thing.
   */
  ipcMain.handle("karen:project-open", async (_e, id: unknown) => {
    const projects = await readAllPruned(stores);
    const project = projects.find((p) => p.id === String(id));
    if (!project) return { ok: false, error: "That project could not be read." };

    const rows: Record<MemberKind, Map<string, ItemRow>> = {} as never;
    for (const kind of Object.keys(stores) as MemberKind[]) {
      try {
        rows[kind] = new Map((await stores[kind].list()).map((r) => [r.ref, r]));
      } catch {
        rows[kind] = new Map();
      }
    }

    const items = project.members.flatMap((m) => {
      const row = rows[m.kind].get(m.ref);
      return row ? [{ ...row, kind: m.kind }] : [];
    });
    return { ok: true, detail: { project, items } satisfies ProjectDetail };
  });

  /** Everything in every store, with the project it is already in named. */
  ipcMain.handle("karen:project-items", async () => {
    const projects = await readAllPruned(stores);
    const out: (ItemRow & { kind: MemberKind; project: string })[] = [];
    for (const kind of Object.keys(stores) as MemberKind[]) {
      let rows: ItemRow[] = [];
      try {
        rows = await stores[kind].list();
      } catch {
        rows = [];
      }
      for (const row of rows) {
        const owner = ownerOf(projects, { kind, ref: row.ref });
        out.push({ ...row, kind, project: owner?.id ?? "" });
      }
    }
    return { ok: true, items: out };
  });

  ipcMain.handle("karen:project-add", async (_e, id: unknown, members: unknown) => {
    const wanted = asMembers(members);
    if (!wanted.length) return { ok: true };
    const projects = await readAll();
    const target = projects.find((p) => p.id === String(id));
    if (!target) return { ok: false, error: "That project could not be read." };
    /* Every project is rewritten, not just the target: membership is exclusive,
       so moving something in is an edit to whichever project it was in. */
    const next = addMembers(projects, target.id, wanted);
    for (const [i, project] of next.entries()) {
      if (project !== projects[i]) await writeProject(project);
    }
    await publish();
    return { ok: true };
  });

  ipcMain.handle("karen:project-remove", async (_e, id: unknown, members: unknown) => {
    const project = await readProject(String(id));
    if (!project) return { ok: false, error: "That project could not be read." };
    await writeProject(removeMembers(project, asMembers(members)));
    await publish();
    return { ok: true };
  });

  ipcMain.handle("karen:project-delete", async (_e, id: unknown, contents: unknown) => {
    const project = await readProject(String(id));
    if (!project) return { ok: false, error: "That project could not be read." };
    const report = await deleteProject(project, stores, { contents: contents === true });
    /* Whatever it was working in is gone, so it is not working in it any more.
       A stale active project would file the next conversation into nothing. */
    if (config.current.activeProject === project.id) await config.update({ activeProject: "" });
    await publish();
    return { ok: true, report };
  });

  ipcMain.handle("karen:project-active", async (_e, id: unknown) => {
    const wanted = String(id ?? "");
    /* Checked rather than trusted: a project deleted in another window would
       otherwise be set as the destination for everything made next. */
    const ok = !wanted || (await readProject(wanted)) !== undefined;
    return { ok: true, settings: await config.update({ activeProject: ok ? wanted : "" }) };
  });

  ipcMain.handle("karen:project-export", async (_e, id: unknown) => {
    const projects = await readAllPruned(stores);
    const project = projects.find((p) => p.id === String(id));
    if (!project) return { ok: false, error: "That project could not be read." };

    const items: ExportItem[] = [];
    for (const member of project.members) {
      let payload: Partial<ExportItem> = {};
      try {
        payload = await stores[member.kind].payload(member.ref);
      } catch {
        /* One unreadable item does not cancel the export. It is listed in the
           index with nothing written, which is the truth about it. */
      }
      items.push({ member, title: payload.title || member.ref, at: payload.at ?? "", ...payload });
    }

    const root = join(config.current.workspaceRoot, fileName(project.name, "project"));
    const { ops, counts } = exportPlan(project, items);
    await makePrivateDir(root);

    for (const op of ops) {
      const target = join(root, op.path);
      await makePrivateDir(dirname(target));
      if (op.op === "write") {
        await writeFile(target, op.text, { mode: OWNER_ONLY_FILE });
      } else if (op.op === "copyFile") {
        await copyFile(op.from, target).catch(() => undefined);
      } else {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await cp(op.from, target, { recursive: true }).catch(() => undefined);
      }
    }
    return { ok: true, path: root, counts };
  });

  ipcMain.handle("karen:project-reveal", async (_e, path: unknown) => {
    shell.showItemInFolder(String(path));
    return { ok: true };
  });
}

/** Members as they arrive from the window: rebuilt, never trusted. */
function asMembers(raw: unknown): Member[] {
  if (!Array.isArray(raw)) return [];
  const out: Member[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const kind = row["kind"];
    const ref = row["ref"];
    if (typeof ref !== "string" || !ref) continue;
    if (kind !== "chat" && kind !== "meeting" && kind !== "run" && kind !== "paper" && kind !== "image") {
      continue;
    }
    out.push({ kind, ref });
  }
  return out;
}

export { fileInActiveProject } from "./projectStore.ts";
export type {
  DeleteReport, ItemRow, KindStore, ProjectDetail, ProjectStores,
} from "./projectStore.ts";
