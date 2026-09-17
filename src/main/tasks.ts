/**
 * The IPC/tool wiring around tasks.
 *
 * The reads and writes themselves live in
 * [core/tasks/store.ts](../core/tasks/store.ts) now, not here -- see that
 * file's header for why. This file is left with exactly what actually needs
 * Electron: `ipcMain`, and telling the window a save happened.
 */

import { ipcMain } from "electron";

import type { ConfigStore } from "../core/config.ts";
import { complete, newTask, reopen, TIME_OF_DAY, type Task } from "../core/tasks/task.ts";
import {
  deleteTask, isRealDay, listTasks, listTaskSummaries, readTask, saveTask,
} from "../core/tasks/store.ts";
import type { TaskHost } from "../core/agent/tools/tasks.ts";

export interface TaskDeps {
  config: ConfigStore;
  send: (channel: string, payload?: unknown) => void;
}

/**
 * Save a task, filing it under the active project when it did not already
 * name one -- the same moment every other kind of work in this app learns
 * where it belongs. Not `fileInActiveProject`: that call adds a `Member` to
 * the project's index, which assumes `KindStore.payload` can render the
 * thing, and a task's payload does not (see core/tasks/task.ts). Setting the
 * field directly costs nothing and closes no doors if that changes later.
 *
 * Exported because main/meetings.ts is now a second caller: turning a
 * meeting's action item into a task is the same "save it, file it, publish
 * it" operation this already was, and a second copy of it is a second place
 * to fix the same bug.
 */
export async function createAndSave(deps: TaskDeps, task: Task): Promise<Task> {
  const active = deps.config.current.activeProject;
  const withProject = !task.project && active ? { ...task, project: active } : task;
  const stored = await saveTask(withProject);
  deps.send("myra:tasks", await listTaskSummaries());
  return stored;
}

/**
 * What the agent tool sees.
 *
 * `create` is handed an already-built Task -- create_task built it with
 * newTask() -- so this only has to file, save and publish it.
 */
export function taskHost(deps: TaskDeps): TaskHost {
  return {
    async list() {
      return await listTasks();
    },
    async create(task) {
      return await createAndSave(deps, task);
    },
    async complete(id) {
      const existing = await readTask(id);
      if (!existing) return undefined;
      const updated = await saveTask(complete(existing));
      deps.send("myra:tasks", await listTaskSummaries());
      return updated;
    },
  };
}

export function installTaskIpc(deps: TaskDeps): void {
  ipcMain.handle("myra:task-list", async () => ({
    ok: true,
    tasks: await listTaskSummaries(),
  }));

  ipcMain.handle("myra:task-create", async (_e, raw: unknown) => {
    const row = (raw ?? {}) as { title?: unknown; due?: unknown; notes?: unknown; remindAt?: unknown };
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) return { ok: false, error: "A task needs a title." };
    const due =
      typeof row.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.due) && isRealDay(row.due)
        ? row.due
        : "";
    const notes = typeof row.notes === "string" ? row.notes : "";
    // A reminder with no due date has no day to fire on, so it is dropped
    // rather than stored as a time-of-day nothing anchors -- the same
    // "the field it depends on is missing, so this one is not kept either"
    // rule the research config's collection scope already follows.
    const remindAt =
      due && typeof row.remindAt === "string" && TIME_OF_DAY.test(row.remindAt)
        ? row.remindAt
        : "";
    const task = newTask({ title, notes, ...(due ? { due } : {}), ...(remindAt ? { remindAt } : {}) });
    const stored = await createAndSave(deps, task);
    return { ok: true, task: stored, tasks: await listTaskSummaries() };
  });

  ipcMain.handle("myra:task-complete", async (_e, id: unknown) => {
    const existing = await readTask(String(id));
    if (!existing) return { ok: false, error: "That task could not be found." };
    const updated = await saveTask(complete(existing));
    const tasks = await listTaskSummaries();
    deps.send("myra:tasks", tasks);
    return { ok: true, task: updated, tasks };
  });

  ipcMain.handle("myra:task-reopen", async (_e, id: unknown) => {
    const existing = await readTask(String(id));
    if (!existing) return { ok: false, error: "That task could not be found." };
    const updated = await saveTask(reopen(existing));
    const tasks = await listTaskSummaries();
    deps.send("myra:tasks", tasks);
    return { ok: true, task: updated, tasks };
  });

  ipcMain.handle("myra:task-delete", async (_e, id: unknown) => {
    await deleteTask(String(id));
    const tasks = await listTaskSummaries();
    deps.send("myra:tasks", tasks);
    return { ok: true, tasks };
  });
}
