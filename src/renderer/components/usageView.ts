/**
 * What the usage page draws, worked out with no DOM -- a `.ts` beside the
 * component so the test runner can load it, the reason meterBars.ts gives.
 *
 * One metric at a time on the chart, never two on twin axes: tokens and
 * dollars and request counts are different scales, and a second y-axis
 * invites reading a crossing of two lines as meaning something.
 */

import type { ChartData } from "../../core/charts/layout.ts";
import { money } from "../../core/pricing.ts";
import type { UsageSummary, UsageTotals } from "../../core/usage/aggregate.ts";
import { compactCount, thinLabels } from "../../core/usage/range.ts";

export type UsageMetric = "tokens" | "input" | "output" | "requests" | "cost";

export const METRICS: { id: UsageMetric; label: string }[] = [
  { id: "tokens", label: "All tokens" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "requests", label: "Requests" },
  { id: "cost", label: "Cost" },
];

export function metricOf(t: UsageTotals, metric: UsageMetric): number {
  switch (metric) {
    case "tokens": return t.input + t.output;
    case "input": return t.input;
    case "output": return t.output;
    case "requests": return t.requests;
    case "cost": return t.cost;
  }
}

/** A figure in the metric's own unit, short. */
export function formatMetric(n: number, metric: UsageMetric): string {
  return metric === "cost" ? money(n) : compactCount(n);
}

/** The y-axis wants fewer digits than a tile does. */
export function axisLabel(n: number, metric: UsageMetric): string {
  if (metric !== "cost") return compactCount(n);
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(2)}` : `$${compactCount(n)}`;
}

export interface UsageChart {
  data: ChartData;
  /** The unthinned bucket labels, for tooltips. */
  labels: string[];
  /** True when every bar is zero -- the page says so instead of an empty frame. */
  empty: boolean;
}

/**
 * The timeline as a stacked bar chart.
 *
 * `maxLabels` thins the date labels to what the measured width can print;
 * the bars themselves are never thinned, since an empty day is data.
 */
export function chartFor(summary: UsageSummary, metric: UsageMetric, maxLabels: number): UsageChart {
  const { labels, series } = summary.timeline;
  const values = series.map((s) => s.values.map((v) => metricOf(v, metric)));
  return {
    data: {
      kind: "bar",
      categories: thinLabels(labels, maxLabels),
      stacked: true,
      series: series.map((s, i) => ({
        name: legendName(s.label),
        points: values[i]!.map((y, x) => ({ x, y })),
      })),
    },
    labels,
    empty: values.every((row) => row.every((v) => v === 0)),
  };
}

/** Room for about this many characters beside a legend swatch at the chart's type size. */
export const LEGEND_CHARS = 17;

/**
 * A series name short enough for the legend's column, which is a fixed width
 * on the right of the plot -- "anthropic/claude-sonnet" was cut mid-word. The
 * whole name is in each bar's tooltip and in the table under the chart.
 */
export function legendName(label: string): string {
  return label.length <= LEGEND_CHARS ? label : `${label.slice(0, LEGEND_CHARS - 1).trimEnd()}…`;
}

/** A whole share, for the bar in a table row. */
export function shareOf(part: UsageTotals, whole: UsageTotals): number {
  const tokens = whole.input + whole.output;
  if (tokens > 0) return (part.input + part.output) / tokens;
  return whole.requests > 0 ? part.requests / whole.requests : 0;
}

/** Minutes of audio, said the way a person reads a duration. */
export function audioLength(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 120) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}
