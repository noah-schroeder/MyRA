/**
 * A task: MyRA's own list, and never the user's real one.
 *
 * The pure half, so it is testable with no Electron and no disk. What touches
 * a filesystem lives in [main/tasks.ts](../../main/tasks.ts).
 *
 * Deliberately not a `MemberKind` in projects/project.ts. A `MemberKind` must
 * satisfy `KindStore`'s `payload`, and a task's payload does not work: a
 * project export would produce one file per task holding one line, where what
 * anyone actually wants is a single Tasks.md section listing all of them. So
 * a task instead carries its own optional `project`, which costs one field
 * and closes no doors -- see the note on this in tools/tasks.ts if it is ever
 * revisited.
 */

/**
 * "09:00" -- the only shape `remindAt` may hold, and every reader of it.
 *
 * Exported so the store's `parseRecord`, the reminder engine's
 * `remindInstant`, the `myra:task-create` IPC handler and `create_task`'s
 * own validation all check it the same way -- four copies of this pattern
 * had drifted apart into slightly different spellings before this existed,
 * which is exactly how a value that passes one check and fails another
 * happens.
 */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A short, human-legible, filesystem-safe id: date, time, and a title slug.
 *
 * Salted, unlike paperId: tasks are made in bursts -- "make me three tasks"
 * in one turn -- so two created in the same second is the ordinary case here,
 * not the rare one. */
function randomSalt(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}

export function taskId(title: string, now = new Date(), salt = randomSalt()): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "task"}-${salt}`;
}

/**
 * A task id, refused if it is anything but one.
 *
 * The same guard `assertPaperId`/`assertImageId`/`assertRunId` are, for the
 * same reason: this comes back from the window to be joined onto the tasks
 * root and then read, completed and deleted.
 */
export function assertTaskId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no task named ${JSON.stringify(id)}`);
  }
  return id;
}

export interface Task {
  id: string;
  /** One line, in the user's own words. The whole task, usually. */
  title: string;
  /** Anything that did not fit in the title. Never instructions to a model. */
  notes: string;
  /**
   * The local calendar day this is meant for, "YYYY-MM-DD". Empty means
   * someday -- a day is asked for, never invented, when the user did not
   * give one.
   *
   * A day and not an instant, deliberately: MyRA never alarms at a moment, a
   * task is a day rather than a point in time, and a day key compares with
   * `<` and needs no zone at all. The whole timezone question stops at the
   * calendar's edge because of this one field.
   */
  due: string;
  /**
   * Present exactly when it is done, and it is the time it was done.
   *
   * Not `done: boolean` beside a timestamp: two fields that can disagree, and
   * a plain boolean cannot answer "what did I finish this week", which is the
   * first thing anybody asks a task list.
   */
  completedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
  /** The project that was open when it was made. Empty means none. */
  project?: string | undefined;
  /** Local time of day, "09:00", a reminder fires at -- see remind.ts. Empty
   *  means no reminder for this task. */
  remindAt?: string | undefined;
  /** Set once a reminder has fired, so a restart does not fire it twice. */
  notifiedAt?: string | undefined;
}

/** What a list on the page shows, without reading every record. */
export interface TaskSummary {
  id: string;
  title: string;
  due: string;
  done: boolean;
  project?: string | undefined;
  /** Shown as a small badge beside the due date when set. */
  remindAt?: string | undefined;
}

export function newTask(opts: {
  title: string;
  notes?: string;
  due?: string;
  project?: string;
  remindAt?: string;
  now?: Date;
}): Task {
  const now = opts.now ?? new Date();
  const title = opts.title.trim() || "Untitled task";
  return {
    id: taskId(title, now),
    title,
    notes: opts.notes?.trim() ?? "",
    due: opts.due ?? "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.remindAt ? { remindAt: opts.remindAt } : {}),
  };
}

export function summaryOf(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    due: task.due,
    done: Boolean(task.completedAt),
    ...(task.project ? { project: task.project } : {}),
    ...(task.remindAt ? { remindAt: task.remindAt } : {}),
  };
}

/** Marks a task done at `now`. Idempotent: completing an already-done task
 *  keeps its original completion time rather than bumping it to now, since
 *  "when was this actually finished" is the fact worth keeping. */
export function complete(task: Task, now = new Date()): Task {
  if (task.completedAt) return task;
  return { ...task, completedAt: now.toISOString(), updatedAt: now.toISOString() };
}

/** Undoes a completion. The Tasks page's undo button, and the reason
 *  ticking a task off is not classed as destructive. */
export function reopen(task: Task, now = new Date()): Task {
  if (!task.completedAt) return task;
  const { completedAt: _drop, ...rest } = task;
  return { ...rest, updatedAt: now.toISOString() };
}

/** Soonest due first; undated tasks last, because a list that put "someday"
 *  ahead of "due tomorrow" would be answering the wrong question. */
export function byDue(a: TaskSummary, b: TaskSummary): number {
  if (a.due && b.due) return a.due.localeCompare(b.due) || a.id.localeCompare(b.id);
  if (a.due) return -1;
  if (b.due) return 1;
  return b.id.localeCompare(a.id);
}
