/**
 * A project's record on disk, and what deleting one does.
 *
 * Split from [projects.ts](./projects.ts) for the reason
 * [modelDelete.ts](./runtime/modelDelete.ts) is split from its own IPC: a
 * module that imports `electron` cannot be loaded by the test runner at all,
 * and the destructive path is exactly the one that has to be tested. Nothing
 * here touches Electron; `projects.ts` holds the handlers and builds the five
 * real stores.
 */

import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigStore } from "../core/config.ts";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
import {
  addMembers, assertProjectId, parseProject, pruneMembers,
  type MemberKind, type Project,
} from "../core/projects/project.ts";
import type { ExportItem } from "../core/projects/render.ts";

/** One row as a project page or the add dialog shows it. */
export interface ItemRow {
  ref: string;
  title: string;
  /** ISO, or empty when the store recorded none. */
  at: string;
  /** One line of context: how many messages, how long, how many sources. */
  note: string;
}

/** What a project needs from a store, and the only thing it may assume. */
export interface KindStore {
  /**
   * Refuse a ref this store does not address. Throws; returns it otherwise.
   *
   * On the interface rather than in a table beside it, for the reason a risk
   * class lives on the ToolDef: `ProjectStores` is a Record over MemberKind,
   * so widening that union makes `defaultStores` fail to compile until a
   * seventh store exists -- and that store fails until it answers this. The
   * check cannot be forgotten for a new kind, which a checklist could not
   * promise.
   *
   * Meetings are why it is here. Five kinds are addressed by an id that
   * `assert*Id` already guards; a meeting is addressed by its DIRECTORY NAME,
   * so `stores.meeting.remove` was `rm -rf` over join(meetingsRoot(), ref)
   * with ref straight off the wire.
   */
  assertRef: (ref: string) => string;
  list: () => Promise<ItemRow[]>;
  remove: (ref: string) => Promise<void>;
  /** What the export should contain for this one. */
  payload: (ref: string) => Promise<Partial<ExportItem>>;
}

export type ProjectStores = Record<MemberKind, KindStore>;

/** What the project page draws: the record, plus a resolved row per member. */
export interface ProjectDetail {
  project: Project;
  items: (ItemRow & { kind: MemberKind })[];
}

export interface DeleteReport {
  /** What was removed, by kind. */
  removed: { kind: MemberKind; count: number }[];
  /** What refused, and why. A live research run is the one that really does. */
  failed: { kind: MemberKind; ref: string; error: string }[];
}

export function projectsDir(): string {
  return process.env["MYRA_PROJECTS_DIR"] ?? join(CONFIG_DIR, "projects");
}

function pathFor(id: string): string {
  return join(projectsDir(), `${assertProjectId(id)}.json`);
}

/**
 * Told whenever a record changes, so the window's list can follow.
 *
 * The same shape `setDocumentWatcher` uses, and for the same reason: the writes
 * that matter most here do not come from the window at all. A conversation
 * files itself when its first turn finishes, deep in the agent loop, and
 * without this the rail went on showing a project one item light until
 * something else happened to refresh it.
 */
let watcher: (() => void) | undefined;

export function setProjectsWatcher(fn: (() => void) | undefined): void {
  watcher = fn;
}

export async function writeProject(project: Project): Promise<Project> {
  await makeOwnDir(projectsDir());
  const target = pathFor(project.id);
  const temp = `${target}.partial`;
  await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
  watcher?.();
  return project;
}

export async function readProject(id: string): Promise<Project | undefined> {
  try {
    return parseProject(JSON.parse(await readFile(pathFor(id), "utf8")), id);
  } catch {
    return undefined;
  }
}

export async function readAll(): Promise<Project[]> {
  let names: string[];
  try {
    names = await readdir(projectsDir());
  } catch {
    return [];
  }
  const out: Project[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const project = await readProject(name.slice(0, -5));
    if (project) out.push(project);
  }
  return out;
}

/**
 * Every ref each store currently holds, so a read can drop what has gone.
 *
 * One listing per kind rather than one existence check per member: a project
 * with forty images would otherwise be forty stat calls, and the listings are
 * what the add dialog needs anyway.
 */
async function aliveRefs(stores: ProjectStores): Promise<Partial<Record<MemberKind, Set<string>>>> {
  const alive: Partial<Record<MemberKind, Set<string>>> = {};
  for (const kind of Object.keys(stores) as MemberKind[]) {
    try {
      alive[kind] = new Set((await stores[kind].list()).map((r) => r.ref));
    } catch {
      /* A store that cannot be listed -- a meetings folder on an unplugged
         disk -- must not cause its members to be pruned. Treating the answer as
         "everything is still there" errs towards keeping a row that opens
         nothing, which is recoverable; the other way round is not. */
    }
  }
  return alive;
}

/** Prune every project against what the stores actually hold, and persist. */
export async function readAllPruned(stores: ProjectStores): Promise<Project[]> {
  const projects = await readAll();
  const alive = await aliveRefs(stores);
  const out: Project[] = [];
  for (const project of projects) {
    const pruned = pruneMembers(project, (m) => {
      const set = alive[m.kind];
      return !set || set.has(m.ref);
    });
    if (pruned !== project) await writeProject(pruned);
    out.push(pruned);
  }
  return out;
}

/**
 * Every ref of one kind that some project holds.
 *
 * What "delete all conversations" must not touch. Read unpruned on purpose:
 * pruning needs the stores and writes as it goes, and the only cost of a stale
 * member here is sparing a file that is already gone -- which costs nothing,
 * where the other direction costs the work.
 */
export async function filedRefs(kind: MemberKind): Promise<Set<string>> {
  const out = new Set<string>();
  for (const project of await readAll()) {
    for (const member of project.members) if (member.kind === kind) out.add(member.ref);
  }
  return out;
}

/**
 * Delete a project, and optionally everything in it.
 *
 * One member refusing does not abandon the rest. `deleteRun` declines to remove
 * a run that was written to in the last ninety seconds, which is exactly right
 * on its own page and would, if it aborted here, leave a project half emptied
 * with no account of what happened. So every failure is collected and reported,
 * and the project record goes last -- a project whose contents were not all
 * removed still exists to try again from.
 */
export async function deleteProject(
  project: Project,
  stores: ProjectStores,
  opts: { contents: boolean },
): Promise<DeleteReport> {
  const removed = new Map<MemberKind, number>();
  const failed: DeleteReport["failed"] = [];

  if (opts.contents) {
    for (const member of project.members) {
      try {
        /* Before `remove`, not at the door alone. A record on disk reaches
           here through `readProject`, which -- unlike `readAllPruned` -- does
           no pruning, so this is the last thing standing between a member's
           ref and `rm -rf`. A refusal joins the same `failed` list a live
           research run uses, so it is reported rather than swallowed and the
           other members are still removed. */
        await stores[member.kind].remove(stores[member.kind].assertRef(member.ref));
        removed.set(member.kind, (removed.get(member.kind) ?? 0) + 1);
      } catch (err) {
        failed.push({ kind: member.kind, ref: member.ref, error: (err as Error).message });
      }
    }
  }

  await rm(pathFor(project.id), { force: true });
  watcher?.();
  return { removed: [...removed].map(([kind, count]) => ({ kind, count })), failed };
}

/**
 * Put something into the active project, if there is one.
 *
 * Called at the five points where a thing comes into existence. Deliberately
 * silent and deliberately best-effort: a conversation must still be created if
 * the project record cannot be written, because the filing is a convenience and
 * the conversation is the work.
 */
export async function fileInActiveProject(
  config: ConfigStore,
  kind: MemberKind,
  ref: string,
): Promise<void> {
  const active = config.current.activeProject;
  if (!active || !ref) return;
  try {
    const projects = await readAll();
    if (!projects.some((p) => p.id === active)) return;
    const next = addMembers(projects, active, [{ kind, ref }]);
    for (const [i, project] of next.entries()) {
      if (project !== projects[i]) await writeProject(project);
    }
  } catch {
    /* Nothing the person did failed. Say nothing. */
  }
}
