/**
 * The dashboard's arithmetic: what is counted, what is costed, which project
 * claims what, and where a day ends.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  costOf, emptyTotals, NO_PROJECT, OTHER, selectRecords, summarize, tokensPerSecond, TOP_SERIES,
  type ProjectContext,
} from "../src/core/usage/aggregate.ts";
import { classifyEndpoint, sameEndpoint, THIS_COMPUTER } from "../src/core/usage/classify.ts";
import { csvCell, usageCsv } from "../src/core/usage/export.ts";
import {
  bucketFor, bucketKey, bucketsIn, compactCount, daysIn, monthsIn, presetRange, thinLabels,
} from "../src/core/usage/range.ts";
import type { UsageRecord } from "../src/core/usage/record.ts";
import type { Provider } from "../src/core/providers.ts";

const at = (y: number, m: number, d: number, h = 12, min = 0): string => new Date(y, m - 1, d, h, min).toISOString();

/** An override, where `undefined` means "this record has no such field" -- an unreported count. */
type Over = { [K in keyof UsageRecord]?: UsageRecord[K] | undefined };

const rec = (extra: Over = {}): UsageRecord => {
  const out: Record<string, unknown> = {
    v: 1,
    at: at(2026, 10, 6),
    kind: "text",
    source: "app",
    feature: "chat",
    model: "qwen",
    provider: { id: "", name: THIS_COMPUTER },
    where: "local",
    ms: 1000,
    outcome: "ok",
    input: 100,
    output: 10,
    ...extra,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as UsageRecord;
};

const noProjects: ProjectContext = { names: new Map(), owners: new Map() };
const oct = { from: "2026-10-01", to: "2026-10-31" };

describe("totals", () => {
  it("add up what was reported and count what was not, apart", () => {
    const s = summarize(
      [rec(), rec({ input: 50, output: 5, cached: 40 }), rec({ input: undefined, output: undefined })],
      { range: oct },
      noProjects,
    );
    assert.equal(s.totals.requests, 3);
    assert.equal(s.totals.input, 150);
    assert.equal(s.totals.output, 15);
    assert.equal(s.totals.cached, 40);
    assert.equal(s.totals.unreported, 1, "a silent server is named, not summed as zero");
  });

  it("count a merged line as every request it stands for", () => {
    const s = summarize(
      [rec({ count: 5, outcome: "error", input: undefined, output: undefined, source: "api", feature: "api" })],
      { range: oct },
      noProjects,
    );
    assert.equal(s.totals.requests, 5);
    assert.equal(s.totals.errors, 5);
    assert.equal(s.breakdowns.source[0]?.totals.requests, 5);
  });

  it("do not call a failed call unreported", () => {
    const s = summarize([rec({ outcome: "error", input: undefined, output: undefined })], { range: oct }, noProjects);
    assert.equal(s.totals.errors, 1);
    assert.equal(s.totals.unreported, 0);
  });

  it("cost only what has a price and counts, and say how many hosted calls had none", () => {
    const priced = rec({ where: "external", input: 1_000_000, output: 500_000, price: { input: 3, output: 15 } });
    const unpriced = rec({ where: "external" });
    const local = rec();
    assert.equal(costOf(priced), 3 + 7.5);
    assert.equal(costOf(unpriced), undefined);
    const s = summarize([priced, unpriced, local], { range: oct }, noProjects);
    assert.equal(s.totals.cost, 10.5);
    assert.equal(s.totals.priced, 1);
    assert.equal(s.totals.unpriced, 1, "the local call is free, not unpriced");
    assert.equal(s.totals.local, 1);
  });

  it("measure speed only over calls that timed their generation", () => {
    const s = summarize(
      [rec({ output: 100, genMs: 2000 }), rec({ output: 50 })],
      { range: oct },
      noProjects,
    );
    assert.equal(tokensPerSecond(s.totals), 50);
    assert.equal(tokensPerSecond(emptyTotals()), undefined);
  });

  it("keep speech, transcription and images out of the token figures", () => {
    const s = summarize(
      [
        rec({ kind: "transcription", feature: "dictation", input: undefined, output: undefined, units: 90 }),
        rec({ kind: "image", feature: "image", input: undefined, output: undefined, units: 1, ms: 30_000 }),
        rec({ kind: "speech", feature: "voice", input: undefined, output: undefined, units: 400 }),
      ],
      { range: oct },
      noProjects,
    );
    assert.equal(s.totals.requests, 0);
    assert.equal(s.media.transcription.seconds, 90);
    assert.equal(s.media.image.images, 1);
    assert.equal(s.media.speech.characters, 400);
  });
});

describe("projects", () => {
  const ctx: ProjectContext = {
    names: new Map([["p-now", "Thesis"], ["p-then", "Pilot study"]]),
    owners: new Map([["chat:s1", "p-now"]]),
  };

  it("are whoever holds the item now, not who held it then", () => {
    const s = summarize(
      [rec({ item: { kind: "chat", ref: "s1" }, project: { id: "p-then", name: "Pilot study" } })],
      { range: oct },
      ctx,
    );
    assert.deepEqual(s.breakdowns.project.map((r) => r.label), ["Thesis"]);
  });

  it("fall back to the project recorded at the time when nothing holds the item", () => {
    const s = summarize(
      [rec({ item: { kind: "run", ref: "gone" }, project: { id: "p-then", name: "Pilot study" } })],
      { range: oct },
      ctx,
    );
    assert.deepEqual(s.breakdowns.project.map((r) => r.label), ["Pilot study"]);
  });

  it("keep a deleted project's name, and say it was deleted", () => {
    const s = summarize(
      [rec({ project: { id: "p-deleted", name: "Old grant" } })],
      { range: oct },
      ctx,
    );
    const [row] = s.breakdowns.project;
    assert.equal(row?.label, "Old grant");
    assert.equal(row?.detail, "deleted");
  });

  it("filter by project, including 'no project'", () => {
    const records = [rec({ item: { kind: "chat", ref: "s1" } }), rec()];
    assert.equal(summarize(records, { range: oct, filters: { project: "p-now" } }, ctx).totals.requests, 1);
    assert.equal(summarize(records, { range: oct, filters: { project: NO_PROJECT } }, ctx).totals.requests, 1);
  });
});

describe("breakdowns and filters", () => {
  const records = [
    rec({ model: "qwen" }),
    rec({ model: "gpt", provider: { id: "or", name: "OpenRouter" }, where: "external" }),
    rec({ source: "api", feature: "api", key: { id: "k1", label: "Laptop" } }),
    rec({ feature: "research", stage: "screen" }),
  ];

  it("separate the same model name on two providers", () => {
    const s = summarize(
      [rec({ model: "llama" }), rec({ model: "llama", provider: { id: "or", name: "OpenRouter" }, where: "external" })],
      { range: oct },
      noProjects,
    );
    assert.equal(s.breakdowns.model.length, 2);
  });

  it("say who asked: MyRA, or each API key", () => {
    const s = summarize(records, { range: oct }, noProjects);
    assert.deepEqual(s.breakdowns.source.map((r) => r.label).sort(), ["Laptop", "MyRA"]);
    assert.equal(summarize(records, { range: oct, filters: { source: "api" } }, noProjects).totals.requests, 1);
    assert.equal(summarize(records, { range: oct, filters: { source: "key:k1" } }, noProjects).totals.requests, 1);
    assert.equal(summarize(records, { range: oct, filters: { source: "app" } }, noProjects).totals.requests, 3);
  });

  it("split local from hosted", () => {
    const s = summarize(records, { range: oct, filters: { where: "external" } }, noProjects);
    assert.equal(s.totals.requests, 1);
    assert.equal(s.breakdowns.where[0]?.key, "external");
  });

  it("list research stages only for research", () => {
    const s = summarize(records, { range: oct }, noProjects);
    assert.deepEqual(s.breakdowns.stage.map((r) => r.key), ["screen"]);
  });

  it("offer every option in the range even while one is chosen", () => {
    const s = summarize(records, { range: oct, filters: { model: "::qwen" } }, noProjects);
    assert.ok(s.options.models.length >= 2);
  });

  it("export exactly the rows the summary counted", () => {
    const rows = selectRecords(records, { range: oct, filters: { where: "local" } }, noProjects);
    assert.equal(rows.length, 3);
  });
});

describe("the timeline", () => {
  it("buckets by the local day, so a late evening stays on its own date", () => {
    const s = summarize(
      [rec({ at: at(2026, 10, 6, 23, 50) }), rec({ at: at(2026, 10, 7, 0, 10) })],
      { range: { from: "2026-10-06", to: "2026-10-07" } },
      noProjects,
    );
    assert.deepEqual(s.timeline.buckets, ["2026-10-06", "2026-10-07"]);
    const [series] = s.timeline.series;
    assert.deepEqual(series?.values.map((v) => v.requests), [1, 1]);
  });

  it("keeps empty days, which are data too", () => {
    const s = summarize([rec({ at: at(2026, 10, 3) })], { range: { from: "2026-10-01", to: "2026-10-05" } }, noProjects);
    assert.equal(s.timeline.buckets.length, 5);
  });

  it("folds everything past the top few into one stack, in the table's order", () => {
    const many = Array.from({ length: TOP_SERIES + 3 }, (_v, i) => rec({ model: `m${i}`, input: 1000 - i * 10 }));
    const s = summarize(many, { range: oct, splitBy: "model" }, noProjects);
    assert.equal(s.timeline.series.length, TOP_SERIES + 1);
    assert.equal(s.timeline.series.at(-1)?.key, OTHER);
    assert.equal(s.timeline.series[0]?.key, s.breakdowns.model[0]?.key);
  });

  it("ignores what is outside the range", () => {
    const s = summarize([rec({ at: at(2026, 9, 30) })], { range: oct }, noProjects);
    assert.equal(s.totals.requests, 0);
  });
});

describe("ranges", () => {
  const now = new Date(2026, 9, 6, 15); // 6 October 2026, local

  it("turns presets into local dates", () => {
    assert.deepEqual(presetRange("today", now), { from: "2026-10-06", to: "2026-10-06" });
    assert.deepEqual(presetRange("7d", now), { from: "2026-09-30", to: "2026-10-06" });
    assert.deepEqual(presetRange("month", now), { from: "2026-10-01", to: "2026-10-06" });
    assert.deepEqual(presetRange("last-month", now), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(presetRange("year", now), { from: "2026-01-01", to: "2026-10-06" });
    assert.deepEqual(presetRange("all", now, "2026-08-14"), { from: "2026-08-14", to: "2026-10-06" });
    assert.deepEqual(presetRange("all", now), { from: "2026-10-06", to: "2026-10-06" });
  });

  it("chooses days, weeks or months by span", () => {
    assert.equal(bucketFor({ from: "2026-10-01", to: "2026-10-31" }), "day");
    assert.equal(bucketFor({ from: "2026-01-01", to: "2026-10-31" }), "week");
    assert.equal(bucketFor({ from: "2024-01-01", to: "2026-10-31" }), "month");
  });

  it("starts a week on Monday", () => {
    assert.equal(bucketKey("2026-10-06", "week"), "2026-10-05"); // a Tuesday
    assert.equal(bucketKey("2026-10-05", "week"), "2026-10-05"); // the Monday itself
    assert.equal(bucketKey("2026-10-04", "week"), "2026-09-28"); // the Sunday before
  });

  it("counts calendar days across a clock change", () => {
    assert.equal(daysIn({ from: "2026-03-01", to: "2026-03-31" }), 31);
    assert.equal(daysIn({ from: "2026-10-20", to: "2026-11-05" }), 17);
    assert.equal(bucketsIn({ from: "2026-03-28", to: "2026-04-02" }, "day").length, 6);
  });

  it("names the month files a range touches", () => {
    assert.deepEqual(monthsIn({ from: "2026-09-29", to: "2026-11-01" }), ["2026-09", "2026-10", "2026-11"]);
  });

  it("thins labels but always keeps the first and last", () => {
    const labels = Array.from({ length: 31 }, (_v, i) => String(i + 1));
    const thin = thinLabels(labels, 8);
    assert.equal(thin[0], "1");
    assert.equal(thin.at(-1), "31");
    assert.ok(thin.filter(Boolean).length <= 9);
    assert.deepEqual(thinLabels(["a", "b"], 8), ["a", "b"]);
  });

  it("shortens big counts without hiding small ones", () => {
    assert.equal(compactCount(950), "950");
    assert.equal(compactCount(1_000), "1k");
    assert.equal(compactCount(18_340), "18.3k");
    assert.equal(compactCount(1_240_000), "1.24M");
    assert.equal(compactCount(3_000_000_000), "3B");
  });
});

describe("where a request went", () => {
  const provider = (over: Partial<Provider>): Provider => ({
    id: "or", label: "OpenRouter", kind: "external", baseUrl: "https://openrouter.ai/api/v1",
    models: [], enabled: true, ...over,
  });

  it("knows MyRA's own runtime by its address, whatever path the call used", () => {
    const c = classifyEndpoint("http://127.0.0.1:41234/api/v1", "qwen", {
      providers: [], runtimeBaseUrl: "http://127.0.0.1:41234/api/v1",
    });
    assert.deepEqual(c, { provider: { id: "", name: THIS_COMPUTER }, where: "local" });
  });

  it("matches a provider however the address was spelled, and takes its price", () => {
    assert.ok(sameEndpoint("https://openrouter.ai/api/v1/", "https://OpenRouter.ai/api"));
    const c = classifyEndpoint("https://openrouter.ai/api/v1", "gpt", {
      providers: [provider({ prices: { gpt: { input: 2, output: 8 } } })],
    });
    assert.equal(c.provider.name, "OpenRouter");
    assert.equal(c.where, "external");
    assert.deepEqual(c.price, { input: 2, output: 8 });
  });

  it("calls a 'local' provider on another machine external, as the picker does", () => {
    const c = classifyEndpoint("http://192.168.1.20:8080/v1", "m", {
      providers: [provider({ id: "lab", label: "Lab box", kind: "local", baseUrl: "http://192.168.1.20:8080/v1" })],
    });
    assert.equal(c.where, "external");
  });

  it("judges an address it does not know by where it is", () => {
    assert.equal(classifyEndpoint("http://localhost:1234/v1", "m", { providers: [] }).where, "local");
    assert.equal(classifyEndpoint("https://api.example.com/v1", "m", { providers: [] }).where, "external");
    assert.equal(
      classifyEndpoint("http://localhost:1234/v1", "m", { providers: [], llmBaseUrl: "http://localhost:1234" }).provider.id,
      "llm",
    );
  });
});

describe("the CSV", () => {
  const column = (csv: string, name: string): string[] => {
    const [head, ...rows] = csv.trim().split("\n");
    const i = head!.split(",").indexOf(name);
    assert.ok(i >= 0, `no ${name} column`);
    return rows.map((r) => r.split(",")[i]!);
  };

  it("leaves unreported counts blank rather than writing zero", () => {
    const csv = usageCsv([rec({ input: undefined, output: undefined })], noProjects);
    assert.deepEqual(column(csv, "input_tokens"), [""]);
    assert.deepEqual(column(csv, "output_tokens"), [""]);
  });

  it("says how many requests a merged burst stands for", () => {
    const csv = usageCsv([rec(), rec({ count: 40 })], noProjects);
    assert.deepEqual(column(csv, "requests"), ["1", "40"]);
  });

  it("defuses a name a spreadsheet would run as a formula", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell(-3), "-3", "a number is a number");
    assert.equal(csvCell("a,b"), "\"a,b\"");
  });
});
