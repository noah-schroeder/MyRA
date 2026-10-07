/**
 * An API client's rapid repeats become one line a second, and the dashboard
 * cannot tell the difference.
 *
 * The property that matters is the second half: merging is only safe if every
 * total, every breakdown and every filter answers exactly what it would have
 * answered for the unmerged lines.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { summarize, type ProjectContext, type UsageSummary } from "../src/core/usage/aggregate.ts";
import { Coalescer, mergeKey } from "../src/core/usage/coalesce.ts";
import type { UsageRecord } from "../src/core/usage/record.ts";

type Over = { [K in keyof UsageRecord]?: UsageRecord[K] | undefined };

const api = (extra: Over = {}): UsageRecord => {
  const out: Record<string, unknown> = {
    v: 1,
    at: new Date(2026, 9, 6, 12).toISOString(),
    kind: "text",
    source: "api",
    feature: "api",
    model: "qwen",
    provider: { id: "", name: "This computer" },
    where: "local",
    key: { id: "k1", label: "Laptop" },
    ms: 2,
    outcome: "error",
    ...extra,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as UsageRecord;
};

const none: ProjectContext = { names: new Map(), owners: new Map() };
const oct = { range: { from: "2026-10-01", to: "2026-10-31" } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every figure the page shows, for comparing two sets of lines. */
const shown = (s: UsageSummary): unknown => ({ totals: s.totals, breakdowns: s.breakdowns, media: s.media });

describe("a burst", () => {
  it("of identical failures is one line, counting every attempt", () => {
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 60_000);
    for (let i = 0; i < 300; i++) c.add(api());
    assert.equal(written.length, 0, "held until the window closes");
    c.flush();
    assert.equal(written.length, 1);
    assert.equal(written[0]!.count, 300);
    assert.equal(written[0]!.ms, 600);
  });

  it("keeps apart what the dashboard tells apart", () => {
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 60_000);
    c.add(api());
    c.add(api({ outcome: "ok", input: 10, output: 2 }));
    c.add(api({ outcome: "ok" })); // finished, but nothing reported
    c.add(api({ key: { id: "k2", label: "Phone" } }));
    c.add(api({ model: "llama" }));
    c.add(api({ kind: "embeddings" }));
    c.flush();
    assert.equal(written.length, 6);
    assert.equal(new Set(written.map(mergeKey)).size, 6);
  });

  it("answers every total, breakdown and filter exactly as the separate lines would", () => {
    const lines: UsageRecord[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(api({ outcome: "ok", input: 100 + i, output: 5, cached: i % 3 }));
      lines.push(api());
      lines.push(api({ outcome: "ok", key: { id: "k2", label: "Phone" }, input: 7, output: 1 }));
      lines.push(api({ outcome: "ok" }));
      lines.push(api({ kind: "transcription", outcome: "ok" }));
    }
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 60_000);
    for (const r of lines) c.add(r);
    c.flush();
    assert.ok(written.length < 10, `${written.length} lines for ${lines.length} requests`);

    assert.deepEqual(shown(summarize(written, oct, none)), shown(summarize(lines, oct, none)));
    for (const filters of [{ source: "key:k2" }, { source: "api" }, { model: "::qwen" }, { where: "local" as const }]) {
      assert.deepEqual(
        shown(summarize(written, { ...oct, filters }, none)),
        shown(summarize(lines, { ...oct, filters }, none)),
        JSON.stringify(filters),
      );
    }
  });

  it("does not change the record it was handed", () => {
    const first = api({ outcome: "ok", input: 1, output: 1 });
    const c = new Coalescer(() => {}, 60_000);
    c.add(first);
    c.add(api({ outcome: "ok", input: 1, output: 1 }));
    c.flush();
    assert.equal(first.count, undefined);
    assert.equal(first.input, 1);
  });
});

describe("the window", () => {
  it("writes a lone request on its own, a moment later", async () => {
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 20);
    c.add(api({ outcome: "ok", input: 3, output: 1 }));
    await sleep(60);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.count, undefined, "one request is just a line");
  });

  it("starts again after each flush, so a long loop is one line a window", async () => {
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 20);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 100; i++) c.add(api());
      await sleep(50);
    }
    assert.equal(written.length, 3);
    assert.deepEqual(written.map((r) => r.count), [100, 100, 100]);
  });
});

describe("clearing", () => {
  it("drops a held burst rather than writing it into the fresh log", async () => {
    const written: UsageRecord[] = [];
    const c = new Coalescer((r) => written.push(r), 20);
    for (let i = 0; i < 10; i++) c.add(api());
    c.discard();
    await sleep(60);
    assert.equal(written.length, 0);
    c.add(api());
    c.flush();
    assert.equal(written.length, 1, "and carries on counting afterwards");
  });
});
