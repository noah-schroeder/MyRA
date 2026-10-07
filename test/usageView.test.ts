/**
 * What the usage page draws from a summary, with no DOM.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { summarize } from "../src/core/usage/aggregate.ts";
import type { UsageRecord } from "../src/core/usage/record.ts";
import {
  audioLength, axisLabel, chartFor, legendName, LEGEND_CHARS, metricOf, shareOf,
} from "../src/renderer/components/usageView.ts";

type Over = { [K in keyof UsageRecord]?: UsageRecord[K] | undefined };

const rec = (day: number, extra: Over = {}): UsageRecord => {
  const out: Record<string, unknown> = {
    v: 1,
    at: new Date(2026, 9, day, 12).toISOString(),
    kind: "text",
    source: "app",
    feature: "chat",
    model: "qwen",
    provider: { id: "", name: "This computer" },
    where: "local",
    ms: 100,
    outcome: "ok",
    input: 100,
    output: 20,
    ...extra,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as UsageRecord;
};

const none = { names: new Map<string, string>(), owners: new Map<string, string>() };

describe("the usage chart", () => {
  const summary = summarize(
    [rec(1), rec(2, { model: "gpt", where: "external", provider: { id: "or", name: "OR" }, price: { input: 1, output: 2 } })],
    { range: { from: "2026-10-01", to: "2026-10-31" }, splitBy: "model" },
    none,
  );

  it("stacks one bar per day, one segment per series", () => {
    const { data, labels } = chartFor(summary, "tokens", 8);
    assert.equal(data.kind, "bar");
    if (data.kind !== "bar") return;
    assert.equal(data.stacked, true);
    assert.equal(data.series.length, 2);
    assert.equal(data.categories.length, 31);
    assert.equal(labels.length, 31, "tooltips get every date, the axis gets a thinned few");
    assert.ok(data.categories.filter(Boolean).length <= 9);
    assert.equal(data.series[0]!.points[0]!.y + (data.series[1]!.points[0]!.y), 120);
  });

  it("says when there is nothing to draw for the chosen measure", () => {
    const local = summarize([rec(1)], { range: { from: "2026-10-01", to: "2026-10-03" } }, none);
    assert.equal(chartFor(local, "cost", 8).empty, true);
    assert.equal(chartFor(local, "requests", 8).empty, false);
  });

  it("measures one thing at a time", () => {
    const t = summary.totals;
    assert.equal(metricOf(t, "tokens"), t.input + t.output);
    assert.equal(metricOf(t, "requests"), 2);
  });
});

describe("labels", () => {
  it("prints an axis in the measure's own unit", () => {
    assert.equal(axisLabel(1_500_000, "tokens"), "1.5M");
    assert.equal(axisLabel(0.25, "cost"), "$0.25");
    assert.equal(axisLabel(0, "cost"), "$0");
  });

  it("shares by tokens, or by requests when nothing reported tokens", () => {
    const s = summarize([rec(1), rec(1, { input: undefined, output: undefined })], { range: { from: "2026-10-01", to: "2026-10-01" } }, none);
    assert.equal(shareOf(s.breakdowns.model[0]!.totals, s.totals), 1);
  });

  it("shortens a legend name to its column, and leaves a short one alone", () => {
    assert.equal(legendName("qwen"), "qwen");
    const long = legendName("anthropic/claude-sonnet");
    assert.ok(long.length <= LEGEND_CHARS && long.endsWith("…"));
  });

  it("says a duration the way a person reads one", () => {
    assert.equal(audioLength(42), "42 s");
    assert.equal(audioLength(600), "10 min");
    assert.equal(audioLength(3 * 3600), "3.0 h");
  });
});
