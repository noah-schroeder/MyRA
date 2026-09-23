/**
 * A chart, as PGFPlots/TikZ source -- for a LaTeX user who wants the figure
 * to compile alongside the manuscript rather than be embedded as an image.
 *
 * Works from `ChartData`, the same pre-computed numbers `layoutChart` places
 * -- never from the device-space `ChartLayout`, since PGFPlots does its own
 * axis scaling. The one place this matters is the box plot: PGFPlots' own
 * `boxplot` library recomputes quartiles from raw data by its own
 * convention, which is not necessarily `core/tabular/stats.ts`'s exclusive
 * method -- two different "correct" quartiles for the same figure is exactly
 * the kind of drift this app does not allow. So a box is emitted with
 * `boxplot prepared`, which takes MyRA's own computed numbers verbatim; the
 * LaTeX figure and the on-screen one are guaranteed to agree because they
 * are built from the same arithmetic, not from two implementations of the
 * same idea.
 */

import { histBins, type ChartData } from "./layout.ts";
import { texEscape } from "../tabular/latex.ts";
import { quartiles } from "../tabular/stats.ts";

function fnum(v: number): string {
  return Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6).toString() : "0";
}

function axisOpts(opts: { title?: string | undefined; xLabel?: string | undefined; yLabel?: string | undefined }): string[] {
  const out: string[] = [];
  if (opts.title) out.push(`title={${texEscape(opts.title)}}`);
  if (opts.xLabel) out.push(`xlabel={${texEscape(opts.xLabel)}}`);
  if (opts.yLabel) out.push(`ylabel={${texEscape(opts.yLabel)}}`);
  return out;
}

/**
 * A `pgfkeys`-style comma list, each item brace-wrapped.
 *
 * `xticklabels={a,b,c}` parses as a plain comma-delimited list -- `texEscape`
 * closes off LaTeX's own metacharacters, but not the comma this list syntax
 * reads specially, so a category or group label containing a literal comma
 * ("Boston, MA") was read as two items, shifting every tick label after it.
 * Wrapping each one in its own `{}` is the standard pgfkeys escape for "this
 * one item may itself contain a comma".
 */
function bracedList(items: readonly string[]): string {
  return items.map((s) => `{${texEscape(s)}}`).join(",");
}

function wrap(axisBody: string[], opts: string[]): string {
  return [
    "% Requires \\usepackage{pgfplots} and \\pgfplotsset{compat=1.18}",
    "\\begin{tikzpicture}",
    `\\begin{axis}[${["width=10cm", "height=7cm", ...opts].join(", ")}]`,
    ...axisBody,
    "\\end{axis}",
    "\\end{tikzpicture}",
  ].join("\n");
}

function fenceOf(values: readonly number[]): { lo: number; hi: number; q: ReturnType<typeof quartiles>; outliers: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  const q = quartiles(sorted);
  if (!Number.isFinite(q.q1)) {
    const v = sorted.length ? (sorted[0]! + sorted[sorted.length - 1]!) / 2 : 0;
    return { lo: sorted[0] ?? v, hi: sorted[sorted.length - 1] ?? v, q: { ...q, q1: v, median: v, q3: v }, outliers: [] };
  }
  const iqr = q.q3 - q.q1;
  const loFence = q.q1 - 1.5 * iqr;
  const hiFence = q.q3 + 1.5 * iqr;
  const inFence = sorted.filter((v) => v >= loFence && v <= hiFence);
  return {
    lo: inFence.length ? inFence[0]! : q.q1,
    hi: inFence.length ? inFence[inFence.length - 1]! : q.q3,
    q,
    outliers: sorted.filter((v) => v < loFence || v > hiFence),
  };
}

export function pgfplotsOf(
  data: ChartData,
  opts: { title?: string | undefined; xLabel?: string | undefined; yLabel?: string | undefined } = {},
): string {
  if (data.kind === "scatter" || data.kind === "line") {
    /* A legend that appears at all -- not merely where it sits -- is decided
       here, and used both to gate `legend pos` below AND whether an
       `\addlegendentry` is emitted at all: PGFPlots shows a legend box
       automatically the moment any `\addlegendentry` exists, whatever
       `legend pos` says, so gating only the position left a legend showing
       for a single series with no fit, when the on-screen figure -- which
       only ever builds one for 2+ series -- shows none. */
    const showLegend = data.series.length > 1 || (data.kind === "scatter" && !!data.fit);
    const body = data.series.map((s) => {
      const hasError = s.points.some((p) => p.error !== undefined);
      const style = data.kind === "scatter" ? "only marks" : "mark=*";
      const errOpt = hasError ? ", error bars/.cd, y dir=both, y explicit" : "";
      const coords = s.points
        .map((p) => (p.error !== undefined ? `(${fnum(p.x)},${fnum(p.y)}) +- (0,${fnum(p.error)})` : `(${fnum(p.x)},${fnum(p.y)})`))
        .join(" ");
      const legend = showLegend ? `\n\\addlegendentry{${texEscape(s.name)}}` : "";
      return `\\addplot+[${style}${errOpt}] coordinates {${coords}};${legend}`;
    });
    if (data.kind === "scatter" && data.fit && Number.isFinite(data.fit.slope)) {
      const xs = data.series.flatMap((s) => s.points.map((p) => p.x));
      const x1 = Math.min(...xs);
      const x2 = Math.max(...xs);
      const y1 = data.fit.slope * x1 + data.fit.intercept;
      const y2 = data.fit.slope * x2 + data.fit.intercept;
      body.push(`\\addplot[dashed, thick, no markers] coordinates {(${fnum(x1)},${fnum(y1)}) (${fnum(x2)},${fnum(y2)})};`);
      if (showLegend) body.push(`\\addlegendentry{fit: $y=${fnum(data.fit.slope)}x+${fnum(data.fit.intercept)}$}`);
    }
    return wrap(body, [...axisOpts(opts), ...(showLegend ? ["legend pos=north west"] : [])]);
  }

  if (data.kind === "bar") {
    // Numeric positions (1..n) with `xticklabels`, not `symbolic x coords`:
    // a category name is arbitrary user text and can carry a `%`, `_` or `&`
    // that must go through texEscape -- exactly the hazard latex.ts exists
    // to close off, and `symbolic x coords` has no escaping convention at
    // all to carry it through safely.
    const showLegend = data.series.length > 1;
    const body = data.series.map((s) => {
      const hasError = s.points.some((p) => p.error !== undefined);
      const opt = hasError ? "[error bars/.cd, y dir=both, y explicit]" : "";
      const coords = data.categories
        .map((_c, i) => {
          const p = s.points[i];
          const y = p?.y ?? 0;
          return p?.error !== undefined ? `(${i + 1},${fnum(y)}) +- (0,${fnum(p.error)})` : `(${i + 1},${fnum(y)})`;
        })
        .join(" ");
      const legend = showLegend ? `\n\\addlegendentry{${texEscape(s.name)}}` : "";
      return `\\addplot${opt} coordinates {${coords}};${legend}`;
    });
    return wrap(body, [
      ...axisOpts(opts),
      data.stacked ? "ybar stacked" : "ybar",
      `xtick={${data.categories.map((_c, i) => i + 1).join(",")}}`,
      `xticklabels={${bracedList(data.categories)}}`,
      ...(showLegend ? ["legend pos=north west"] : []),
    ]);
  }

  if (data.kind === "box") {
    const body = data.groups.flatMap((g, i) => {
      const { q, lo, hi, outliers } = fenceOf(g.values);
      const prepared =
        `boxplot prepared={lower whisker=${fnum(lo)}, lower quartile=${fnum(q.q1)}, ` +
        `median=${fnum(q.median)}, upper quartile=${fnum(q.q3)}, upper whisker=${fnum(hi)}}`;
      const lines = [`\\addplot+[${prepared}] coordinates {};`];
      if (outliers.length) {
        lines.push(`\\addplot[only marks, mark=o] coordinates {${outliers.map((v) => `(${i + 1},${fnum(v)})`).join(" ")}};`);
      }
      return lines;
    });
    return wrap(body, [
      ...axisOpts(opts),
      "boxplot/draw direction=y",
      `xtick={${data.groups.map((_g, i) => i + 1).join(",")}}`,
      `xticklabels={${bracedList(data.groups.map((g) => g.label))}}`,
    ]);
  }

  // histogram -- histBins is layout.ts's own, so the two figures agree on
  // where the bin edges fall by construction, not by two copies of Sturges'
  // rule kept identical by hand.
  const bins = histBins(data.values);
  const labels = bins.map((b) => `${fnum(b.lo)}–${fnum(b.hi)}`);
  // Same numeric-position pattern as "bar" above, for the same reason.
  const coords = bins.map((b, i) => `(${i + 1},${b.count})`).join(" ");
  return wrap(
    [`\\addplot coordinates {${coords}};`],
    [
      ...axisOpts(opts), "ybar",
      `xtick={${bins.map((_c, i) => i + 1).join(",")}}`,
      `xticklabels={${bracedList(labels)}}`,
      "x tick label style={rotate=45,anchor=east}",
    ],
  );
}
