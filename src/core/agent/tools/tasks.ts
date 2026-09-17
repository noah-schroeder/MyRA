/**
 * The user's task list, which is MyRA's own file.
 *
 * ## Why these are `write` and not `system_of_record`
 *
 * policy.ts names "tasks" in its description of `system_of_record`, and that
 * sentence is about the user's REAL task list -- the one in their phone,
 * shared with their calendar and their colleagues, where a wrongly ticked
 * item is gone from a system this app does not own and cannot undo.
 *
 * This is not that. It is a flat directory of JSON files under MyRA's own
 * tasksRoot, created by MyRA, read by one page in MyRA, and visible in no
 * other program. It is the same category as write_document: a write confined
 * to the app's own folder, which is exactly what `write` is defined as.
 * Ticking one off is reversible from the page, and creating one is reversible
 * by deleting it.
 *
 * Classifying it `system_of_record` would put a modal in front of every "make
 * me a task" in every permission mode, floor classes being unlowerable by
 * design -- and the friction that drives people into yolo is the thing
 * yolo's own comment in policy.ts warns about. The floor exists for writes
 * that leave the sandbox. This one does not leave it.
 *
 * The day any of this writes to the user's REAL calendar or task list, that
 * changes -- see the matching note in policy.ts. A future `add_calendar_event`
 * tool, writing into an external calendar app, is `system_of_record` for
 * exactly this reason.
 */

import { localZone, normaliseDay } from "../../time.ts";
import { actsLocally, readResearchConfig } from "../../research/config.ts";
import { newTask, TIME_OF_DAY, type Task } from "../../tasks/task.ts";
import { formatTasks } from "../../tasks/format.ts";
import type { ToolDef } from "../registry.ts";

/**
 * What the app must attach: a way to reach the task store.
 *
 * The disk read/write lives in the main process, like every other store in
 * this app. Left uninstalled the tools REFUSE rather than pretending the
 * list is empty -- the [library.ts](./library.ts) rule: "nothing matched"
 * and "nothing was asked" are different answers.
 */
export interface TaskHost {
  list(): Promise<Task[]>;
  /** Given an already-built Task (create_task builds it with newTask()), save
   *  it and return the stored copy. */
  create(task: Task): Promise<Task>;
  /** Nothing, if no task has this id -- never a silent success. */
  complete(id: string): Promise<Task | undefined>;
}

let host: TaskHost | undefined;

export function setTaskHost(installed: TaskHost | undefined): void {
  host = installed;
}

/**
 * The gate.
 *
 * Not platform-gated, unlike a calendar tool would be: a task list is a JSON
 * directory and works on every OS. Gated on `actsLocally` for the reason
 * ladder.ts states -- an ungated tool here would make "off" a lie, and a test
 * pins the schema being literally empty at that rung.
 */
function available(): boolean {
  return actsLocally(readResearchConfig().mode);
}

function requireHost(): TaskHost {
  if (!host) {
    throw new Error(
      "The task list is not available: the app has not attached a task host. " +
        "This is a wiring fault, not something to work around.",
    );
  }
  return host;
}

export const createTaskTool: ToolDef = {
  name: "create_task",
  description:
    "Add one task to the user's MyRA task list. This list lives inside MyRA: it is not " +
    "their calendar and it is not any other program, so nothing written here shows up " +
    "anywhere else. `title` is one short line in the user's own words -- what they said " +
    "to do, not a summary of the conversation. `due` is the calendar day it should be " +
    "done on, as YYYY-MM-DD, or the single word today or tomorrow; leave it out entirely " +
    "for a task with no particular day, which is better than guessing one. Anything the " +
    "user said that does not fit in the title goes in `notes`. One task per thing to do: " +
    "two tasks are better than one task with \"and\" in the middle of it. `remindAt` asks " +
    "for a local notification at that time on the due date -- only set it when the user " +
    "gave an actual time (\"remind me at 9\"), never as a guess, and never without `due`: " +
    "a reminder needs a day to land on.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line: the thing to do" },
      due: { type: "string", description: "YYYY-MM-DD, or today, or tomorrow. Omit for no particular day." },
      notes: { type: "string", description: "Anything else the user said about it" },
      remindAt: {
        type: "string",
        description: "HH:MM, 24-hour, local time -- e.g. 09:00. Omit unless the user named a time.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
  async handler(params) {
    const taskHost = requireHost();
    const title = String(params["title"] ?? "").trim();
    if (!title) throw new Error("create_task was given no title");

    const zone = localZone();
    const now = new Date();
    const rawDue = String(params["due"] ?? "").trim();
    let due = "";
    if (rawDue) {
      const normalised = normaliseDay(rawDue, now, zone);
      if (!normalised) {
        throw new Error(
          `\`due\` must be YYYY-MM-DD, today, or tomorrow -- not ${JSON.stringify(rawDue)}. ` +
            `Today is ${normaliseDay("today", now, zone)}.`,
        );
      }
      due = normalised;
    }

    // A reminder with no due date has no day to fire on -- the same rule
    // main/tasks.ts's IPC handler applies to the manual form, applied here so
    // the two ways of making a task cannot disagree about what a bare
    // `remindAt` means.
    const rawRemindAt = String(params["remindAt"] ?? "").trim();
    if (rawRemindAt && !TIME_OF_DAY.test(rawRemindAt)) {
      throw new Error(`\`remindAt\` must be HH:MM, 24-hour -- not ${JSON.stringify(rawRemindAt)}.`);
    }
    const remindAt = due && rawRemindAt ? rawRemindAt : "";

    const task = newTask({
      title,
      notes: String(params["notes"] ?? ""),
      ...(due ? { due } : {}),
      ...(remindAt ? { remindAt } : {}),
      now,
    });
    const stored = await taskHost.create(task);
    return {
      content:
        `Added "${stored.title}"${stored.due ? ` for ${stored.due}` : ""}` +
        `${stored.remindAt ? ` with a reminder at ${stored.remindAt}` : ""} to the task list. ` +
        `id: ${stored.id}`,
      detail: { id: stored.id, due: stored.due, ...(stored.remindAt ? { remindAt: stored.remindAt } : {}) },
    };
  },
};

export const listTasksTool: ToolDef = {
  name: "list_tasks",
  description:
    "List what is on the user's MyRA task list. With no arguments it returns the tasks " +
    "that are not done yet, soonest due first, with the ones that have no day listed " +
    "last. Pass status \"done\" for the finished ones, or \"all\" for both. Each task " +
    "comes back with the id that complete_task needs. Call this before adding a task, so " +
    "the user does not end up with the same thing twice.",
  risk: "safe",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: "\"open\" (default), \"done\", or \"all\"" },
    },
    additionalProperties: false,
  },
  async handler(params) {
    const taskHost = requireHost();
    const rawStatus = String(params["status"] ?? "open");
    const status = rawStatus === "done" || rawStatus === "all" ? rawStatus : "open";
    const all = await taskHost.list();
    const filtered = all.filter((t) => {
      const done = Boolean(t.completedAt);
      if (status === "open") return !done;
      if (status === "done") return done;
      return true;
    });
    const heading =
      status === "open" ? "Open tasks" : status === "done" ? "Completed tasks" : "All tasks";
    return {
      content: formatTasks(filtered, heading),
      detail: { count: filtered.length, status },
    };
  },
};

export const completeTaskTool: ToolDef = {
  name: "complete_task",
  description:
    "Tick a task off the user's MyRA task list. `id` must be one you were given in this " +
    "conversation by list_tasks or create_task -- never a title, and never an id you have " +
    "guessed or reconstructed. Ticking off is undoable from the Tasks page, so this is not " +
    "destructive; it is still the user's list, so only do it when they have said the thing " +
    "is done, not when you think it probably is.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The task's id, exactly as given by list_tasks or create_task" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(params) {
    const taskHost = requireHost();
    const id = String(params["id"] ?? "").trim();
    if (!id) throw new Error("complete_task was given no id");
    const updated = await taskHost.complete(id);
    if (!updated) {
      throw new Error(
        `There is no task with id ${JSON.stringify(id)}. Call list_tasks to see the ` +
          "current ids -- do not guess one.",
      );
    }
    return {
      content: `Marked "${updated.title}" as done.`,
      detail: { id: updated.id },
    };
  },
};

export const TASK_TOOL_DEFS: ToolDef[] = [createTaskTool, listTasksTool, completeTaskTool];
