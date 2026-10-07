/**
 * The usage record on disk: owner-only, one file per local month, and a read
 * that survives a torn line and a file that grows under it.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageLog } from "../src/core/usage/log.ts";
import { parseUsageRecord, type UsageRecord } from "../src/core/usage/record.ts";

let root = "";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "myra-usage-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A local-time moment, so the test means the same day in every timezone. */
const at = (y: number, m: number, d: number, h = 12): string => new Date(y, m - 1, d, h).toISOString();

const record = (when: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  at: when,
  kind: "text",
  source: "app",
  feature: "chat",
  model: "m",
  provider: { id: "", name: "This computer" },
  where: "local",
  ms: 10,
  outcome: "ok",
  input: 5,
  output: 1,
  ...extra,
});

describe("UsageLog", () => {
  it("writes one owner-only file per local month", async () => {
    const dir = join(root, "a");
    const log = new UsageLog(dir);
    await log.append(record(at(2026, 9, 30, 23)));
    await log.append(record(at(2026, 10, 1, 0)));
    await log.flush();
    assert.deepEqual((await readdir(dir)).sort(), ["2026-09.jsonl", "2026-10.jsonl"]);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "2026-10.jsonl"))).mode & 0o777, 0o600);
    assert.deepEqual(await log.months(), ["2026-09", "2026-10"]);
  });

  it("reads only the days in the range", async () => {
    const log = new UsageLog(join(root, "b"));
    for (const d of [1, 2, 3, 4]) await log.append(record(at(2026, 10, d)));
    const got = await log.read({ from: "2026-10-02", to: "2026-10-03" });
    assert.equal(got.length, 2);
  });

  it("skips a torn line and keeps the rest", async () => {
    const dir = join(root, "c");
    const log = new UsageLog(dir);
    await log.append(record(at(2026, 10, 5)));
    await appendFile(join(dir, "2026-10.jsonl"), '{"v":1,"at":"2026-10-05T1\n');
    await log.append(record(at(2026, 10, 5)));
    const got = await log.read({ from: "2026-10-01", to: "2026-10-31" });
    assert.equal(got.length, 2);
  });

  it("picks up lines appended after the last read, without re-reading the rest", async () => {
    const dir = join(root, "d");
    const log = new UsageLog(dir);
    await log.append(record(at(2026, 10, 6), { model: "first" }));
    assert.equal((await log.read({ from: "2026-10-06", to: "2026-10-06" })).length, 1);
    await log.append(record(at(2026, 10, 6), { model: "second" }));
    const got = await log.read({ from: "2026-10-06", to: "2026-10-06" });
    assert.deepEqual(got.map((r) => r.model), ["first", "second"]);
  });

  it("leaves a line still being written for the next read", async () => {
    const dir = join(root, "e");
    const log = new UsageLog(dir);
    await log.append(record(at(2026, 10, 7), { model: "whole" }));
    const half = JSON.stringify(record(at(2026, 10, 7), { model: "late" }));
    await appendFile(join(dir, "2026-10.jsonl"), half.slice(0, 20));
    assert.equal((await log.read({ from: "2026-10-07", to: "2026-10-07" })).length, 1);
    await appendFile(join(dir, "2026-10.jsonl"), half.slice(20) + "\n");
    const got = await log.read({ from: "2026-10-07", to: "2026-10-07" });
    assert.deepEqual(got.map((r) => r.model), ["whole", "late"], "the late line, whole, not lost as torn");
  });

  it("knows the first day anything was recorded", async () => {
    const log = new UsageLog(join(root, "f"));
    assert.equal(await log.earliest(), undefined);
    await log.append(record(at(2026, 8, 20)));
    await log.append(record(at(2026, 8, 14)));
    assert.equal(await log.earliest(), "2026-08-14");
  });

  it("answers the same after a different range has pushed a month out of memory", async () => {
    const log = new UsageLog(join(root, "i"));
    await log.append(record(at(2026, 8, 3)));
    await log.append(record(at(2026, 10, 3)));
    assert.equal((await log.read({ from: "2026-08-01", to: "2026-08-31" })).length, 1);
    assert.equal((await log.read({ from: "2026-10-01", to: "2026-10-31" })).length, 1);
    assert.equal(await log.earliest(), "2026-08-03");
    await log.append(record(at(2026, 8, 1)));
    assert.equal(await log.earliest(), "2026-08-01", "a new line in the first month is seen");
    assert.equal((await log.read({ from: "2026-08-01", to: "2026-08-31" })).length, 2);
  });

  it("clears everything", async () => {
    const dir = join(root, "g");
    const log = new UsageLog(dir);
    await log.append(record(at(2026, 10, 1)));
    await log.append(record(at(2026, 9, 1)));
    await log.clear();
    assert.deepEqual(await log.months(), []);
    assert.deepEqual(await log.read({ from: "2026-09-01", to: "2026-10-31" }), []);
  });

  it("never writes anything but the record's own fields", async () => {
    const dir = join(root, "h");
    const log = new UsageLog(dir);
    // A record carrying a field it does not have -- the way a careless caller might.
    await log.append({ ...record(at(2026, 10, 2)), prompt: "the secret" } as UsageRecord);
    const raw = await readFile(join(dir, "2026-10.jsonl"), "utf8");
    assert.ok(!raw.includes("the secret"), "the file itself, not just what is read back");
    assert.equal((await log.read({ from: "2026-10-02", to: "2026-10-02" })).length, 1);
  });
});

describe("parseUsageRecord", () => {
  it("drops what is not a record, and coerces what is", () => {
    assert.equal(parseUsageRecord(null), undefined);
    assert.equal(parseUsageRecord({ at: "not a date" }), undefined);
    const r = parseUsageRecord({ at: "2026-10-01T10:00:00Z", feature: "nonsense", input: -4, output: 3, where: "moon" });
    assert.equal(r?.feature, "other");
    assert.equal(r?.input, undefined, "a negative count is not a count");
    assert.equal(r?.output, 3);
    assert.equal(r?.where, "external", "anything not plainly local is treated as leaving");
  });

  it("keeps a merged line's count through the file, and drops a meaningless one", async () => {
    const log = new UsageLog(join(root, "j"));
    await log.append(record(at(2026, 10, 9), { count: 7 }));
    const [r] = await log.read({ from: "2026-10-09", to: "2026-10-09" });
    assert.equal(r?.count, 7);
    assert.equal(parseUsageRecord({ at: "2026-10-01T10:00:00Z", count: 1 })?.count, undefined, "one is the default");
    assert.equal(parseUsageRecord({ at: "2026-10-01T10:00:00Z", count: -3 })?.count, undefined);
  });

  it("keeps a price only when both halves are there", () => {
    assert.equal(parseUsageRecord({ at: "2026-10-01T10:00:00Z", price: { input: 3 } })?.price, undefined);
    assert.deepEqual(parseUsageRecord({ at: "2026-10-01T10:00:00Z", price: { input: 3, output: 15 } })?.price, {
      input: 3,
      output: 15,
    });
  });
});
