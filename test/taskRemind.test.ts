/**
 * Which tasks are owed a reminder right now.
 *
 * The concrete failure this guards: a reminder computed in UTC lands an hour
 * or more off the time the user actually typed, silently, for anyone not in
 * that zone -- and a half-hour zone (Kolkata, Adelaide) is wrong by a
 * different amount than a whole-hour one, so both are tested rather than
 * only the whole-hour case that happens to be easy to get right by accident.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dueNow } from "../src/core/tasks/remind.ts";
import { newTask } from "../src/core/tasks/task.ts";

describe("dueNow", () => {
  it("fires once the reminder's local time has actually arrived, in the given zone", () => {
    const task = newTask({ title: "t", due: "2026-09-16", remindAt: "09:00" });
    // Berlin is UTC+2 in September, so 09:00 Berlin is 07:00 UTC.
    const before = new Date(Date.UTC(2026, 8, 16, 6, 59));
    const at = new Date(Date.UTC(2026, 8, 16, 7, 0));
    assert.deepEqual(dueNow([task], before, "Europe/Berlin"), []);
    assert.deepEqual(dueNow([task], at, "Europe/Berlin").map((t) => t.id), [task.id]);
  });

  it("gets a half-hour-offset zone right, not just whole-hour ones", () => {
    // Asia/Kolkata is UTC+5:30. 09:00 IST is 03:30 UTC -- a zone a one-pass
    // or truncating implementation is more likely to get wrong than a
    // whole-hour zone happens to expose.
    const task = newTask({ title: "t", due: "2026-09-16", remindAt: "09:00" });
    const before = new Date(Date.UTC(2026, 8, 16, 3, 29));
    const at = new Date(Date.UTC(2026, 8, 16, 3, 30));
    assert.deepEqual(dueNow([task], before, "Asia/Kolkata"), []);
    assert.deepEqual(dueNow([task], at, "Asia/Kolkata").map((t) => t.id), [task.id]);
  });

  it("a reminder already fired does not fire again across a restart", () => {
    const fired = { ...newTask({ title: "t", due: "2026-09-16", remindAt: "09:00" }), notifiedAt: "2026-09-16T07:00:00.000Z" };
    const now = new Date(Date.UTC(2026, 8, 16, 12, 0));
    assert.deepEqual(dueNow([fired], now, "Europe/Berlin"), []);
  });

  it("a task finished before its reminder time is not owed one", () => {
    const done = { ...newTask({ title: "t", due: "2026-09-16", remindAt: "09:00" }), completedAt: "2026-09-16T06:00:00.000Z" };
    const now = new Date(Date.UTC(2026, 8, 16, 12, 0));
    assert.deepEqual(dueNow([done], now, "Europe/Berlin"), []);
  });

  it("a task with no remindAt, or no due date, is never owed one", () => {
    const noReminder = newTask({ title: "t", due: "2026-09-16" });
    const noDue = newTask({ title: "t", remindAt: "09:00" });
    const now = new Date(Date.UTC(2030, 0, 1));
    assert.deepEqual(dueNow([noReminder, noDue], now, "Europe/Berlin"), []);
  });

  it("a malformed remindAt is treated as no reminder, not a crash", () => {
    const task = { ...newTask({ title: "t", due: "2026-09-16" }), remindAt: "9am" };
    assert.deepEqual(dueNow([task], new Date(Date.UTC(2030, 0, 1)), "Europe/Berlin"), []);
  });

  it("picks out only the owed tasks from a mixed list", () => {
    const owed = newTask({ title: "owed", due: "2026-09-16", remindAt: "09:00" });
    const notYet = newTask({ title: "not yet", due: "2026-09-20", remindAt: "09:00" });
    const now = new Date(Date.UTC(2026, 8, 16, 12, 0));
    assert.deepEqual(dueNow([owed, notYet], now, "Europe/Berlin").map((t) => t.title), ["owed"]);
  });
});
