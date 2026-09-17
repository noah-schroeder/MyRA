/**
 * The fallback reminder heartbeat.
 *
 * A 60s tick rather than one setTimeout per task: a nine-hour timer does not
 * survive a closed laptop lid, firing either never (the system was suspended
 * through it) or all at once on resume -- the same shape of bug meetings
 * avoid by transcribing tracks serially rather than trusting a long-lived
 * timer to survive the meeting.
 *
 * This is the FALLBACK, not the primary, path -- see core/tasks/remind.ts's
 * header. A task promoted to a real calendar event is meant to get its
 * reminder from the OS calendar's own alarm daemon instead, which fires even
 * with MyRA closed; that promotion does not exist yet, so today every task
 * with a `remindAt` runs through this heartbeat.
 *
 * Never triggers a network request, a calendar refresh, or any other side
 * effect beyond a local Notification and a disk write marking the task
 * notified. destinations.ts's "nothing is contacted on a timer" stays true
 * because this timer contacts nothing.
 */

import { Notification } from "electron";
import { localZone } from "../core/time.ts";
import { dueNow } from "../core/tasks/remind.ts";
import { listTasks, markNotified } from "../core/tasks/store.ts";

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Returns whether a notification actually went up.
 *
 * The caller uses this to decide whether `notifiedAt` gets written: a
 * desktop with no notification service (`isSupported()` false, common
 * outside GNOME/KDE) previously still had the task marked notified, which is
 * how a reminder was lost for good on exactly the machines least able to
 * show one. Leaving `notifiedAt` unset instead means `dueNow` keeps
 * returning it every tick -- noisy in a log nobody reads, but the honest
 * alternative to a reminder that silently never happened. The task is still
 * visible with its due badge on the Tasks page either way.
 */
function notify(title: string, due: string): boolean {
  try {
    if (!Notification.isSupported()) return false;
    new Notification({
      title: "Task due",
      /* The title is shown deliberately: a task list's whole value is saying
         what the task IS, and a notification that hid it would be useless.
         It is a real lock-screen consideration all the same -- "Review
         Frank's manuscript" visible in a shared office -- noted here rather
         than solved; a count-only mode is the natural next step if it comes
         up in practice. */
      body: due ? `${title} (due ${due})` : title,
    }).show();
    return true;
  } catch {
    // A desktop with no notification service is not a reason to crash the tick.
    return false;
  }
}

let inFlight = false;

/**
 * One tick reads the list, notifies, and marks -- three awaited steps, and
 * `setInterval` does not wait for a previous call to finish before starting
 * the next one. Without this guard a tick slow enough to still be running
 * (a large task list, a slow disk) would overlap the next one, and both
 * would see the same task as not yet notified and fire it twice.
 */
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const zone = localZone();
    const now = new Date();
    const owed = dueNow(await listTasks(), now, zone);
    for (const task of owed) {
      if (notify(task.title, task.due)) await markNotified(task.id, now);
    }
  } finally {
    inFlight = false;
  }
}

/** Starts the heartbeat. Idempotent: a second call while one is already
 *  running leaves the existing timer alone rather than doubling the rate. */
export function startReminders(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // Never a reason to hold the process open on its own -- the main.ts precedent.
  timer.unref?.();
  void tick();
}

export function stopReminders(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
