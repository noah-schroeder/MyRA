/**
 * Deciding which leftover model servers are safe to reclaim.
 *
 * The failure behind this, from a Pop!_OS 22.04 workstation with a 32 GB card:
 * MyRA's quit path sent `lemond` a bare SIGKILL, which cannot be caught, so the
 * daemon never got to shut down the `llama-server` and `whisper-server`
 * processes it had spawned. They were reparented to init still holding VRAM,
 * every close of the window stranded another set, and only a reboot gave the
 * card back.
 *
 * Reclaiming them means killing processes on the strength of a scan of `/proc`,
 * which is the kind of code that is one loose predicate away from signing
 * somebody out of their desktop or killing a Lemonade they run themselves. Every
 * test here is a way that could happen.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  argvFromCmdline, childrenOf, fieldsFromStat, isOurDaemon, looksLikeOurs,
  parseRecords, startTicksFromStat, straysToKill, withRecord, withoutRecord, withoutRecords,
  type DaemonRecord, type ProcessFacts,
} from "../src/core/runtime/strays.ts";

const HOME = "/home/user/.config/MyRA";
const LEMOND = `${HOME}/runtimes/lemonade/11.8.0/lemond`;
const ENGINE = `${HOME}/lemonade/bin/llamacpp/vulkan/llama-server`;
const PREFIXES = [`${HOME}/runtimes/`, `${HOME}/lemonade/`];
const US = 1000;

function proc(over: Partial<ProcessFacts> & { pid: number }): ProcessFacts {
  return { ppid: 1, pgrp: over.pid, uid: US, argv: [], startTicks: 100, ...over };
}

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: 4242, port: 51000, binary: LEMOND, startTicks: 100, startedAt: 0, ...over,
});

const self = { pid: 9, uid: US, ownedPrefixes: PREFIXES };

describe("reading /proc/<pid>/stat", () => {
  it("splits after the last bracket, not the first", () => {
    /* Field 2 is `comm`, and it can contain spaces AND its own parentheses.
       Splitting on whitespace or finding the first `)` both put every later
       field one place out, which silently yields another process's parent. */
    const line = [
      "4242 (llama-server (v2))",
      // state, ppid, pgrp, session, tty_nr, tpgid, flags
      "S", "1", "4242", "4242", "0", "-1", "4194304",
      // minflt..cstime, priority, nice, num_threads, itrealvalue
      "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0",
      // starttime, field 22 -- the one that closes pid reuse
      "987654", "and more fields after it",
    ].join(" ");
    const fields = fieldsFromStat(line);
    assert.equal(fields?.ppid, 1);
    assert.equal(fields?.pgrp, 4242);
    assert.equal(startTicksFromStat(line), 987654);
  });

  it("says nothing rather than half a row", () => {
    assert.equal(fieldsFromStat("nonsense with no bracket"), undefined);
    assert.equal(startTicksFromStat("4242 (short) S 1"), undefined);
  });

  it("splits a cmdline on NULs and drops the trailing one", () => {
    assert.deepEqual(argvFromCmdline("lemond\u0000--port\u000051000\u0000"), ["lemond", "--port", "51000"]);
  });
});

describe("records", () => {
  it("drops a malformed entry instead of throwing", () => {
    /* A record file MyRA cannot parse must not stop the app starting. Losing an
       entry costs one stray surviving until the next reboot; throwing costs the
       whole app. */
    const parsed = parseRecords([
      { pid: 7, port: 1, binary: LEMOND, startTicks: 5, startedAt: 2 },
      { pid: 0, binary: LEMOND },
      { pid: 8 },
      "nonsense",
      null,
    ]);
    assert.deepEqual(parsed.map((r) => r.pid), [7]);
    assert.deepEqual(parseRecords(null), []);
    assert.deepEqual(parseRecords({ pid: 7 }), []);
  });

  it("keeps one entry per pid and can forget one", () => {
    const one = withRecord([], record({ pid: 7 }));
    const again = withRecord(one, record({ pid: 7, port: 2 }));
    assert.equal(again.length, 1);
    assert.equal(again[0]?.port, 2);
    assert.deepEqual(withoutRecord(again, 7), []);
  });

  it("withoutRecords drops exactly the pids named, leaving anything else alone", () => {
    /* What a completed sweep uses instead of clearing the file wholesale: a
       daemon started after the sweep read its snapshot names a pid the sweep
       never saw, and must not be swept away along with the ones it did. */
    const all = [record({ pid: 1 }), record({ pid: 2 }), record({ pid: 3 })];
    assert.deepEqual(withoutRecords(all, [1, 3]).map((r) => r.pid), [2]);
    assert.deepEqual(withoutRecords(all, []), all);
    assert.deepEqual(withoutRecords(all, [4242]), all);
  });
});

describe("is this process ours", () => {
  it("never touches another account's process", () => {
    const them = proc({ pid: 4242, uid: 1001, argv: [LEMOND] });
    assert.equal(isOurDaemon(them, record(), US), false);
  });

  it("never touches a pid that has been recycled", () => {
    /* A pid comes round again within hours on a busy machine, and a record
       naming one is otherwise an instruction to kill whatever inherited it.
       The kernel's boot-relative start time is what closes that, and it is the
       check a later reader will be most tempted to simplify away. */
    const other = proc({ pid: 4242, argv: [LEMOND], startTicks: 999 });
    assert.equal(isOurDaemon(other, record({ startTicks: 100 }), US), false);
    assert.equal(isOurDaemon(proc({ pid: 4242, argv: [LEMOND] }), record(), US), true);
  });

  it("recognises the daemon started through the bundled loader", () => {
    /* On a machine with an older glibc, launchSpec runs lemond through the
       loader MyRA ships, so argv[0] is ld-linux and the binary is an argument.
       Matching only argv[0] would make every such machine unreclaimable. */
    const loaded = proc({
      pid: 4242,
      argv: [
        `${HOME}/runtimes/lemonade/11.8.0/ld-linux-x86-64.so.2`,
        "--library-path", `${HOME}/runtimes/lemonade/11.8.0/libc`,
        LEMOND, "--port", "51000",
      ],
    });
    assert.equal(isOurDaemon(loaded, record(), US), true);
  });

  it("never touches a Lemonade the user installed themselves", () => {
    /* The identity check is an absolute path inside MyRA's own data directory.
       A Lemonade from a package, a pipx venv or a Flatpak cannot match it, with
       or without a record pointing at the same pid. */
    const theirs = proc({ pid: 4242, argv: ["/usr/bin/lemonade", "serve"] });
    assert.equal(isOurDaemon(theirs, record(), US), false);
    assert.equal(looksLikeOurs(theirs, { ownedPrefixes: PREFIXES, selfUid: US }), false);
    assert.deepEqual(straysToKill([record()], [theirs], self), []);
  });

  it("wants the prefix at the start of an argument, not anywhere in it", () => {
    const decoy = proc({ pid: 50, argv: [`/home/user/not-myra${HOME}/runtimes/lemonade/lemond`] });
    assert.equal(looksLikeOurs(decoy, { ownedPrefixes: PREFIXES, selfUid: US }), false);
  });

  it("never signals a process merely because its argv mentions our folder", () => {
    /* The incident this closes: `tail -f ~/.config/MyRA/lemonade/logs/…` --
       following the troubleshooting docs -- names an owned path in argv while
       being nobody's model server at all. Its executable, `/usr/bin/tail`,
       gives the truth away; matching argv alone could not. */
    const tail = proc({
      pid: 60,
      exe: "/usr/bin/tail",
      argv: ["tail", "-f", `${HOME}/lemonade/logs/lemonade.log`],
    });
    assert.equal(looksLikeOurs(tail, { ownedPrefixes: PREFIXES, selfUid: US }), false);
  });

  it("still recognises the bundled loader once exe is what is checked", () => {
    /* The loader sits beside the binary it launches -- inside the same owned
       directory -- so matching on exe rather than argv does not need a special
       case for it. */
    const loaded = proc({
      pid: 4242,
      exe: `${HOME}/runtimes/lemonade/11.8.0/ld-linux-x86-64.so.2`,
      argv: [
        `${HOME}/runtimes/lemonade/11.8.0/ld-linux-x86-64.so.2`,
        "--library-path", `${HOME}/runtimes/lemonade/11.8.0/libc`,
        LEMOND, "--port", "51000",
      ],
    });
    assert.equal(looksLikeOurs(loaded, { ownedPrefixes: PREFIXES, selfUid: US }), true);
  });

  it("falls back to argv[0] only when the platform cannot report an executable", () => {
    /* macOS's `ps` has no exe column, so `scanDarwin` never sets one -- the
       one case where the weaker argv check is still the best available, and
       even then only against what was actually launched, not any later word
       on the command line. */
    const noExe = proc({ pid: 61, argv: [ENGINE, "-m", "model.gguf"] });
    assert.equal(looksLikeOurs(noExe, { ownedPrefixes: PREFIXES, selfUid: US }), true);

    const laterOnly = proc({
      pid: 62,
      argv: ["/usr/bin/tail", "-f", `${HOME}/lemonade/logs/lemonade.log`],
    });
    assert.equal(looksLikeOurs(laterOnly, { ownedPrefixes: PREFIXES, selfUid: US }), false);
  });
});

describe("which processes to reclaim", () => {
  it("reclaims an engine orphaned by a daemon that is already gone", () => {
    /* The case the machine is actually in. The SIGKILLed lemond left no record
       worth anything and is not in the table at all; the engine it spawned is a
       child of init, holding the card. Matching only recorded daemons would
       walk straight past the one process this exists to reclaim. */
    const orphan = proc({ pid: 4300, ppid: 1, pgrp: 4242, argv: [ENGINE, "-m", "model.gguf"] });
    const strays = straysToKill([], [orphan], self);
    assert.deepEqual(strays.map((s) => s.facts.pid), [4300]);
    assert.equal(strays[0]?.record, undefined);
  });

  it("kills pid by pid when the daemon is in somebody else's process group", () => {
    /* A daemon started before MyRA passed `detached` sits in whatever group
       Electron was in, which on a desktop session can be the session leader's.
       `kill(-pgrp)` against that signs the user out. */
    const old = proc({ pid: 4242, pgrp: 2, argv: [LEMOND] });
    const engine = proc({ pid: 4300, ppid: 4242, pgrp: 2, argv: [ENGINE] });
    const strays = straysToKill([record()], [old, engine], self);
    const daemon = strays.find((s) => s.facts.pid === 4242);
    assert.equal(daemon?.how, "tree");
    assert.deepEqual(daemon?.children.map((c) => c.pid), [4300]);
  });

  it("uses one group signal when the daemon leads its own group", () => {
    const led = proc({ pid: 4242, pgrp: 4242, argv: [LEMOND] });
    const strays = straysToKill([record()], [led], self);
    assert.equal(strays[0]?.how, "group");
    assert.deepEqual(strays[0]?.children, []);
  });

  it("never returns MyRA's own processes", () => {
    /* Electron's renderer and GPU children carry the app's own data directory
       in their argv. A sweep that killed those would take the app down as it
       started, which is a worse bug than the one it is fixing. */
    const renderer = proc({ pid: 11, ppid: self.pid, argv: ["electron", `--user-data-dir=${HOME}/runtimes/x`] });
    const helper = proc({ pid: 12, ppid: 11, argv: [`${HOME}/lemonade/helper`] });
    assert.deepEqual(straysToKill([], [proc({ pid: self.pid }), renderer, helper], self), []);
  });

  it("signals the deepest process first", () => {
    /* Otherwise lemond notices a backend dying and starts a replacement in the
       moment between the two signals. */
    const daemon = proc({ pid: 4242, pgrp: 2, argv: [LEMOND] });
    const engine = proc({ pid: 4300, ppid: 4242, pgrp: 2, argv: [ENGINE] });
    const strays = straysToKill([record()], [daemon, engine], self);
    assert.deepEqual(strays.map((s) => s.facts.pid), [4300, 4242]);
  });

  it("produces nothing for a record whose process has gone", () => {
    assert.deepEqual(straysToKill([record({ pid: 4242 })], [], self), []);
  });

  it("orders descendants deepest first", () => {
    const scan = [
      proc({ pid: 2, ppid: 1 }),
      proc({ pid: 3, ppid: 2 }),
      proc({ pid: 4, ppid: 3 }),
    ];
    assert.deepEqual(childrenOf(scan, 2).map((p) => p.pid), [4, 3]);
  });
});
