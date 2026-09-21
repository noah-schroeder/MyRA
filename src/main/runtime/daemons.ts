/**
 * Remembering the daemons MyRA starts, and reclaiming the ones it left behind.
 *
 * The half of the stray sweep that touches a disk and a process table. Every
 * decision -- which pids are ours, how each has to be signalled -- lives in
 * [core/runtime/strays.ts](../../core/runtime/strays.ts), so it can be tested
 * against process tables that never existed. This file is deliberately in
 * `src/main/` because it reads `/proc` and sends signals, and it deliberately
 * imports **nothing from Electron**, for the reason `engineRuntime.ts` does the
 * same: a module that imports Electron cannot be loaded by the test runner at
 * all, and this is exactly the path that has to be testable.
 *
 * It takes the directories it owns as arguments rather than reading them from
 * `main/runtime/paths.ts`, which does import Electron.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { scrubbedEnv } from "../../core/childEnv.ts";
import {
  argvFromCmdline, fieldsFromStat, parseRecords, withoutRecord, withoutRecords, withRecord,
  type DaemonRecord, type ProcessFacts, type Stray,
} from "../../core/runtime/strays.ts";

/**
 * Beside `runtime.json`, and owner-only.
 *
 * It names a pid and a port of a process holding the user's models. Not secret,
 * but nothing MyRA writes is another local account's business, and
 * `test/privacy.test.ts` asserts that under a 0000 umask.
 */
export function recordPath(): string {
  return join(CONFIG_DIR, "lemonade-daemons.json");
}

export async function readRecords(): Promise<DaemonRecord[]> {
  try {
    return parseRecords(JSON.parse(await readFile(recordPath(), "utf8")));
  } catch {
    /* No file yet, or one written by a version that shaped it differently.
       Either way the answer is "we know of no daemons", which is the safe one:
       it reclaims nothing rather than reclaiming something it cannot identify. */
    return [];
  }
}

async function writeRecords(records: readonly DaemonRecord[]): Promise<void> {
  try {
    await makeOwnDir(CONFIG_DIR);
    await writeFile(recordPath(), JSON.stringify(records, null, 2), { mode: OWNER_ONLY_FILE });
  } catch {
    /* A record that cannot be written costs a stray surviving until the next
       reboot. Failing the daemon start over it would cost the whole app. */
  }
}

/*
 * One whole read-modify-write at a time, not merely one write at a time.
 *
 * `start()` awaits `readStartTicks` then `rememberDaemon`; a daemon that dies
 * during that window -- the ordinary shape of a missing shared library --
 * fires `exit` -> `forgetDaemon` from an unrelated call stack, overlapping it
 * by construction. Serialising only the final `writeFile` is not enough: each
 * caller would still call `readRecords()` on its own, before either write has
 * landed, so whichever finishes its own read-and-patch LAST still overwrites
 * the other's change with a patch computed against state that was already
 * stale -- a record for a pid already dead surviving to the next sweep is
 * exactly what `startTicks` had to be added to defend against. Reading the
 * chain in a `queue`-serialised job closes that: every job now sees the file
 * as every previous job left it, never as it stood before them.
 *
 * Chained through `.then(job, job)` rather than `.finally`, so one job's
 * rejection cannot leave every job after it unable to run.
 */
let queue: Promise<void> = Promise.resolve();
function mutate(patch: (records: DaemonRecord[]) => DaemonRecord[]): Promise<void> {
  const job = async (): Promise<void> => {
    await writeRecords(patch(await readRecords()));
  };
  return (queue = queue.then(job, job));
}

export async function rememberDaemon(rec: DaemonRecord): Promise<void> {
  await mutate((records) => withRecord(records, rec));
}

export async function forgetDaemon(pid: number): Promise<void> {
  await mutate((records) => withoutRecord(records, pid));
}

/**
 * Drop exactly the records a sweep read, leaving anything written since alone.
 *
 * Not a wholesale clear: `sweepStrays` runs concurrently with everything else
 * that starts a daemon -- `RuntimeManager#ensureLemonade` now awaits the
 * sweep's own promise before starting one, but a caller from before that
 * guard existed, or a future one that forgets it, must not have its brand new
 * record erased by a sweep that started before it and is only now finishing.
 * Naming the pids the sweep actually read leaves anything written since alone.
 */
export async function forgetRecords(pids: readonly number[]): Promise<void> {
  await mutate((records) => withoutRecords(records, pids));
}

/**
 * Field 22 of `/proc/<pid>/stat`, for stamping a record at spawn.
 *
 * Absent everywhere but Linux, and absent on Linux is not an error: the record
 * is still worth writing without it, because the binary path is the strong half
 * of the identity check and the start time only closes pid reuse on top of it.
 */
export async function readStartTicks(pid: number): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return fieldsFromStat(await readFile(`/proc/${pid}/stat`, "utf8"))?.startTicks;
  } catch {
    return undefined;
  }
}

/**
 * Run `body` over `items`, at most `limit` in flight at once.
 *
 * A bare `Promise.all` over every pid in `/proc` was ~500 sequential-looking
 * round trips in front of the sweep on an ordinary workstation -- three reads
 * are already concurrent per pid, but the pids themselves ran one after
 * another, which sat in front of the user's own "freed memory" notification.
 * Capped rather than fully unbounded: 500 pids at three file descriptors each
 * would sit on top of a common `ulimit -n` of 1024.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  body: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await body(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function scanLinux(): Promise<ProcessFacts[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry));
  const rows = await mapPool(pids, 64, async (entry): Promise<ProcessFacts | undefined> => {
    try {
      const [info, cmdline, statText, exe] = await Promise.all([
        stat(`/proc/${entry}`),
        readFile(`/proc/${entry}/cmdline`, "utf8"),
        readFile(`/proc/${entry}/stat`, "utf8"),
        // A process this user does not own answers EACCES here; absent, not fatal.
        readlink(`/proc/${entry}/exe`).catch(() => undefined),
      ]);
      const fields = fieldsFromStat(statText);
      if (!fields) return undefined;
      return {
        pid: Number(entry),
        ppid: fields.ppid,
        pgrp: fields.pgrp,
        uid: info.uid,
        argv: argvFromCmdline(cmdline),
        startTicks: fields.startTicks,
        ...(exe ? { exe } : {}),
      };
    } catch {
      /* A process exiting between readdir and read is the ordinary case here,
         not an error. Skipping it is right: it is no longer holding anything. */
      return undefined;
    }
  });
  return rows.filter((row): row is ProcessFacts => row !== undefined);
}

async function scanDarwin(): Promise<ProcessFacts[]> {
  const text = await new Promise<string>((resolve) => {
    let buf = "";
    const child = spawn("ps", ["-Ao", "pid=,ppid=,pgid=,uid=,args="], {
      stdio: ["ignore", "pipe", "ignore"],
      env: scrubbedEnv(process.env),
    });
    child.stdout.on("data", (d: Buffer) => { buf += d.toString(); });
    child.on("close", () => resolve(buf));
    child.on("error", () => resolve(""));
  });
  const out: ProcessFacts[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m?.[1] || !m[5]) continue;
    /* `ps` gives one command string, not the argv vector, so it is split on
       spaces. A path with a space in it would be torn -- acceptable, because
       the identity check is `argv.includes(binary)` and MyRA's own directories
       have no spaces in them; a torn path simply fails to match and the process
       is left alone, which is the safe direction to fail in. */
    out.push({
      pid: Number(m[1]), ppid: Number(m[2]), pgrp: Number(m[3]), uid: Number(m[4]),
      argv: m[5].split(" ").filter((p) => p !== ""),
    });
  }
  return out;
}

/**
 * The process table, in the terms `straysToKill` needs.
 *
 * Windows returns nothing, and that is not an oversight: `stop()` and
 * `killNow()` both use `taskkill /T` there, which walks the tree and takes the
 * engines with it, so the leak this sweep cleans up does not happen. Said out
 * loud rather than left looking unfinished.
 */
export async function scanProcesses(): Promise<ProcessFacts[]> {
  if (process.platform === "linux") return scanLinux();
  if (process.platform === "darwin") return scanDarwin();
  return [];
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is not ours, which is not a thing to wait for.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/*
 * Deliberately NOT `unref`ed, unlike most timers in this codebase.
 *
 * An unref'd timer does not hold the event loop open, so when this is the only
 * thing pending -- which it is, during the grace period below -- the process
 * exits before the escalation to SIGKILL ever runs. Measured: the engine died
 * to the first SIGTERM, the daemon ignored it, and the sweep exited without
 * ever sending the second signal, leaving exactly the process it was there to
 * reclaim. The grace period has to be able to keep the process alive to be a
 * grace period at all.
 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

function signal(stray: Stray, sig: NodeJS.Signals): void {
  const send = (pid: number, negate: boolean): void => {
    try {
      process.kill(negate ? -pid : pid, sig);
    } catch {
      /* Already gone, or never ours to signal. Both mean there is nothing left
         to do about this pid. */
    }
  };
  if (stray.how === "group") {
    send(stray.facts.pid, true);
    return;
  }
  // Deepest first, so lemond cannot replace a backend between the two signals.
  for (const child of stray.children) send(child.pid, false);
  send(stray.facts.pid, false);
}

/**
 * Reclaim one stray, asking before insisting.
 *
 * SIGTERM first even here, and that is the whole lesson of the bug this belongs
 * to: SIGKILL cannot be caught, so a supervisor that gets one never shuts down
 * the engines holding the card. The grace period is what makes the difference
 * between freeing the memory and moving the leak one process further down.
 */
export async function killStray(stray: Stray, graceMs = 3_000): Promise<void> {
  signal(stray, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive(stray.facts.pid)) await wait(100);
  if (alive(stray.facts.pid)) signal(stray, "SIGKILL");
}
