/**
 * Reclaiming a leftover model server, against real processes.
 *
 * `strays.test.ts` covers the decision -- which pids are ours -- against process
 * tables that never existed. This covers the part only a real process can show:
 * that a daemon which does not take the hint is reclaimed anyway.
 *
 * That is not a theoretical worry. The sweep exists because a signal the daemon
 * could not act on left its engines holding the graphics card, and a sweep that
 * gave up after one polite signal would leave them there just as surely. The
 * first version of this code did exactly that, for a reason no fixture could
 * have caught: the timer covering the grace period was `unref`ed, so the
 * process exited before the escalation ever ran.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  forgetDaemon, forgetRecords, killStray, readRecords, rememberDaemon, scanProcesses,
} from "../src/main/runtime/daemons.ts";
import type { DaemonRecord, Stray } from "../src/core/runtime/strays.ts";

const supported = process.platform === "linux" || process.platform === "darwin";
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stray for a pid we just started, in the shape the sweep would build one. */
const strayFor = (pid: number): Stray => ({
  facts: { pid, ppid: 1, pgrp: pid, uid: process.getuid?.() ?? 0, argv: [] },
  how: "tree",
  children: [],
});

/**
 * Start a process that is nobody's child, the way a swept daemon always is.
 *
 * Deliberately not a direct child of the test runner. A child that has died but
 * not yet been reaped is a zombie, and `kill(pid, 0)` succeeds on a zombie -- so
 * the assertions would be measuring when Node got round to reaping rather than
 * whether anything was reclaimed. Reparented to init, they mean what they say,
 * and that is also the state the sweep meets in the wild, since the daemon that
 * spawned the engines was killed before them.
 *
 * Its output goes to /dev/null rather than a pipe: a grandchild inherits the
 * pipe, so the intermediate's `close` would not fire until the process under
 * test exited, which is the thing being waited for.
 */
async function orphan(body: string): Promise<number> {
  const mark = `myra_stray_${randomBytes(6).toString("hex")}`;
  const script = `: ${mark}; ${body}`;
  const helper = spawn("sh", ["-c", `setsid sh -c '${script}' </dev/null >/dev/null 2>&1 &`], {
    stdio: "ignore",
    detached: true,
  });
  helper.unref();
  await wait(500);
  const found = (await scanProcesses()).find(
    (p) => p.pid !== process.pid && p.argv.some((a) => a.includes(mark)),
  );
  assert.ok(found, "the helper process should be running");
  return found.pid;
}

describe("reclaiming a process that will not go quietly", { skip: !supported }, () => {
  it("escalates past a daemon that ignores SIGTERM", async () => {
    /* `trap "" TERM` ignores it outright, which is the worst case a real daemon
       can present -- one caught mid-load, with its own handler not yet
       installed, looks exactly the same from out here. Without the escalation
       this call returns having achieved nothing, and the memory stays spent
       until the machine is rebooted. */
    const pid = await orphan('trap "" TERM; while true; do sleep 0.2; done');
    try {
      assert.equal(alive(pid), true, "the stubborn process should be running");
      await killStray(strayFor(pid), 500);
      await wait(200);
      assert.equal(alive(pid), false, "it should have been reclaimed anyway");
    } finally {
      // Never leave one of these behind: by construction it ignores SIGTERM.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone, which is what the test wanted. */
      }
    }
  });

  it("does not insist when the daemon goes quietly", async () => {
    /* The ordinary case, and worth being sure of: a daemon that honours SIGTERM
       is never SIGKILLed, which is what lets it put the card down cleanly
       rather than being torn away from it mid-write. */
    const pid = await orphan("while true; do sleep 0.2; done");
    const started = Date.now();
    await killStray(strayFor(pid), 5_000);
    assert.equal(alive(pid), false);
    assert.ok(Date.now() - started < 4_000, "should not have waited out the grace period");
  });
});

describe("the record file under concurrent writes", () => {
  const rec = (over: Partial<DaemonRecord> & { pid: number }): DaemonRecord => ({
    port: 0, binary: "/bin/x", startedAt: 0, ...over,
  });

  it("keeps every call's effect, whichever order the writes actually land in", async () => {
    /* `start()` awaits `readStartTicks` then `rememberDaemon`; a daemon that
       dies during that window fires `exit` -> `forgetDaemon` from an
       unrelated call stack, so the two are never coordinated by the caller.
       Firing four calls with no await between them is that race, worst case:
       every one of them reads the file before any of them has written it.
       Serialising only the last `writeFile` would still lose whichever of
       these read first; serialising the whole read-modify-write must not. */
    await forgetRecords((await readRecords()).map((r) => r.pid));
    await Promise.all([
      rememberDaemon(rec({ pid: 9001 })),
      rememberDaemon(rec({ pid: 9002 })),
      forgetDaemon(9001),
      rememberDaemon(rec({ pid: 9003 })),
    ]);
    const left = (await readRecords()).map((r) => r.pid).sort();
    assert.deepEqual(left, [9002, 9003]);
  });

  it("forgetRecords drops only the pids it was given", async () => {
    await forgetRecords((await readRecords()).map((r) => r.pid));
    await rememberDaemon(rec({ pid: 9101 }));
    await rememberDaemon(rec({ pid: 9102 }));
    // Written after the sweep read its snapshot -- must survive the sweep's own cleanup.
    await rememberDaemon(rec({ pid: 9103 }));
    await forgetRecords([9101, 9102]);
    assert.deepEqual((await readRecords()).map((r) => r.pid), [9103]);
  });
});

describe("scanning the process table", { skip: !supported }, () => {
  it("finds this very process, with the parent the runtime agrees on", async () => {
    /* The parse is positional over /proc/<pid>/stat, whose second field can
       contain spaces and brackets of its own. Reading one field late yields
       another process's parent, which is how a sweep kills the wrong thing. */
    const me = (await scanProcesses()).find((p) => p.pid === process.pid);
    assert.ok(me, "the scan should include the process doing the scanning");
    assert.equal(me.ppid, process.ppid);
    assert.equal(me.uid, process.getuid?.() ?? 0);
    assert.ok(me.argv.some((a) => a.includes("node")), "argv should survive the NUL split");
  });
});
