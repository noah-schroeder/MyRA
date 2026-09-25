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
  byNewest, cleanCollections, countsOf, MEMBER_KINDS, setCollections, newProject, ownerOf, perProjectLimit,
  removeMembers, summaryOf,
  type Member, type MemberKind, type ProjectSummary,
} from "../core/projects/project.ts";
import { exportPlan, fileName, renderSession, type ExportItem } from "../core/projects/render.ts";
import { newMemory, renderDecisionLog, renderMemoryMarkdown, type MemoryItem } from "../core/projects/memory.ts";
import { deleteMemory, readMemory, writeMemory } from "./memoryStore.ts";
import { dropProjectPapers } from "./projectPapers.ts";
import {
  deleteProject, fileInProject, readAllPruned, readProject, recordVisit, setProjectsWatcher, updateProject,
  writeProject, type ItemRow, type ProjectDetail, type ProjectStores,
} from "./projectStore.ts";

import { assertSessionId, deleteSession, listSessions, loadSession } from "../core/sessions.ts";
import { deleteMeeting, listMeetings, NOTES_MD, TRANSCRIPT_MD } from "../core/meetings/store.ts";
import { assertMeetingRef } from "../core/meetings/meeting.ts";
import { assertRunId, deleteRun, listRuns } from "../core/research/run.ts";
import { researchRoot } from "../core/research/config.ts";
import { assemble, assertPaperId } from "../core/papers/paper.ts";
import { deletePaper, listPapers, readPaperRecord } from "./papers.ts";
import { deleteReview, listReviews, readReviewRecord } from "./review.ts";
import { assertReviewId } from "../core/review/record.ts";
import { assertSourceId } from "../core/sources/source.ts";
import { listSources, readSource, removeSource, sourceFile } from "../core/sources/store.ts";
import { deleteImage, listImages, recordFor } from "./images.ts";
import { assertImageId } from "../core/images/store.ts";
import { revealInside } from "./reveal.ts";

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
 * The real six, each expressed against the module that already owns it.
 *
 * Meetings are the odd one: they are addressed by directory everywhere else in
 * the app, and what a project stores is the directory's **name**. An absolute
 * path would break the moment somebody moved their meetings folder in Settings,
 * which is a thing the app invites them to do.
 */
export function defaultStores(config: ConfigStore): ProjectStores {
  const meetingsRoot = (): string => config.current.meetingsRoot;
  const papersRoot = (): string => config.current.papersRoot;
  const reviewsRoot = (): string => config.current.reviewsRoot;
  const deps = { config };

  return {
    chat: {
      assertRef: assertSessionId,
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
      assertRef: assertMeetingRef,
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
      assertRef: assertRunId,
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
      assertRef: assertPaperId,
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

    review: {
      assertRef: assertReviewId,
      list: async () =>
        (await listReviews(reviewsRoot())).map((r) => ({
          ref: r.id,
          title: r.title,
          at: r.updatedAt,
          note: `${r.done} of ${r.total} ${r.total === 1 ? "reviewer" : "reviewers"}`,
        })),
      remove: (ref) => deleteReview(reviewsRoot(), ref),
      payload: async (ref) => {
        const review = await readReviewRecord(reviewsRoot(), ref);
        /* The assembled panel, which is the whole record: the manuscript was
           never kept, so there is nothing else an export could carry. */
        return review ? { title: review.title, at: review.updatedAt, text: review.assembled } : {};
      },
    },

    image: {
      assertRef: assertImageId,
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

    /* A paper somebody uploaded into a project. Exported as the file itself,
       named for its title, the way an image is -- a folder of papers somebody
       opens should show papers, not directories to click into. */
    source: {
      assertRef: assertSourceId,
      list: async () =>
        (await listSources(config.current.sourcesRoot)).map((p) => ({
          ref: p.id,
          title: p.title,
          at: p.addedAt,
          note: [p.authors, p.year].filter(Boolean).join(" · ") || p.originalName,
        })),
      remove: (ref) => removeSource(config.current.sourcesRoot, ref),
      payload: async (ref) => {
        const source = await readSource(config.current.sourcesRoot, ref);
        return source
          ? {
              title: source.title,
              at: source.addedAt,
              note: [source.authors, source.year].filter(Boolean).join(" · "),
              files: [{ name: source.file, from: sourceFile(config.current.sourcesRoot, source) }],
            }
          : {};
      },
    },
  };
}

/**
 * How many rows the rail's recent list carries, per project.
 *
 * Long enough that a week of work is all there, short enough that reading four
 * stores to draw a sidebar stays cheap. Per project rather than in total
 * because the rail draws one group at a time -- see `perProjectLimit`.
 */
const RECENT_LIMIT = 50;

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
      send("myra:projects", await summaries());
    } finally {
      publishing = false;
    }
  };

  /* Every write, wherever it came from. The ones that matter most are not from
     the window: a conversation files itself as its first message is sent. */
  setProjectsWatcher(() => void publish());

  ipcMain.handle("myra:project-list", async () => ({ ok: true, projects: await summaries() }));

  ipcMain.handle("myra:project-create", async (_e, name: unknown, research: unknown) => {
    const project = await writeProject(newProject({ name: String(name ?? "") }));
    /* A research project starts its memory "pending" -- the one flag
       everything else in this feature reads. handleSend runs the setup chat
       the moment the first message in a new conversation filed here lands;
       nothing else is asked of the project record itself. */
    if (research === true) await writeMemory(project.id, newMemory({ setup: "pending" }));
    await publish();
    return { ok: true, project };
  });

  ipcMain.handle("myra:project-rename", async (_e, id: unknown, name: unknown) => {
    const project = await updateProject(String(id), (p) => {
      const next = String(name ?? "").trim() || p.name;
      return next === p.name ? p : { ...p, name: next, updatedAt: new Date().toISOString() };
    });
    if (!project) return { ok: false, error: "That project could not be read." };
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
  /* `visit` is the page's first load of this project, as opposed to the
     reloads after every remove and add: only that one counts as having been
     here, or the resume card's "since" would be a few seconds ago. */
  ipcMain.handle("myra:project-open", async (_e, id: unknown, visit: unknown) => {
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
    const since = visit === true ? await recordVisit(project.id) : undefined;
    return { ok: true, detail: { project, items, ...(since ? { since } : {}) } satisfies ProjectDetail };
  });

  /** Everything in every store, with the project it is already in named. */
  ipcMain.handle("myra:project-items", async () => {
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

  /**
   * The work you have done lately, whatever kind it is.
   *
   * Built from the same stores a project reads, so a row in the rail prints the
   * title and the note its own page prints -- the property `myra:project-open`
   * is already built on, and the reason this is here rather than in a fourth
   * lister of its own.
   *
   * Meetings and images are not in it deliberately: they have their own pages
   * with their own shapes, and this list stands where the conversation list
   * stood. What belongs in it is the work you were in the middle of.
   *
   * Filed and loose rows both come back, each carrying the project it is in,
   * because the window draws one group or the other from this one answer and
   * `project` is what tells them apart.
   */
  ipcMain.handle("myra:recent", async () => {
    const kinds: MemberKind[] = ["chat", "paper", "review", "run"];
    const projects = await readAllPruned(stores);
    const out: (ItemRow & { kind: MemberKind; project: string })[] = [];
    for (const kind of kinds) {
      let rows: ItemRow[] = [];
      try {
        rows = await stores[kind].list();
      } catch {
        /* One unreadable store must not empty the whole list: the papers
           directory being missing is not a reason to hide every conversation. */
        rows = [];
      }
      for (const row of rows) {
        const owner = ownerOf(projects, { kind, ref: row.ref });
        out.push({ ...row, kind, project: owner?.id ?? "" });
      }
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    return { ok: true, items: perProjectLimit(out, RECENT_LIMIT) };
  });

  ipcMain.handle("myra:project-add", async (_e, id: unknown, members: unknown) => {
    const wanted = asMembers(members, stores);
    if (!wanted.length) return { ok: true };
    if (!(await fileInProject(String(id), wanted))) return { ok: false, error: "That project could not be read." };
    await publish();
    return { ok: true };
  });

  /* The Zotero collections this project reads from. Through the lock, since
     they live on the record that every turn's filing write also rewrites. */
  ipcMain.handle("myra:project-set-collections", async (_e, id: unknown, collections: unknown) => {
    const project = await updateProject(String(id), (p) => setCollections(p, cleanCollections(collections)));
    if (!project) return { ok: false, error: "That project could not be read." };
    await publish();
    return { ok: true, project };
  });

  ipcMain.handle("myra:project-remove", async (_e, id: unknown, members: unknown) => {
    const wanted = asMembers(members, stores);
    const project = await updateProject(String(id), (p) => removeMembers(p, wanted));
    if (!project) return { ok: false, error: "That project could not be read." };
    await publish();
    return { ok: true };
  });

  ipcMain.handle("myra:project-delete", async (_e, id: unknown, contents: unknown) => {
    const project = await readProject(String(id));
    if (!project) return { ok: false, error: "That project could not be read." };
    const report = await deleteProject(project, stores, { contents: contents === true });
    // The memory belongs to the project record, not to any of the five
    // stores `deleteProject` already asked -- nothing else would ever remove it.
    await deleteMemory(project.id);
    // Same reason: its cached PaperIndex (an in-memory SQLite handle) is kept
    // outside any of the five stores too, and nothing else would close it.
    dropProjectPapers(project.id);
    /* Whatever it was working in is gone, so it is not working in it any more.
       A stale active project would file the next conversation into nothing. */
    if (config.current.activeProject === project.id) await config.update({ activeProject: "" });
    await publish();
    return { ok: true, report };
  });

  ipcMain.handle("myra:project-active", async (_e, id: unknown) => {
    const wanted = String(id ?? "");
    /* Checked rather than trusted: a project deleted in another window would
       otherwise be set as the destination for everything made next. */
    const ok = !wanted || (await readProject(wanted)) !== undefined;
    return { ok: true, settings: await config.update({ activeProject: ok ? wanted : "" }) };
  });

  /**
   * "in “Kickoff chat”", for the decision log: every conversation and meeting,
   * not only this project's -- a note outlives its conversation being moved,
   * and the log should still say where it came from.
   */
  const originNamer = async (): Promise<(item: MemoryItem) => string | undefined> => {
    const titles = new Map<string, string>();
    for (const kind of ["chat", "meeting"] as const) {
      try {
        for (const row of await stores[kind].list()) titles.set(`${kind}:${row.ref}`, row.title);
      } catch {
        /* Unnamed rather than missing: the log still says a conversation. */
      }
    }
    return (item) => {
      if (item.meeting) {
        const title = titles.get(`meeting:${item.meeting}`);
        return `in the meeting ${title ? `“${title}”` : item.meeting}${item.meetingAt ? ` at ${item.meetingAt}` : ""}`;
      }
      if (item.from) {
        const title = titles.get(`chat:${item.from}`);
        return title ? `in “${title}”` : "in a conversation since deleted";
      }
      return undefined;
    };
  };

  ipcMain.handle("myra:project-export", async (_e, id: unknown) => {
    const projects = await readAllPruned(stores);
    const project = projects.find((p) => p.id === String(id));
    if (!project) return { ok: false, error: "That project could not be read." };

    const items: ExportItem[] = [];
    for (const member of project.members) {
      let payload: Partial<ExportItem> = {};
      try {
        /* Asserted before `payload`, because a payload is where a ref becomes
           a directory that `cp -r` then copies into the user's workspace. */
        payload = await stores[member.kind].payload(stores[member.kind].assertRef(member.ref));
      } catch {
        /* One unreadable item does not cancel the export. It is listed in the
           index with nothing written, which is the truth about it. */
      }
      items.push({ member, title: payload.title || member.ref, at: payload.at ?? "", ...payload });
    }

    const root = join(config.current.workspaceRoot, fileName(project.name, "project"));
    const { ops, counts } = exportPlan(project, items);
    const memory = await readMemory(project.id);
    const memoryText = renderMemoryMarkdown(memory);
    const logText = renderDecisionLog(memory, await originNamer());
    /* Inserted before the LAST op, which `exportPlan` always ends on
       project.md -- the done-marker rule render.ts documents: a crash
       halfway must never leave an index claiming a file that was never
       written, so project.md stays the final write. */
    const extra: typeof ops = [];
    if (memoryText) extra.push({ op: "write", path: "memory.md", text: memoryText });
    if (logText) extra.push({ op: "write", path: "decision-log.md", text: logText });
    ops.splice(ops.length - 1, 0, ...extra);
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

  ipcMain.handle("myra:project-reveal", async (_e, path: unknown) => {
    /* An export lands at join(workspaceRoot, fileName(name)), so the workspace
       is the only root this button can have produced a path in. */
    const verdict = revealInside(path, [config.current.workspaceRoot], "a folder MyRA exported");
    if (!verdict.ok) return verdict;
    shell.showItemInFolder(verdict.target);
    return { ok: true };
  });
}

/** Members as they arrive from the window: rebuilt, never trusted. */
function asMembers(raw: unknown, stores: ProjectStores): Member[] {
  if (!Array.isArray(raw)) return [];
  const out: Member[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const kind = row["kind"];
    const ref = row["ref"];
    if (typeof ref !== "string" || !ref) continue;
    /* Against the list itself, not a chain of comparisons: `parseProject`
       already validates this way, and the chain was the one place a new kind
       could be added everywhere else and still be dropped silently here. */
    if (typeof kind !== "string" || !MEMBER_KINDS.includes(kind as MemberKind)) continue;
    /* And the ref against the store that owns it, so a bad one never enters a
       record at all. Dropped the same way an unknown kind is: this is the door
       rather than the last line, and the last line is in `deleteProject`. */
    try {
      stores[kind as MemberKind].assertRef(ref);
    } catch {
      continue;
    }
    out.push({ kind: kind as MemberKind, ref });
  }
  return out;
}

export { fileInActiveProject } from "./projectStore.ts";
export type {
  DeleteReport, ItemRow, KindStore, ProjectDetail, ProjectStores,
} from "./projectStore.ts";
