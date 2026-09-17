/**
 * Tasks on disk.
 *
 * What a file is called, where the folder lives, how a record that has been
 * edited, truncated, or half-written is turned back into something the page
 * can draw -- and the reads and writes themselves. All of it belongs here
 * rather than split with main/tasks.ts, on the same rule core/meetings/store.ts
 * already follows: this file touches `node:fs` but never `electron`, so
 * `deleteTask` -- the one operation here that is actually destructive -- can
 * be exercised by `node:test` directly instead of only through a live
 * Electron window. main/tasks.ts is left with exactly two things that
 * genuinely need Electron: the IPC wiring, and telling the window a save
 * happened.
 *
 * A flat `<id>.json` each, the papers/images precedent: one task, one file,
 * no directory holding it. `parseRecord` is forgiving the same way theirs is:
 * a list that throws on the fifth of forty tasks is worse than one that skips
 * it, and skipping is visible because the count on the page stops matching
 * what the author remembers adding.
 */

import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../paths.ts";
import { assertTaskId, byDue, summaryOf, TIME_OF_DAY, type Task, type TaskSummary } from "./task.ts";

export const TASK_EXT = ".json";

/**
 * Where tasks are kept: MyRA's own folder, not a settable `~/Documents` root.
 *
 * Unlike papersRoot/imagesRoot/reviewsRoot, there is no "we invite you to
 * open this folder and see what is in it" argument for a task list -- it is
 * read by one page in MyRA and no other program -- so it follows
 * `projectsDir()`'s precedent (src/main/projectStore.ts) rather than the
 * Settings-field one: an env override for tests, MyRA's own config directory
 * otherwise.
 */
export function tasksRoot(): string {
  return process.env["MYRA_TASKS_DIR"] ?? join(CONFIG_DIR, "tasks");
}

export function taskFileName(id: string): string {
  return `${id}${TASK_EXT}`;
}

/** The id a filename belongs to, or nothing if it is not one of ours. */
export function idOfFile(filename: string): string | undefined {
  if (!filename.endsWith(TASK_EXT)) return undefined;
  const id = filename.slice(0, -TASK_EXT.length);
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".." ? id : undefined;
}

function text(row: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof row[key] === "string" ? (row[key] as string) : fallback;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a "YYYY-MM-DD" string is a real calendar date, not merely shaped
 *  like one -- "2026-13-40" matches DAY_KEY and is not a day. Not shared with
 *  core/time.ts's own check: that one exists to compute "tomorrow" from a
 *  Date, this one only ever validates a string that arrived from disk, and
 *  the two have no reason to agree on a signature. */
export function isRealDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * Rebuilt field by field, never spread -- the `papers/store.ts` rule. A task
 * with a garbage `due` comes back undated rather than dropped or crashing the
 * whole list; a task with no title at all still comes back as "Untitled
 * task" rather than vanishing from a list whose length the author remembers.
 */
export function parseRecord(raw: unknown, id: string): Task | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const due = text(row, "due");
  const remindAt = text(row, "remindAt");
  const completedAt = text(row, "completedAt");
  const notifiedAt = text(row, "notifiedAt");
  const project = text(row, "project");
  const now = new Date().toISOString();
  return {
    id,
    title: text(row, "title") || "Untitled task",
    notes: text(row, "notes"),
    due: DAY_KEY.test(due) && isRealDay(due) ? due : "",
    createdAt: text(row, "createdAt") || now,
    updatedAt: text(row, "updatedAt") || now,
    ...(completedAt ? { completedAt } : {}),
    ...(project ? { project } : {}),
    ...(TIME_OF_DAY.test(remindAt) ? { remindAt } : {}),
    ...(notifiedAt ? { notifiedAt } : {}),
  };
}

export async function readTask(id: string): Promise<Task | undefined> {
  try {
    const raw = await readFile(join(tasksRoot(), taskFileName(assertTaskId(id))), "utf8");
    return parseRecord(JSON.parse(raw), id);
  } catch {
    /* Missing, unparseable, or half-written. The list already skips what it
       cannot read; opening one directly says so instead. */
    return undefined;
  }
}

/** Write the record via a temporary name -- the rename is what makes a save
 *  atomic, the papers.ts / images.ts convention throughout this app. */
export async function saveTask(task: Task): Promise<Task> {
  const root = tasksRoot();
  await makeOwnDir(root);
  const stored: Task = { ...task, updatedAt: new Date().toISOString() };
  const target = join(root, taskFileName(assertTaskId(task.id)));
  const temp = `${target}.partial`;
  await writeFile(temp, JSON.stringify(stored, null, 2), { mode: OWNER_ONLY_FILE });
  await rename(temp, target);
  return stored;
}

export async function listTasks(): Promise<Task[]> {
  let names: string[];
  try {
    names = await readdir(tasksRoot());
  } catch {
    return [];
  }
  const out: Task[] = [];
  for (const name of names) {
    const id = idOfFile(name);
    if (!id) continue;
    const task = await readTask(id);
    if (task) out.push(task);
  }
  return out;
}

export async function listTaskSummaries(): Promise<TaskSummary[]> {
  return (await listTasks()).map(summaryOf).sort(byDue);
}

export async function deleteTask(id: string): Promise<void> {
  await rm(join(tasksRoot(), taskFileName(assertTaskId(id))), { force: true });
}

/**
 * Mark a task notified. Exported for main/reminders.ts's heartbeat, which is
 * the only other caller: it is how `notifiedAt` becomes the done-marker that
 * stops a restart re-firing this morning's reminder.
 */
export async function markNotified(id: string, now = new Date()): Promise<Task | undefined> {
  const existing = await readTask(id);
  if (!existing) return undefined;
  return await saveTask({ ...existing, notifiedAt: now.toISOString() });
}
