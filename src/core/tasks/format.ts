/**
 * Tasks, as the text a model reads.
 *
 * Pure, so a tool's reply is testable character for character -- the
 * `papers/prompt.ts` habit of keeping formatting apart from the network or
 * disk code that produces what it formats.
 */

import type { Task } from "./task.ts";

function line(task: Task): string {
  const status = task.completedAt ? "done" : task.due ? `due ${task.due}` : "no due date";
  const notes = task.notes.trim() ? ` — ${task.notes.trim()}` : "";
  return `- ${task.title} (${status}, id ${task.id})${notes}`;
}

/** `heading` is passed in rather than chosen here, because which one applies
 *  depends on which status was asked for -- a question list_tasks answers,
 *  not this module. */
export function formatTasks(tasks: Task[], heading: string): string {
  if (!tasks.length) return `${heading}\n\n(none)`;
  return [heading, "", ...tasks.map(line)].join("\n");
}
