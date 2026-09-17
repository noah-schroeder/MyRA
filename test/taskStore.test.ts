/**
 * The task record: the id that becomes a path, and the file read back.
 *
 * The same two hazards papers/paper.ts already met: the id comes back from a
 * sandboxed window to be joined onto the tasks root and then read, completed
 * and deleted -- the same journey a paper or image id makes, and the reason
 * `assertPaperId`/`assertImageId`/`assertRunId` exist. And the record can be
 * edited, truncated, or half-written before MyRA reads it back, so
 * `parseRecord` is forgiving the same way theirs is.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertTaskId, byDue, complete, newTask, reopen, summaryOf, taskId,
} from "../src/core/tasks/task.ts";
import {
  deleteTask, idOfFile, isRealDay, listTasks, listTaskSummaries, markNotified, parseRecord,
  readTask, saveTask,
} from "../src/core/tasks/store.ts";

/**
 * `tasksRoot()` reads `MYRA_TASKS_DIR` fresh on every call rather than once at
 * import time (unlike `CONFIG_DIR`), so a test can point it at a scratch
 * directory without needing `test/setup.ts`'s import-order trick.
 */
async function withTasksDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "myra-tasks-"));
  const prev = process.env["MYRA_TASKS_DIR"];
  process.env["MYRA_TASKS_DIR"] = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["MYRA_TASKS_DIR"];
    else process.env["MYRA_TASKS_DIR"] = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("a task id", () => {
  it("is legible, dated by the clock a file manager prints, and salted", () => {
    const id = taskId("Review Frank's paper", new Date(2026, 8, 15, 14, 5, 30), "ab12");
    assert.equal(id, "20260915-140530-review-frank-s-paper-ab12");
  });

  it("refuses anything that is not one", () => {
    for (const bad of ["../secrets", "a/b", ".", "..", "", "with space", "a\0b"]) {
      assert.throws(() => assertTaskId(bad), /no task named/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(assertTaskId("20260915-140530-a_b.c-d"), "20260915-140530-a_b.c-d");
  });

  it("recognises its own filenames and nothing else", () => {
    assert.equal(idOfFile("20260915-140530-task.json"), "20260915-140530-task");
    assert.equal(idOfFile("notes.txt"), undefined);
    assert.equal(idOfFile("../escape.json"), undefined);
    assert.equal(idOfFile("..json"), undefined);
  });

  it("two tasks made in the same second still get different ids", () => {
    // Unlike paperId, salted by default rather than on request: "make me
    // three tasks" is a normal thing to ask for in one turn, and two records
    // that collided on id would silently overwrite each other on disk.
    const now = new Date(2026, 8, 15, 14, 5, 30);
    assert.notEqual(taskId("Review", now), taskId("Review", now));
  });
});

describe("parseRecord", () => {
  it("rebuilds a well-formed task", () => {
    const raw = {
      title: "Review Frank's paper", notes: "before Friday", due: "2026-09-16",
      createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    };
    const task = parseRecord(raw, "abc")!;
    assert.equal(task.id, "abc");
    assert.equal(task.title, raw.title);
    assert.equal(task.notes, raw.notes);
    assert.equal(task.due, "2026-09-16");
    assert.equal(task.completedAt, undefined);
  });

  it("gives a task with no title back as Untitled rather than dropping it", () => {
    assert.equal(parseRecord({}, "x")!.title, "Untitled task");
  });

  it("drops a due date that is not a real calendar date, rather than storing junk", () => {
    for (const bad of ["tomorrow", "2026-13-40", "2026-02-30", "16/09/2026", 42]) {
      assert.equal(parseRecord({ title: "t", due: bad }, "x")!.due, "", JSON.stringify(bad));
    }
  });

  it("refuses a whole record that is not an object", () => {
    for (const bad of [null, "a string", 5, ["array"]]) {
      assert.equal(parseRecord(bad, "x"), undefined, JSON.stringify(bad));
    }
  });

  it("keeps completedAt, project and remindAt only when they are well-formed", () => {
    const good = parseRecord(
      { title: "t", completedAt: "2026-09-15T00:00:00.000Z", project: "p1", remindAt: "09:00" },
      "x",
    )!;
    assert.equal(good.completedAt, "2026-09-15T00:00:00.000Z");
    assert.equal(good.project, "p1");
    assert.equal(good.remindAt, "09:00");

    const bad = parseRecord({ title: "t", remindAt: "9am" }, "x")!;
    assert.equal(bad.remindAt, undefined);
  });
});

describe("completing and reopening", () => {
  it("is idempotent: completing an already-done task keeps its original time", () => {
    const now1 = new Date(2026, 8, 15, 10, 0);
    const now2 = new Date(2026, 8, 16, 10, 0);
    const done = complete(newTask({ title: "t", now: now1 }), now1);
    const again = complete(done, now2);
    assert.equal(again.completedAt, done.completedAt);
  });

  it("reopen clears completedAt", () => {
    const done = complete(newTask({ title: "t" }));
    assert.equal(reopen(done).completedAt, undefined);
  });

  it("reopening an already-open task is a no-op", () => {
    const open = newTask({ title: "t" });
    assert.deepEqual(reopen(open), open);
  });
});

describe("summaryOf and byDue", () => {
  it("sorts dated tasks soonest first, undated ones last", () => {
    const t1 = summaryOf(newTask({ title: "no date" }));
    const t2 = summaryOf(newTask({ title: "later", due: "2026-09-20" }));
    const t3 = summaryOf(newTask({ title: "sooner", due: "2026-09-16" }));
    const sorted = [t1, t2, t3].sort(byDue);
    assert.deepEqual(sorted.map((t) => t.title), ["sooner", "later", "no date"]);
  });
});

describe("isRealDay", () => {
  it("accepts a real calendar date and rejects one merely shaped like one", () => {
    assert.equal(isRealDay("2026-09-16"), true);
    assert.equal(isRealDay("2026-13-40"), false);
    assert.equal(isRealDay("2026-02-30"), false);
  });
});

/*
 * These read and write the filesystem, which is exactly the point: `saveTask`,
 * `deleteTask` and the rest used to live in main/tasks.ts, a file that imports
 * `electron` and so cannot be loaded by `node:test` at all -- meaning
 * `deleteTask`, the one destructive operation in this module, had no test
 * that could touch it directly. Now that the reads and writes live in
 * core/tasks/store.ts (see its header), they can be exercised the same way
 * every other store in this app already is.
 */
describe("tasks on disk", () => {
  it("round-trips a task through save and read", async () => {
    await withTasksDir(async () => {
      const task = newTask({ title: "Review Frank's paper", due: "2026-09-20" });
      await saveTask(task);
      const back = await readTask(task.id);
      assert.equal(back?.title, task.title);
      assert.equal(back?.due, task.due);
    });
  });

  it("a missing or unreadable task reads as undefined, not a throw", async () => {
    await withTasksDir(async () => {
      assert.equal(await readTask("no-such-task"), undefined);
    });
  });

  it("lists and summarises what has been saved, soonest due first", async () => {
    await withTasksDir(async () => {
      await saveTask(newTask({ title: "later", due: "2026-09-20" }));
      await saveTask(newTask({ title: "sooner", due: "2026-09-16" }));
      const all = await listTasks();
      assert.equal(all.length, 2);
      const summaries = await listTaskSummaries();
      assert.deepEqual(summaries.map((t) => t.title), ["sooner", "later"]);
    });
  });

  it("deleteTask actually removes the file -- the one destructive op here", async () => {
    await withTasksDir(async () => {
      const task = newTask({ title: "gone soon" });
      await saveTask(task);
      assert.ok(await readTask(task.id));
      await deleteTask(task.id);
      assert.equal(await readTask(task.id), undefined);
    });
  });

  it("deleting a task that never existed is not an error", async () => {
    await withTasksDir(async () => {
      await assert.doesNotReject(() => deleteTask("never-existed"));
    });
  });

  it("markNotified sets notifiedAt and leaves an unknown id alone", async () => {
    await withTasksDir(async () => {
      const task = newTask({ title: "reminder", due: "2026-09-20", remindAt: "09:00" });
      await saveTask(task);
      const now = new Date("2026-09-20T09:00:00.000Z");
      const updated = await markNotified(task.id, now);
      assert.equal(updated?.notifiedAt, now.toISOString());
      assert.equal((await readTask(task.id))?.notifiedAt, now.toISOString());

      assert.equal(await markNotified("no-such-task", now), undefined);
    });
  });
});
