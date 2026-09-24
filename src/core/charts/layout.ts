/**
 * Placing a chart's marks, with no DOM to measure against -- the same
 * discipline as core/diagrams/layout.ts, and for the same reason: the
 * renderer draws this as React elements and svg.ts serialises the same
 * numbers to a file, so both are the same figure by construction rather than
 * by two pieces of code agreeing. Text is estimated, never measured, because
 * nothing here can call `measureText`.
 *
 * `ChartData` is what this module lays out, and it is already pure numbers
 * by the time it gets here -- tools/chart.ts is the only thing that turns a
 * `DataTable` and a `ChartSpec` into one, and it is where a cell with no safe
 * numeric reading is refused, never silently dropped or guessed at. Nothing
 * in this file makes that judgement; it only places numbers that already
 * exist.
 */

import { niceScale, type Scale } from "./scale.ts";
import type { ChartKind } from "./spec.ts";
import { quartiles } from "../tabular/stats.ts";

export const FONT_SIZE = 12;
const CHAR_W = 0.56;
const MARGIN = 16;
const AXIS_TITLE_GAP = 22;
const TICK_LABEL_GAP = 18;
const TITLE_GAP = 24;
const LEGEND_ROW = 18;
/** The figure's size with no `size` option given -- "standard" export, and
 *  every existing test and caller that predates the artifact panel drawing
 *  a chart at its own size. */
export const CANVAS_W = 640;
export const CANVAS_H = 420;
/** Below this width a legend in the 120px right margin would take a third of
 *  the plot -- see layoutFrame's own comment on where it moves instead. */
const LEGEND_NARROW = 480;
/** How wide the panel has to be measured at minimum, so a chart never
 *  collapses into unreadable text -- see chartSizeFor. */
const MIN_CHART_W = 300;
const MIN_CHART_H = 200;
/** A tall, narrow panel gets a chart capped at 4:5 rather than a sliver
 *  stretched down the whole column. */
const MAX_H_RATIO = 0.8;

export interface DataPoint {
  x: number;
  y: number;
  /** A half-width, so the bar spans `y - error` to `y + error`. */
  error?: number | undefined;
}

export interface Series {
  name: string;
  points: DataPoint[];
}

export interface BoxGroupData {
  label: string;
  values: number[];
}

/**
 * What `tools/chart.ts` builds from a `DataTable` and hands to `layoutChart`
 * -- already pure numbers, already validated. For "bar" and "box", a
 * point's or value's position along the category axis is its array index,
 * not a data value.
 */
export type ChartData =
  | { kind: "scatter"; series: Series[]; fit?: { slope: number; intercept: number; r2: number } | undefined }
  | { kind: "line"; series: Series[] }
  | { kind: "bar"; categories: string[]; series: Series[]; stacked: boolean }
  | { kind: "box"; groups: BoxGroupData[] }
  | { kind: "histogram"; values: number[] };

function textWidth(text: string): number {
  return text.length * FONT_SIZE * CHAR_W;
}

export interface PlottedPoint {
  x: number;
  y: number;
  errorTop?: number | undefined;
  errorBottom?: number | undefined;
}

export interface PlottedSeries {
  name: string;
  colorIndex: number;
  points: PlottedPoint[];
}

export interface FitLine {
  x1: number; y1: number; x2: number; y2: number;
  label: string;
}

export interface PlottedBar {
  seriesIndex: number;
  colorIndex: number;
  category: number;
  x: number;
  w: number;
  /** Device coordinates; `yTop < yBottom` always, since SVG y grows downward. */
  yTop: number;
  yBottom: number;
  errorTop?: number | undefined;
  errorBottom?: number | undefined;
}

export interface PlottedBox {
  label: string;
  x: number;
  w: number;
  q1: number; median: number; q3: number;
  whiskerLo: number; whiskerHi: number;
  /** Points outside 1.5x the interquartile range, drawn individually so no
   *  value is ever invisibly absorbed into the whisker -- see this module's
   *  header on refusing to drop data silently. */
  outliers: number[];
  method: string;
}

export interface HistBar {
  x0: number; x1: number;
  yTop: number; yBottom: number;
  count: number;
  rangeLabel: string;
}

export interface Tick { pos: number; label: string; }
export interface CategoryTick { pos: number; label: string; }

/** A legend entry's own device position -- placed once, here, rather than
 *  recomputed by both the renderer and svg.ts from a bare name/colorIndex
 *  list, which is exactly how the two drifted apart before ChartLayout
 *  carried positions of its own. */
export interface PlacedLegendEntry { name: string; colorIndex: number; x: number; y: number; }

/** The figure size a caller measured off its own panel, fed back into
 *  `layoutChart` so the plot redraws at that size instead of the fixed
 *  canvas. See chartSizeFor for how one is built from raw available space. */
export interface ChartSize { width: number; height: number; }

export interface ChartLayout {
  kind: ChartKind;
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  yTicks: Tick[];
  /** Present for scatter/line (a numeric axis) and absent for bar/box/
   *  histogram, which use `categoryTicks` instead. */
  xTicks?: Tick[] | undefined;
  categoryTicks?: CategoryTick[] | undefined;
  title?: string | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  legend: PlacedLegendEntry[];
  series?: PlottedSeries[] | undefined;
  fit?: FitLine | undefined;
  bars?: PlottedBar[] | undefined;
  boxes?: PlottedBox[] | undefined;
  histogram?: HistBar[] | undefined;
}

function deviceX(v: number, scale: Scale, plot: { x: number; w: number }): number {
  return plot.x + ((v - scale.lo) / (scale.hi - scale.lo || 1)) * plot.w;
}

function deviceY(v: number, scale: Scale, plot: { y: number; h: number }): number {
  return plot.y + plot.h - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * plot.h;
}

/** How much room the y-axis tick labels need, so the plot area does not
 *  start at a fixed offset regardless of whether labels read "1" or
 *  "123,456.5". */
function yTickLabelWidth(scale: Scale): number {
  const longest = scale.ticks.reduce((n, v) => Math.max(n, String(v).length), 1);
  return longest * FONT_SIZE * CHAR_W;
}

interface Frame {
  plot: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  legend: PlacedLegendEntry[];
}

/** A named legend entry's own printed width -- swatch, gap, text, trailing
 *  gap -- used to decide how many fit on one row below the plot. */
function legendItemWidth(name: string): number {
  return 20 + textWidth(name) + 8;
}

/** Greedily wraps legend entries into rows no wider than `availWidth`, never
 *  leaving a row empty and always making progress even when a single entry
 *  alone is wider than the row -- see the `x > 0` guard. */
function packLegend<T extends { name: string }>(items: T[], availWidth: number): T[][] {
  const rows: T[][] = [[]];
  let x = 0;
  for (const item of items) {
    const w = legendItemWidth(item.name);
    if (x + w > availWidth && x > 0) {
      rows.push([]);
      x = 0;
    }
    rows[rows.length - 1]!.push(item);
    x += w;
  }
  return rows;
}

function layoutFrame(opts: {
  title?: string | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  yTickWidth: number;
  legendNames: { name: string; colorIndex: number }[];
  size?: ChartSize | undefined;
}): Frame {
  const width = opts.size?.width ?? CANVAS_W;
  const height = opts.size?.height ?? CANVAS_H;
  const hasLegend = opts.legendNames.length > 0;
  // A legend in the 120px right margin works at the standard 640px canvas
  // width; below LEGEND_NARROW it would take a third of the plot, so it
  // drops under the x-axis instead -- see this module's header.
  const legendOnRight = hasLegend && width >= LEGEND_NARROW;
  const legendBelow = hasLegend && !legendOnRight;

  const left = MARGIN + opts.yTickWidth + (opts.yLabel ? AXIS_TITLE_GAP : 0) + 8;
  const top = MARGIN + (opts.title ? TITLE_GAP : 0);
  const right = MARGIN + (legendOnRight ? 120 : 0);
  const plotX = left;
  const plotW = width - left - right;

  // Row-wrapping only needs plotW, which nothing below depends on -- so the
  // row count is known before `bottom`, which needs it, is computed.
  const legendRows = legendBelow ? packLegend(opts.legendNames, plotW) : [];

  const bottom = MARGIN + TICK_LABEL_GAP + (opts.xLabel ? AXIS_TITLE_GAP : 0) + legendRows.length * LEGEND_ROW;
  const plotY = top;
  const plotH = height - top - bottom;
  const plot = { x: plotX, y: plotY, w: plotW, h: plotH };

  let legend: PlacedLegendEntry[] = [];
  if (legendOnRight) {
    const lx = plot.x + plot.w + 14;
    legend = opts.legendNames.map((entry, i) => ({ ...entry, x: lx, y: plot.y + 8 + i * 18 }));
  } else if (legendBelow) {
    const baseY = plot.y + plot.h + TICK_LABEL_GAP + (opts.xLabel ? AXIS_TITLE_GAP : 0) + LEGEND_ROW * 0.7;
    legend = legendRows.flatMap((row, r) => {
      let x = plot.x;
      return row.map((entry) => {
        const placed = { ...entry, x, y: baseY + r * LEGEND_ROW };
        x += legendItemWidth(entry.name);
        return placed;
      });
    });
  }

  return { plot, width, height, legend };
}

/**
 * Turns the raw space a panel measured for its chart into a size
 * `layoutChart` will draw at -- floored so text never collapses below
 * readable, and height-capped relative to width so a tall narrow panel gets
 * a chart bounded at 4:5 rather than a sliver stretched down the column.
 */
export function chartSizeFor(avail: { width: number; height: number }): ChartSize {
  const width = Math.max(MIN_CHART_W, Math.round(avail.width));
  const height = Math.max(MIN_CHART_H, Math.min(Math.round(avail.height), Math.round(width * MAX_H_RATIO)));
  return { width, height };
}

const CATEGORY_GAP = 0.3; // fraction of a category's slot left as whitespace between categories

/** Placed at the SAME positions the legend already assigns -- see svg.ts's
 *  `PALETTE`, kept in one place so a series is always the same colour in the
 *  legend, the marks and the export. */
function seriesNames(data: ChartData): string[] {
  if (data.kind === "scatter" || data.kind === "line" || data.kind === "bar") {
    return data.series.map((s) => s.name);
  }
  return [];
}

export function layoutChart(data: ChartData, opts: {
  title?: string | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  /** The figure's own drawn size -- omitted for the fixed 640x420 canvas
   *  every existing caller and test still gets by default. */
  size?: ChartSize | undefined;
} = {}): ChartLayout {
  const names = seriesNames(data);
  const legend = names.length > 1 ? names.map((name, i) => ({ name, colorIndex: i })) : [];

  if (data.kind === "scatter" || data.kind === "line") {
    const allX = data.series.flatMap((s) => s.points.map((p) => p.x));
    const allY = data.series.flatMap((s) =>
      s.points.flatMap((p) => [p.y - (p.error ?? 0), p.y + (p.error ?? 0)]),
    );
    const xScale = niceScale(Math.min(...allX), Math.max(...allX));
    const yScale = niceScale(Math.min(...allY), Math.max(...allY));
    const frame = layoutFrame({
      ...opts, yTickWidth: yTickLabelWidth(yScale), legendNames: legend,
    });

    const series: PlottedSeries[] = data.series.map((s, i) => ({
      name: s.name,
      colorIndex: i,
      points: s.points.map((p) => ({
        x: deviceX(p.x, xScale, frame.plot),
        y: deviceY(p.y, yScale, frame.plot),
        ...(p.error !== undefined
          ? {
              errorTop: deviceY(p.y + p.error, yScale, frame.plot),
              errorBottom: deviceY(p.y - p.error, yScale, frame.plot),
            }
          : {}),
      })),
    }));

    let fit: FitLine | undefined;
    if (data.kind === "scatter" && data.fit && Number.isFinite(data.fit.slope)) {
      const y1 = data.fit.slope * xScale.lo + data.fit.intercept;
      const y2 = data.fit.slope * xScale.hi + data.fit.intercept;
      fit = {
        x1: deviceX(xScale.lo, xScale, frame.plot), y1: deviceY(y1, yScale, frame.plot),
        x2: deviceX(xScale.hi, xScale, frame.plot), y2: deviceY(y2, yScale, frame.plot),
        label: `y = ${round2(data.fit.slope)}x + ${round2(data.fit.intercept)} (R² = ${round2(data.fit.r2)})`,
      };
    }

    return {
      kind: data.kind, width: frame.width, height: frame.height, plot: frame.plot,
      xTicks: xScale.ticks.map((v) => ({ pos: deviceX(v, xScale, frame.plot), label: tickLabel(v) })),
      yTicks: yScale.ticks.map((v) => ({ pos: deviceY(v, yScale, frame.plot), label: tickLabel(v) })),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.xLabel ? { xLabel: opts.xLabel } : {}),
      ...(opts.yLabel ? { yLabel: opts.yLabel } : {}),
      legend: frame.legend, series, ...(fit ? { fit } : {}),
    };
  }

  if (data.kind === "bar") {
    const stacked = data.stacked;
    const perCategoryTotals = data.categories.map((_c, cat) => {
      if (!stacked) return Math.max(0, ...data.series.map((s) => s.points[cat]?.y ?? 0));
      return data.series.reduce((sum, s) => sum + Math.max(0, s.points[cat]?.y ?? 0), 0);
    });
    const perCategoryMins = data.categories.map((_c, cat) => {
      if (!stacked) return Math.min(0, ...data.series.map((s) => s.points[cat]?.y ?? 0));
      return data.series.reduce((sum, s) => sum + Math.min(0, s.points[cat]?.y ?? 0), 0);
    });
    const errorExtent = data.series.flatMap((s) =>
      s.points.flatMap((p) => (p.error !== undefined ? [p.y + p.error, p.y - p.error] : [])),
    );
    const yScale = niceScale(
      Math.min(0, ...perCategoryMins, ...errorExtent),
      Math.max(0, ...perCategoryTotals, ...errorExtent),
    );
    const frame = layoutFrame({ ...opts, yTickWidth: yTickLabelWidth(yScale), legendNames: legend });

    const n = data.categories.length;
    const slotW = frame.plot.w / Math.max(1, n);
    const groupW = slotW * (1 - CATEGORY_GAP);
    const barW = stacked ? groupW : groupW / Math.max(1, data.series.length);
    const zeroY = deviceY(0, yScale, frame.plot);

    const bars: PlottedBar[] = [];
    for (let cat = 0; cat < n; cat++) {
      const slotStart = frame.plot.x + cat * slotW + (slotW - groupW) / 2;
      let stackPos = 0; // running total, stacked mode only
      let stackNeg = 0;
      data.series.forEach((s, si) => {
        const point = s.points[cat];
        if (!point) return;
        const x = stacked ? slotStart : slotStart + si * barW;
        const base = stacked ? (point.y >= 0 ? stackPos : stackNeg) : 0;
        const top = base + point.y;
        if (stacked) { if (point.y >= 0) stackPos = top; else stackNeg = top; }
        const yA = deviceY(base, yScale, frame.plot);
        const yB = deviceY(top, yScale, frame.plot);
        bars.push({
          seriesIndex: si, colorIndex: si, category: cat, x, w: barW,
          yTop: Math.min(yA, yB), yBottom: Math.max(yA, yB),
          /* Centred on `top`, the segment's own cumulative position, not the
             raw `point.y` -- equal for an unstacked bar (base is always 0
             there) but not for a stacked one, where every series after the
             first sits on top of the ones below it and an error bar drawn
             around the raw value floats inside whatever segment happens to
             occupy that range instead of straddling its own bar. */
          ...(point.error !== undefined
            ? {
                errorTop: deviceY(top + point.error, yScale, frame.plot),
                errorBottom: deviceY(top - point.error, yScale, frame.plot),
              }
            : {}),
        });
      });
    }

    return {
      kind: "bar", width: frame.width, height: frame.height, plot: frame.plot,
      yTicks: yScale.ticks.map((v) => ({ pos: deviceY(v, yScale, frame.plot), label: tickLabel(v) })),
      categoryTicks: data.categories.map((label, i) => ({ pos: frame.plot.x + (i + 0.5) * slotW, label })),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.xLabel ? { xLabel: opts.xLabel } : {}),
      ...(opts.yLabel ? { yLabel: opts.yLabel } : {}),
      legend: frame.legend, bars,
    };
  }

  if (data.kind === "box") {
    const built = data.groups.map((g) => boxOf(g));
    const allY = built.flatMap((b) => [b.whiskerLo, b.whiskerHi, ...b.outliers]);
    const yScale = niceScale(Math.min(...allY), Math.max(...allY));
    const frame = layoutFrame({ ...opts, yTickWidth: yTickLabelWidth(yScale), legendNames: [] });

    const n = data.groups.length;
    const slotW = frame.plot.w / Math.max(1, n);
    const boxW = slotW * (1 - CATEGORY_GAP);

    const boxes: PlottedBox[] = built.map((b, i) => ({
      label: b.label,
      x: frame.plot.x + (i + 0.5) * slotW,
      w: boxW,
      q1: deviceY(b.q1, yScale, frame.plot),
      median: deviceY(b.median, yScale, frame.plot),
      q3: deviceY(b.q3, yScale, frame.plot),
      whiskerLo: deviceY(b.whiskerLo, yScale, frame.plot),
      whiskerHi: deviceY(b.whiskerHi, yScale, frame.plot),
      outliers: b.outliers.map((v) => deviceY(v, yScale, frame.plot)),
      method: b.method,
    }));

    return {
      kind: "box", width: frame.width, height: frame.height, plot: frame.plot,
      yTicks: yScale.ticks.map((v) => ({ pos: deviceY(v, yScale, frame.plot), label: tickLabel(v) })),
      categoryTicks: data.groups.map((g, i) => ({ pos: frame.plot.x + (i + 0.5) * slotW, label: g.label })),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.xLabel ? { xLabel: opts.xLabel } : {}),
      ...(opts.yLabel ? { yLabel: opts.yLabel } : {}),
      legend: [], boxes,
    };
  }

  // histogram
  const bins = histBins(data.values);
  const yScale = niceScale(0, Math.max(1, ...bins.map((b) => b.count)));
  const frame = layoutFrame({ ...opts, yTickWidth: yTickLabelWidth(yScale), legendNames: [] });
  const xMin = bins[0]!.lo;
  const xMax = bins[bins.length - 1]!.hi;
  const xOf = (v: number): number => frame.plot.x + ((v - xMin) / (xMax - xMin || 1)) * frame.plot.w;

  const histogram: HistBar[] = bins.map((b) => ({
    x0: xOf(b.lo), x1: xOf(b.hi),
    yTop: deviceY(b.count, yScale, frame.plot), yBottom: deviceY(0, yScale, frame.plot),
    count: b.count, rangeLabel: `${tickLabel(b.lo)}–${tickLabel(b.hi)}`,
  }));

  return {
    kind: "histogram", width: frame.width, height: frame.height, plot: frame.plot,
    yTicks: yScale.ticks.map((v) => ({ pos: deviceY(v, yScale, frame.plot), label: tickLabel(v) })),
    categoryTicks: bins.map((b) => ({ pos: xOf((b.lo + b.hi) / 2), label: tickLabel((b.lo + b.hi) / 2) })),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.xLabel ? { xLabel: opts.xLabel } : {}),
    ...(opts.yLabel ? { yLabel: opts.yLabel } : {}),
    legend: [], histogram,
  };
}

/** Quartiles from `core/tabular/stats.ts` -- the same function a caption's
 *  "computed by" note would name, so a box plot's method is never a second,
 *  silently different implementation of the same idea -- plus the standard
 *  1.5x-IQR whisker rule, stated in `method` so a reader is never left
 *  assuming a convention this module did not name. */
function boxOf(group: BoxGroupData): {
  label: string; q1: number; median: number; q3: number; whiskerLo: number; whiskerHi: number;
  outliers: number[]; method: string;
} {
  const sorted = [...group.values].sort((a, b) => a - b);
  const q = quartiles(sorted);
  if (!Number.isFinite(q.q1)) {
    // Fewer than three points: stats.ts's own floor for a meaningful spread.
    // Collapsed to the midpoint rather than propagating NaN into the figure.
    const v = sorted.length ? (sorted[0]! + sorted[sorted.length - 1]!) / 2 : 0;
    return {
      label: group.label, q1: v, median: v, q3: v,
      whiskerLo: sorted[0] ?? v, whiskerHi: sorted[sorted.length - 1] ?? v,
      outliers: [], method: "fewer than three points: not enough for quartiles, box collapsed to the midpoint",
    };
  }
  const iqr = q.q3 - q.q1;
  const loFence = q.q1 - 1.5 * iqr;
  const hiFence = q.q3 + 1.5 * iqr;
  const inFence = sorted.filter((v) => v >= loFence && v <= hiFence);
  const outliers = sorted.filter((v) => v < loFence || v > hiFence);
  return {
    label: group.label,
    q1: q.q1, median: q.median, q3: q.q3,
    whiskerLo: inFence.length ? inFence[0]! : q.q1,
    whiskerHi: inFence.length ? inFence[inFence.length - 1]! : q.q3,
    outliers,
    method: `${q.method}; whiskers to the most extreme point within 1.5× the interquartile range`,
  };
}

/** Sturges' rule: k = ceil(log2(n) + 1). Simple, standard, and stated so a
 *  reader can check it -- an unlabelled bin count is a hidden parameter. */
function binCount(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, n)) + 1));
}

/** Exported so pgfplots.ts's histogram export bins the same way this file's
 *  own on-screen layout does, by construction rather than by two copies of
 *  Sturges' rule kept identical by hand. */
export function histBins(values: readonly number[]): { lo: number; hi: number; count: number }[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const k = binCount(values.length);
  const width = (max - min || 1) / k;
  const bins = Array.from({ length: k }, (_v, i) => ({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = v >= max ? k - 1 : Math.floor((v - min) / width);
    bins[Math.min(k - 1, Math.max(0, i))]!.count++;
  }
  return bins;
}

function round2(v: number): string {
  return Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : "–";
}

/** A tick's own printed label -- rounded for display only, never fed back
 *  into anything computed from the underlying value. */
function tickLabel(v: number): string {
  const s = Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);
  return s;
}

export { textWidth };
