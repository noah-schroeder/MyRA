/**
 * Deciding which leftover model servers are ours to reclaim.
 *
 * The failure this exists for, measured on a Pop!_OS 22.04 workstation with a
 * 32 GB card: `lemond` is only a supervisor, and the processes actually holding
 * weights in VRAM are its children -- `llama-server`, `whisper-server`, `koko`,
 * `sd-cpp`, each on its own port. MyRA's quit path sent the daemon a bare
 * SIGKILL, which cannot be caught, so `lemond` never got to shut those down.
 * They were reparented to init still holding the card, and every open-and-close
 * of the app stranded another set. The user's report is the shape of it: chat
 * gets slower all day in fresh conversations, reopening the app does not help,
 * and only a reboot does.
 *
 * `main/runtime/lemonade.ts` stops creating them. This module is what recovers
 * a machine that already has some, and every part of it is the same question:
 * **is this process one MyRA started, beyond argument?** Getting that wrong
 * means killing something a person is using, so the answer is never a name
 * match. `main/runtime/daemons.ts` is the half that reads `/proc`; everything
 * that decides anything is here, with no `node:fs` and no Electron, so the
 * tests can attack it with process tables that never existed.
 */

/** A daemon MyRA started, written down at spawn so it can be found again. */
export interface DaemonRecord {
  pid: number;
  /** The port it was given, for the log line when it is reclaimed. */
  port: number;
  /** The absolute `lemond` this record was written for. The identity check. */
  binary: string;
  /**
   * Field 22 of `/proc/<pid>/stat` at spawn: boot-relative start time.
   *
   * This is what closes pid reuse. A pid is recycled within hours on a busy
   * machine, and a record naming one is otherwise an instruction to kill
   * whatever inherited it. Absent on macOS, where `ps` does not offer it and
   * the binary path carries the check alone.
   */
  startTicks?: number | undefined;
  /** Wall clock, for the log line only. Never compared against anything. */
  startedAt: number;
}

/** One row of the process table, in the only terms this module needs. */
export interface ProcessFacts {
  pid: number;
  ppid: number;
  pgrp: number;
  uid: number;
  argv: string[];
  startTicks?: number | undefined;
  /**
   * `readlink("/proc/<pid>/exe")`, when the platform and permissions allow it.
   *
   * Absent on macOS, where `ps` cannot report it, and absent for a process
   * this user does not own even on Linux. `looksLikeOurs` below needs it: an
   * argv match alone is a string somewhere in the command line, which a `tail
   * -f` on one of MyRA's own log files satisfies without being MyRA at all.
   */
  exe?: string | undefined;
}

/**
 * How a stray has to be signalled.
 *
 * `"group"` means the daemon leads its own process group, so one signal to
 * `-pid` reaches it and every engine it spawned. `"tree"` is the fallback for a
 * daemon started before MyRA passed `detached` -- it sits in whatever group
 * Electron was in, which on a desktop session can be the session leader's, and
 * signalling that group would take the user's session down with it. So those
 * are killed pid by pid instead.
 */
export type KillShape = "group" | "tree";

export interface Stray {
  facts: ProcessFacts;
  /** The record that named it, when one did. */
  record?: DaemonRecord | undefined;
  how: KillShape;
  /** Descendants, deepest first, for the `"tree"` shape. Empty for `"group"`. */
  children: ProcessFacts[];
}

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/**
 * Read a record file back, dropping anything malformed.
 *
 * Defensive in the register `parseSystemInfo` already uses: a file MyRA cannot
 * parse must not stop the app starting. The worst case of dropping an entry is
 * that one stray survives until the user reboots, which is exactly where they
 * were before this existed; the worst case of throwing is an app that will not
 * open.
 */
export function parseRecords(raw: unknown): DaemonRecord[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DaemonRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const pid = int(r["pid"]);
    const binary = typeof r["binary"] === "string" ? r["binary"] : "";
    if (pid === undefined || !binary) continue;
    const ticks = int(r["startTicks"]);
    out.push({
      pid,
      port: int(r["port"]) ?? 0,
      binary,
      ...(ticks !== undefined ? { startTicks: ticks } : {}),
      startedAt: int(r["startedAt"]) ?? 0,
    });
  }
  return out;
}

/** Add a record, replacing any entry for the same pid. Pure, so the write is testable. */
export function withRecord(records: readonly DaemonRecord[], rec: DaemonRecord): DaemonRecord[] {
  return [...records.filter((r) => r.pid !== rec.pid), rec];
}

/** Drop the record for a pid. */
export function withoutRecord(records: readonly DaemonRecord[], pid: number): DaemonRecord[] {
  return records.filter((r) => r.pid !== pid);
}

/**
 * Drop exactly the records named, and no others.
 *
 * A completed sweep used to clear the file wholesale (`forgetAll`), on the
 * reasoning that after a sweep the only daemon worth remembering is one
 * started after it. But the sweep is not awaited before `startOnLaunch`, so
 * with any strays present -- `killStray`'s grace period alone is up to three
 * seconds each -- this run's own daemon can already have written its record by
 * the time the sweep finishes, and a wholesale clear erased it: the next
 * launch had nothing but the weaker `looksLikeOurs` rule to find it by. Naming
 * the pids the sweep actually read leaves anything written after it alone.
 */
export function withoutRecords(
  records: readonly DaemonRecord[],
  pids: readonly number[],
): DaemonRecord[] {
  const drop = new Set(pids);
  return records.filter((r) => !drop.has(r.pid));
}

/**
 * The fields of `/proc/<pid>/stat` that matter, by position.
 *
 * The parse looks fussy and has to be. Field 2 is `comm`, which is the
 * executable's name in parentheses -- and it can contain spaces *and* its own
 * parentheses, so neither splitting on whitespace nor finding the first `)`
 * works. A kernel thread named `(llama-server (v2))` breaks both. The only
 * correct split is after the LAST `)`, which is why this is a function rather
 * than three inline `split` calls at the call site.
 *
 * After that slice, `rest[0]` is field 3, so field N is `rest[N - 3]`.
 */
export function fieldsFromStat(
  text: string,
): { ppid: number; pgrp: number; startTicks: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = text.slice(close + 2).split(" ");
  const at = (field: number): number => Number(rest[field - 3] ?? NaN);
  const ppid = at(4);
  const pgrp = at(5);
  const startTicks = at(22);
  if (!Number.isFinite(ppid) || !Number.isFinite(pgrp) || !Number.isFinite(startTicks)) {
    return undefined;
  }
  return { ppid, pgrp, startTicks };
}

/** Just the start time, for stamping a record at spawn. */
export function startTicksFromStat(text: string): number | undefined {
  return fieldsFromStat(text)?.startTicks;
}

/** `/proc/<pid>/cmdline` is NUL-separated with a trailing NUL. */
export function argvFromCmdline(text: string): string[] {
  return text.split("\0").filter((part) => part !== "");
}

/**
 * Is this process the daemon that record names? Three checks, all required.
 *
 * Each one exists to stop a different way of killing the wrong thing:
 *
 *   1. **Same user.** Never another account's process, whatever it is running.
 *   2. **The exact binary we recorded, anywhere in argv.** That path is always
 *      inside MyRA's own data directory, so a Lemonade the user installed for
 *      themselves -- in `/usr/bin`, a pipx venv, a Flatpak -- can never match
 *      it. Searched across the whole argv rather than `argv[0]`, because on a
 *      machine with an older glibc `launchSpec` starts the daemon through the
 *      bundled loader and `argv[0]` is `ld-linux-x86-64.so.2`.
 *   3. **The same start time**, so a recycled pid is not mistaken for ours.
 *      Skipped only where the platform cannot report one, and there check 2 is
 *      doing the work alone.
 */
export function isOurDaemon(
  facts: ProcessFacts,
  record: DaemonRecord,
  selfUid: number,
): boolean {
  if (facts.uid !== selfUid) return false;
  if (!facts.argv.includes(record.binary)) return false;
  if (record.startTicks === undefined || facts.startTicks === undefined) return true;
  return facts.startTicks === record.startTicks;
}

/**
 * The wider rule, for a process with no record at all.
 *
 * This is the case that matters most on a machine that is already full. The
 * engines are the processes holding VRAM, and once the `lemond` that spawned
 * them has been SIGKILLed they are reparented to init -- so they are nobody's
 * child, no record ever named them, and matching only recorded daemons would
 * walk straight past the exact processes this exists to reclaim. There are two
 * ways to get an unrecorded `lemond` too: MyRA died between the spawn and the
 * write, or somebody deleted the record file.
 *
 * The rule is **it is running out of MyRA's own data directory, as this user**.
 * `ownedPrefixes` are the two directories MyRA puts executables in -- the
 * runtimes tree that holds `lemond`, and the Lemonade data tree that holds the
 * engines it downloads. A Lemonade the user installed for themselves lives in
 * `/usr/bin`, a pipx venv or a Flatpak and matches neither.
 *
 * Matched against the EXECUTABLE, `/proc/<pid>/exe`, never against argv alone.
 * An argv match is a string that merely appears somewhere on the command
 * line, and a person following the troubleshooting docs with `tail -f
 * ~/.config/MyRA/lemonade/logs/lemonade.log` satisfies it without being MyRA
 * at all -- `tail`'s own executable is `/usr/bin/tail`, nowhere near either
 * prefix. `exe` is unavailable on macOS (`ps` cannot report it) and for a
 * process this user does not own on Linux -- excluded already, above -- so
 * `argv[0]` is the fallback there: what a shell or `exec` actually launched,
 * not merely mentioned, and the narrowest thing left once the kernel will not
 * say for certain.
 *
 * Deliberately a separate function from `isOurDaemon` rather than a relaxed
 * mode of it, so the tests can attack it on its own. It is the weaker check and
 * the one that could grow a hole.
 */
export function looksLikeOurs(
  facts: ProcessFacts,
  opts: { ownedPrefixes: readonly string[]; selfUid: number },
): boolean {
  if (facts.uid !== opts.selfUid) return false;
  const owned = (path: string): boolean =>
    opts.ownedPrefixes.some((prefix) => path.startsWith(prefix));
  if (facts.exe !== undefined) return owned(facts.exe);
  const arg0 = facts.argv[0];
  return arg0 !== undefined && owned(arg0);
}

/**
 * Every descendant of a pid, deepest first.
 *
 * The order is the point: an engine is signalled before the manager that
 * supervises it, so `lemond` cannot notice a backend dying and start a
 * replacement in the moment between the two signals.
 */
export function childrenOf(scan: readonly ProcessFacts[], pid: number): ProcessFacts[] {
  const levels: ProcessFacts[][] = [];
  let frontier = [pid];
  const seen = new Set<number>([pid]);
  while (frontier.length) {
    const next = scan.filter((p) => frontier.includes(p.ppid) && !seen.has(p.pid));
    if (!next.length) break;
    for (const p of next) seen.add(p.pid);
    levels.push(next);
    frontier = next.map((p) => p.pid);
  }
  return levels.reverse().flat();
}

/**
 * Which processes to reclaim, and how to signal each.
 *
 * Recorded daemons first, so their record rides along into the log line, then
 * anything else running out of MyRA's directories -- which is where the already
 * orphaned engines are found.
 *
 * **MyRA's own process tree is excluded, not merely its pid.** Electron's
 * renderer, GPU and utility processes are children of this one and can easily
 * carry a path under the app's data directory in their argv; a sweep that
 * killed those would take the app down as it started. `self.pid` and every
 * descendant of it are off limits for that reason.
 *
 * Records whose process is gone, or whose pid now belongs to something else,
 * produce nothing. The caller drops every record it passed in either way: after
 * a sweep the only daemon worth remembering is one started after it.
 */
export function straysToKill(
  records: readonly DaemonRecord[],
  scan: readonly ProcessFacts[],
  self: { pid: number; uid: number; ownedPrefixes: readonly string[] },
): Stray[] {
  const out: Stray[] = [];
  const ours = new Set<number>([self.pid, ...childrenOf(scan, self.pid).map((p) => p.pid)]);
  const claimed = new Set<number>(ours);

  const add = (facts: ProcessFacts, record?: DaemonRecord): void => {
    if (claimed.has(facts.pid)) return;
    claimed.add(facts.pid);
    /* A group kill only when the process actually leads its own group. Anything
       else inherited Electron's group, which on a desktop session can be the
       session leader's -- `kill(-pgrp)` there would sign the user out. */
    const how: KillShape = facts.pgrp === facts.pid ? "group" : "tree";
    out.push({
      facts,
      ...(record ? { record } : {}),
      how,
      children: how === "tree" ? childrenOf(scan, facts.pid) : [],
    });
  };

  for (const record of records) {
    const facts = scan.find((p) => p.pid === record.pid);
    if (facts && !ours.has(facts.pid) && isOurDaemon(facts, record, self.uid)) add(facts, record);
  }
  for (const facts of scan) {
    if (looksLikeOurs(facts, { ownedPrefixes: self.ownedPrefixes, selfUid: self.uid })) {
      add(facts);
    }
  }
  /* Deepest first, so an engine is signalled before the daemon that would
     notice it dying and start a replacement. Depth is counted through the whole
     scan rather than only among the strays, because the chain between two of
     them may run through a process that is not itself one. */
  const depth = (facts: ProcessFacts): number => {
    let steps = 0;
    let at: ProcessFacts | undefined = facts;
    const seen = new Set<number>();
    while (at && at.ppid > 1 && !seen.has(at.pid)) {
      seen.add(at.pid);
      at = scan.find((p) => p.pid === at?.ppid);
      if (at) steps += 1;
    }
    return steps;
  };
  return out.sort((a, b) => depth(b.facts) - depth(a.facts));
}
