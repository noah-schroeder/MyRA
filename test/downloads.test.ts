/**
 * Model downloads: the record, and the registry that owns them.
 *
 * The bug being fixed is not subtle -- a download was a local variable in a
 * page, so changing page lost it -- but the replacement has two things worth
 * pinning. Pause and cancel are the SAME abort underneath and differ only in
 * what happens to the bytes afterwards, which is exactly the kind of pair that
 * drifts into deleting on a pause. And cancel deletes, so it has to be certain
 * about whose file it is deleting.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  activeCount, bytesLabel, etaLabel, fraction, newDownload, observe, pollForModel, rate, statusLine,
} from "../src/core/downloads/download.ts";
import { Downloads, type DownloadDeps } from "../src/main/downloads.ts";

const base = {
  name: "user.Qwen3-30B",
  checkpoint: "Qwen/Qwen3-30B-GGUF:Q4_K_M",
  source: "huggingface",
  recipe: "llamacpp",
};

function tick(bytesDone: number, bytesTotal = 1_000_000) {
  return { file: "model.gguf", fileIndex: 1, totalFiles: 1, bytesDone, bytesTotal };
}

/** A pull that never finishes on its own, so a test decides how it ends. */
function harness(over: Partial<DownloadDeps> = {}) {
  const published: number[] = [];
  const removed: string[] = [];
  let emit: ((n: number, total?: number) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  let finish: (() => void) | undefined;

  const deps: DownloadDeps = {
    pull: ({ signal, onProgress }) =>
      new Promise<void>((resolve, reject) => {
        emit = (n, total) => onProgress(tick(n, total));
        finish = resolve;
        fail = reject;
        signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      }),
    remove: async (name) => {
      removed.push(name);
    },
    publish: (list) => published.push(list.length),
    ...over,
  };
  return { deps, published, removed, emit: () => emit!, fail: () => fail!, finish: () => finish! };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the record", () => {
  it("keeps a size the daemon reported once and then stopped repeating", () => {
    /* Measured: lemond sends the real total on the first frame and 0 on many
       of the ones after. Taking the latest value collapses the bar to nothing
       halfway through a download that is going perfectly well. */
    let d = newDownload({ id: "1", ...base });
    d = observe(d, tick(100, 5_000));
    d = observe(d, tick(200, 0));
    assert.equal(d.bytesTotal, 5_000);
    assert.equal(fraction(d), 200 / 5_000);
  });

  it("has no percentage until it has a size", () => {
    const d = newDownload({ id: "1", ...base });
    assert.equal(fraction(d), undefined);
  });

  it("measures a rate across the window, not between two ticks", () => {
    /* Consecutive frames arrive milliseconds apart, and dividing by that gap
       produces hundreds of megabytes a second on a slow connection. */
    let d = newDownload({ id: "1", ...base });
    d = observe(d, tick(0), 1_000);
    d = observe(d, tick(1_000_000), 1_001); // 1ms later: absurd on its own
    d = observe(d, tick(2_000_000), 3_000);
    assert.equal(Math.round(rate(d)!), 1_000_000);
  });

  it("reports no rate when nothing has moved", () => {
    let d = newDownload({ id: "1", ...base });
    d = observe(d, tick(500), 1_000);
    d = observe(d, tick(500), 5_000);
    assert.equal(rate(d), undefined);
    assert.equal(statusLine(d).includes("NaN"), false);
  });
});

describe("what it prints", () => {
  it("sizes in the unit a person would say", () => {
    assert.equal(bytesLabel(0), "0 B");
    assert.equal(bytesLabel(1023), "1023 B");
    assert.equal(bytesLabel(1024 * 1024 * 1.5), "1.5 MB");
    assert.equal(bytesLabel(1024 ** 3 * 18), "18 GB");
  });

  it("never counts down in seconds, and never says 0m", () => {
    assert.equal(etaLabel(12), "less than a minute left");
    assert.equal(etaLabel(59), "less than a minute left");
    assert.equal(etaLabel(3600), "1h left");
    assert.equal(etaLabel(3600 + 120), "1h 2m left");
    assert.equal(etaLabel(undefined), "");
  });

  it("says which file when a repository holds several", () => {
    /* A bar that sits at 60% for ten minutes is explained by "file 2 of 5"
       and by nothing else on screen. */
    let d = newDownload({ id: "1", ...base });
    d = observe(d, { file: "b.gguf", fileIndex: 2, totalFiles: 5, bytesDone: 10, bytesTotal: 100 });
    assert.match(statusLine(d), /file 2 of 5/);
  });

  it("does not dress a pause up as progress", () => {
    let d = newDownload({ id: "1", ...base });
    d = observe(d, tick(500, 1000));
    assert.match(statusLine({ ...d, state: "paused" }), /paused/);
  });
});

describe("pausing", () => {
  it("stops the transfer but keeps the row, so it can be resumed", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    h.emit()(400_000);
    reg.pause(d.id);
    await settle();

    const [row] = reg.list();
    assert.equal(row?.state, "paused");
    // And the bytes are still counted, which is the whole point of a pause.
    assert.equal(row?.bytesDone, 400_000);
    assert.deepEqual(h.removed, []);
  });

  it("is not reported as a failure", async () => {
    /* An abort rejects with "This operation was aborted". Showing that in red
       under a row the user paused on purpose is the obvious wrong thing. */
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    reg.pause(d.id);
    await settle();
    assert.equal(reg.list()[0]?.error, undefined);
  });

  it("resumes with a fresh signal, rather than the aborted one", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    reg.pause(d.id);
    await settle();
    reg.resume(d.id);
    await settle();
    assert.equal(reg.list()[0]?.state, "running");
  });

  it("forgets the rate across a pause", async () => {
    /* Otherwise the first tick after resuming is divided by the length of the
       pause, and a download that just restarted reports 4 KB/s. */
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    h.emit()(100);
    reg.pause(d.id);
    await settle();
    reg.resume(d.id);
    assert.deepEqual(reg.list()[0]?.samples, []);
  });
});

describe("cancelling", () => {
  it("deletes what was fetched, through the daemon", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    await reg.cancel(d.id);

    assert.deepEqual(h.removed, ["user.Qwen3-30B"]);
    assert.deepEqual(reg.list(), []);
  });

  it("never deletes a model that was already installed", async () => {
    /* Re-downloading a model you have and then changing your mind must not
       take the working copy with it. This is the reason `replacing` exists. */
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start({ ...base, replacing: true });
    await reg.cancel(d.id);

    assert.deepEqual(h.removed, []);
    assert.deepEqual(reg.list(), []);
  });
});

describe("the list", () => {
  it("does not start a second copy of a download already running", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    const first = reg.start(base);
    const again = reg.start(base);
    assert.equal(again.id, first.id);
    assert.equal(reg.list().length, 1);
  });

  it("marks a real failure as one, with the daemon's own words", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    reg.start(base);
    h.fail()(new Error("no space left on device"));
    await settle();

    const [row] = reg.list();
    assert.equal(row?.state, "failed");
    assert.equal(row?.error, "no space left on device");
  });

  it("counts what is unfinished, which is what the badge shows", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    reg.start(base);
    h.finish()();
    await settle();
    assert.equal(reg.list()[0]?.state, "done");
    // A finished download is still listed, so it can be seen, but not counted.
    assert.equal(activeCount(reg.list()), 0);
  });

  it("clears finished rows without touching one still going", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    reg.start(base);
    h.finish()();
    await settle();
    reg.start({ ...base, name: "user.other" });
    reg.dismissSettled();

    assert.deepEqual(reg.list().map((d) => d.name), ["user.other"]);
  });

  it("refuses to dismiss one that is still running", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    const d = reg.start(base);
    reg.dismiss(d.id);
    assert.equal(reg.list().length, 1);
  });
});

describe("a repository fetched as several files", () => {
  it("asks again when a connection closes before the last file, and stops once it reaches it", async () => {
    // The shape actually observed against a real daemon: each connection
    // streams exactly one file's progress and then closes on its own, well
    // before the whole repository is on disk.
    let calls = 0;
    const deps: DownloadDeps = {
      pull: async ({ onProgress }) => {
        calls += 1;
        onProgress({ file: `part-${calls}.gguf`, fileIndex: calls, totalFiles: 3, bytesDone: calls, bytesTotal: 3 });
      },
      remove: async () => {},
      publish: () => {},
    };
    const reg = new Downloads(deps);
    reg.start(base);
    await settle();

    assert.equal(calls, 3);
    assert.equal(reg.list()[0]?.state, "done");
  });

  it("does not ask again once one connection already covered every file", async () => {
    let calls = 0;
    const deps: DownloadDeps = {
      pull: async ({ onProgress }) => {
        calls += 1;
        onProgress({ file: "model.gguf", fileIndex: 3, totalFiles: 3, bytesDone: 3, bytesTotal: 3 });
      },
      remove: async () => {},
      publish: () => {},
    };
    const reg = new Downloads(deps);
    reg.start(base);
    await settle();

    assert.equal(calls, 1);
    assert.equal(reg.list()[0]?.state, "done");
  });

  it("stops retrying, rather than looping forever, once a retry reports no further progress", async () => {
    let calls = 0;
    const deps: DownloadDeps = {
      pull: async ({ onProgress }) => {
        calls += 1;
        // Stuck on file 1 of 3 every time -- the theory that a fresh
        // connection hands out the next file's progress does not hold here,
        // and this must not spin asking forever.
        onProgress({ file: "part-1.gguf", fileIndex: 1, totalFiles: 3, bytesDone: 1, bytesTotal: 3 });
      },
      remove: async () => {},
      publish: () => {},
    };
    const reg = new Downloads(deps);
    reg.start(base);
    await settle();

    assert.equal(calls, 2); // the original attempt, and exactly one retry
    // Given up on rather than left stuck: the files were observed to land
    // correctly even when MyRA stopped watching, so this still settles done.
    assert.equal(reg.list()[0]?.state, "done");
  });

  it("single-file downloads never trigger a second connection", async () => {
    const h = harness();
    const reg = new Downloads(h.deps);
    reg.start(base);
    h.emit()(500, 1_000);
    h.finish()();
    await settle();
    assert.equal(reg.list()[0]?.state, "done");
    // harness()'s pull is reassigned by every call it receives; if a second
    // one had been made, h.emit()/h.finish() above would be targeting stale
    // closures from the first and this settle would still be pending.
  });
});

describe("waiting for the daemon's index to catch up", () => {
  it("costs nothing when the model is already there", async () => {
    const sleeps: number[] = [];
    const found = await pollForModel(
      "Qwen3-30B",
      async () => [{ id: "Qwen3-30B" }],
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.deepEqual(found, { id: "Qwen3-30B" });
    assert.deepEqual(sleeps, []); // no retry, so no wait was ever needed
  });

  it("retries until the daemon's own list catches up", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const found = await pollForModel(
      "Qwen3-30B",
      async () => {
        calls += 1;
        // Not there for the first two looks -- exactly the shape of a
        // multi-file pull whose stream has closed before the daemon has
        // finished indexing every shard it just wrote.
        return calls < 3 ? [] : [{ id: "Qwen3-30B" }];
      },
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.deepEqual(found, { id: "Qwen3-30B" });
    assert.equal(calls, 3);
    // Growing waits, not a fixed poll interval hammering the daemon.
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  it("gives up rather than waiting forever for a model that never appears", async () => {
    const sleeps: number[] = [];
    const found = await pollForModel(
      "Qwen3-30B",
      async () => [],
      { attempts: 3, sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.equal(found, undefined);
    // One fewer wait than attempts: no point sleeping after the last look.
    assert.deepEqual(sleeps, [1000, 2000]);
  });
});
