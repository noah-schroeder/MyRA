/**
 * The task tools' pure logic: the gate, and what each one does with a host
 * that answers, refuses, or is not attached at all.
 *
 * Deliberately does not test "tomorrow"/"today" date arithmetic here -- that
 * is pinned precisely, with an injected clock, in test/time.test.ts. These
 * tests exercise the tool's own plumbing: an explicit date passes through
 * unchanged, a garbage one is refused with a message a model can act on, and
 * a host that has not been attached is refused rather than answered from an
 * empty list it never asked about.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../src/core/agent/registry.ts";
import {
  completeTaskTool, createTaskTool, listTasksTool, setTaskHost, TASK_TOOL_DEFS, type TaskHost,
} from "../src/core/agent/tools/tasks.ts";
import { complete, newTask, type Task } from "../src/core/tasks/task.ts";

function configFile(mode: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myra-tasks-"));
  const path = join(dir, "research.json");
  writeFileSync(path, JSON.stringify({ v: 2, mode, category: "science" }));
  return path;
}

/** Restores research.json to where test/setup.ts left it, the same
 *  precaution test/research.test.ts takes -- leaving a temp file pointed at
 *  makes every later test in the process read a mode nobody chose. */
function restoreResearchConfig(): void {
  process.env["MYRA_RESEARCH_CONFIG"] = join(process.env["MYRA_CONFIG_DIR"] ?? tmpdir(), "research.json");
}

function fakeHost(initial: Task[] = []): TaskHost & { tasks: Task[] } {
  const state: { tasks: Task[] } = { tasks: initial };
  return {
    get tasks() {
      return state.tasks;
    },
    async list() {
      return state.tasks;
    },
    async create(task) {
      state.tasks = [...state.tasks, task];
      return task;
    },
    async complete(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) return undefined;
      const done = complete(found);
      state.tasks = state.tasks.map((t) => (t.id === id ? done : t));
      return done;
    },
  };
}

describe("create_task", () => {
  afterEach(() => setTaskHost(undefined));

  it("stores an explicit YYYY-MM-DD date exactly", async () => {
    const host = fakeHost();
    setTaskHost(host);
    const result = await createTaskTool.handler({ title: "Review Frank's paper", due: "2026-09-16" }, {});
    assert.equal(host.tasks.length, 1);
    assert.equal(host.tasks[0]!.due, "2026-09-16");
    assert.match(result.content, /Review Frank's paper/);
  });

  it("refuses a due date it cannot parse, with a message the model can retry from", async () => {
    setTaskHost(fakeHost());
    await assert.rejects(
      () => createTaskTool.handler({ title: "t", due: "next thursday" }, {}),
      /must be YYYY-MM-DD, today, or tomorrow/,
    );
  });

  it("leaves due empty when none is given, rather than guessing one", async () => {
    const host = fakeHost();
    setTaskHost(host);
    await createTaskTool.handler({ title: "Someday task" }, {});
    assert.equal(host.tasks[0]!.due, "");
  });

  it("refuses an empty title", async () => {
    setTaskHost(fakeHost());
    await assert.rejects(() => createTaskTool.handler({ title: "   " }, {}), /no title/);
  });

  it("keeps a well-formed remindAt alongside a due date", async () => {
    const host = fakeHost();
    setTaskHost(host);
    const result = await createTaskTool.handler(
      { title: "Stand-up", due: "2026-09-16", remindAt: "09:00" },
      {},
    );
    assert.equal(host.tasks[0]!.remindAt, "09:00");
    assert.match(result.content, /reminder at 09:00/);
  });

  it("drops remindAt when there is no due date, rather than storing a time nothing anchors", async () => {
    const host = fakeHost();
    setTaskHost(host);
    await createTaskTool.handler({ title: "Someday", remindAt: "09:00" }, {});
    assert.equal(host.tasks[0]!.remindAt, undefined);
  });

  it("refuses a remindAt that is not HH:MM, with a message a model can retry from", async () => {
    setTaskHost(fakeHost());
    await assert.rejects(
      () => createTaskTool.handler({ title: "t", due: "2026-09-16", remindAt: "9am" }, {}),
      /remindAt.*must be HH:MM/,
    );
  });

  it("refuses rather than silently doing nothing when no host is attached", async () => {
    setTaskHost(undefined);
    await assert.rejects(() => createTaskTool.handler({ title: "t" }, {}), /has not attached a task host/);
  });
});

describe("list_tasks", () => {
  afterEach(() => setTaskHost(undefined));

  it("defaults to open tasks only", async () => {
    setTaskHost(fakeHost([newTask({ title: "open one" }), complete(newTask({ title: "done one" }))]));
    const result = await listTasksTool.handler({}, {});
    assert.match(result.content, /open one/);
    assert.doesNotMatch(result.content, /done one/);
  });

  it("status \"done\" returns only the finished ones", async () => {
    setTaskHost(fakeHost([newTask({ title: "open one" }), complete(newTask({ title: "done one" }))]));
    const result = await listTasksTool.handler({ status: "done" }, {});
    assert.match(result.content, /done one/);
    assert.doesNotMatch(result.content, /open one/);
  });

  it("status \"all\" returns both", async () => {
    setTaskHost(fakeHost([newTask({ title: "open one" }), complete(newTask({ title: "done one" }))]));
    const result = await listTasksTool.handler({ status: "all" }, {});
    assert.match(result.content, /open one/);
    assert.match(result.content, /done one/);
  });

  it("an empty list says so rather than nothing", async () => {
    setTaskHost(fakeHost([]));
    const result = await listTasksTool.handler({}, {});
    assert.match(result.content, /none/);
  });

  it("refuses rather than answering \"you have no tasks\" when no host is attached", async () => {
    setTaskHost(undefined);
    await assert.rejects(() => listTasksTool.handler({}, {}), /has not attached a task host/);
  });
});

describe("complete_task", () => {
  afterEach(() => setTaskHost(undefined));

  it("marks the named task done", async () => {
    const t1 = newTask({ title: "finish this" });
    const host = fakeHost([t1]);
    setTaskHost(host);
    const result = await completeTaskTool.handler({ id: t1.id }, {});
    assert.match(result.content, /finish this/);
    assert.ok(host.tasks[0]!.completedAt);
  });

  it("an unknown id is refused, never reported as success", async () => {
    setTaskHost(fakeHost([]));
    await assert.rejects(() => completeTaskTool.handler({ id: "not-a-real-id" }, {}), /no task with id/);
  });

  it("refuses with no id", async () => {
    setTaskHost(fakeHost([]));
    await assert.rejects(() => completeTaskTool.handler({ id: "" }, {}), /no id/);
  });
});

describe("the gate", () => {
  afterEach(restoreResearchConfig);

  function registryWith(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const def of TASK_TOOL_DEFS) registry.register(def);
    return registry;
  }

  it("is unreachable at \"off\", the same guarantee every other tool gets", () => {
    process.env["MYRA_RESEARCH_CONFIG"] = configFile("off");
    assert.deepEqual(registryWith().activeNames(), []);
  });

  it("is reachable from \"assistant\" upward -- local and jailed, like the document tools", () => {
    for (const mode of ["assistant", "library", "web", "deep"]) {
      process.env["MYRA_RESEARCH_CONFIG"] = configFile(mode);
      assert.deepEqual(
        registryWith().activeNames().sort(),
        ["complete_task", "create_task", "list_tasks"],
        mode,
      );
    }
  });
});
