/**
 * Which tasks are owed a reminder right now.
 *
 * Pure: given the task list and a clock, decide what to notify about. The
 * notification itself -- an Electron `Notification`, on a heartbeat -- lives
 * in [main/reminders.ts](../../main/reminders.ts).
 *
 * `notifiedAt` is the done-marker, the research pipeline's rule applied to a
 * notification: a restart must not re-fire this morning's reminder, and a
 * reminder missed while the app was closed fires once, late, rather than not
 * at all or twice.
 *
 * This is the FALLBACK path, not the primary one. A task promoted to a real
 * calendar event (a later phase, not yet built) is meant to get its reminder
 * from evolution-alarm-notify instead, which fires even with MyRA closed; the
 * rule that keeps the two from firing twice for one task is that `remindAt`
 * is cleared the moment a task gains a calendar entry, so this function only
 * ever sees tasks with no calendar entry of their own.
 */

import { TIME_OF_DAY, type Task } from "./task.ts";

/**
 * The instant a task's reminder is due, or nothing if it has none.
 *
 * `due` plus `remindAt` is a LOCAL wall clock -- "2026-09-16" at "09:00" in
 * `zone` -- resolved to an instant by the standard two-pass correction: guess
 * the instant as if it were UTC, read back what wall clock that instant shows
 * in `zone`, and correct by the difference. One pass is enough for every zone
 * that is a whole number of hours from UTC; the second pass is what keeps a
 * half-hour zone (`Asia/Kolkata`, `Australia/Adelaide`) from landing a reminder
 * on the wrong side of its own boundary.
 */
function remindInstant(task: Task, zone: string): number | undefined {
  if (!task.due || !task.remindAt) return undefined;
  const match = TIME_OF_DAY.exec(task.remindAt);
  if (!match) return undefined;
  const [y, m, d] = task.due.split("-").map(Number) as [number, number, number];
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const shown = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (type: string): number => Number(shown.find((p) => p.type === type)?.value ?? 0);
  const shownInstant = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return guess + (guess - shownInstant);
}

/**
 * Tasks whose reminder is due and has not fired yet.
 *
 * One reminder per task, ever, enforced right here: a task already carrying
 * `notifiedAt` is never returned again, so a restart replaying the same
 * minute does not re-notify. A completed task is excluded too -- finishing a
 * task before its reminder fires is not a missed deadline.
 */
export function dueNow(tasks: Task[], now: Date, zone: string): Task[] {
  const nowMs = now.getTime();
  return tasks.filter((t) => {
    if (t.completedAt || t.notifiedAt) return false;
    const at = remindInstant(t, zone);
    return at !== undefined && at <= nowMs;
  });
}
