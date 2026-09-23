/**
 * PGFPlots/TikZ export. Two things matter here that do not for the SVG path:
 *
 *   `symbolic x coords` has no escaping convention, so a bar or histogram's
 *   category labels are placed by NUMERIC position with a separately
 *   `texEscape`d `xticklabels` -- not as symbolic coordinates. A category
 *   like "50% Response" would otherwise inject a raw `%` into the .tex
 *   source, silently commenting out the rest of its line when compiled --
 *   caught by hand while building this file, which is why it is pinned here.
 *
 *   A box plot's quartiles come from `boxplot prepared`, fed the exact same
 *   numbers `core/tabular/stats.ts` computed for the on-screen figure --
 *   never PGFPlots' own `boxplot` library recomputing quartiles by a
 *   possibly different convention.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { pgfplotsOf } from "../src/core/charts/pgfplots.ts";
import { histBins, layoutChart, type ChartData } from "../src/core/charts/layout.ts";

test("a bar category with LaTeX-special characters is escaped, never left raw", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["50% Control", "A & B", "x_1"],
    series: [
      { name: "Trial_1", points: [{ x: 0, y: 5 }, { x: 1, y: 8 }, { x: 2, y: 3 }] },
      { name: "Trial_2", points: [{ x: 0, y: 4 }, { x: 1, y: 6 }, { x: 2, y: 2 }] },
    ],
  };
  const tex = pgfplotsOf(data);
  assert.doesNotMatch(tex, /[^\\]%(?!\s*$)/m, "a raw % would comment out the rest of its line");
  assert.match(tex, /50\\% Control/);
  assert.match(tex, /A \\& B/);
  assert.match(tex, /x\\_1/);
  assert.match(tex, /Trial\\_1/);
});

test("bar categories are placed by numeric position, never as unescapable symbolic coordinates", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A", "B"],
    series: [{ name: "s", points: [{ x: 0, y: 5 }, { x: 1, y: 8 }] }],
  };
  const tex = pgfplotsOf(data);
  assert.doesNotMatch(tex, /symbolic x coords/);
  assert.match(tex, /\(1,5\)/);
  assert.match(tex, /\(2,8\)/);
  assert.match(tex, /xticklabels=\{\{A\},\{B\}\}/);
});

test("a category containing a literal comma does not shift the tick labels after it", () => {
  // xticklabels is pgfkeys' own comma-delimited list syntax; texEscape does
  // not touch a comma, so an item containing one had to be brace-wrapped
  // individually or it read as two items, misaligning every label after it.
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["Boston, MA", "Denver, CO", "Austin, TX"],
    series: [{ name: "s", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] }],
  };
  const tex = pgfplotsOf(data);
  assert.match(tex, /xtick=\{1,2,3\}/);
  assert.match(tex, /xticklabels=\{\{Boston, MA\},\{Denver, CO\},\{Austin, TX\}\}/);
});

test("a histogram's bin labels are escaped and placed by numeric position too", () => {
  const data: ChartData = { kind: "histogram", values: [1, 2, 2, 3, 3, 3, 4, 5, 5, 20] };
  const tex = pgfplotsOf(data);
  assert.doesNotMatch(tex, /symbolic x coords/);
  assert.match(tex, /xtick=\{1,2,3,4,5\}/);
});

test("a histogram's exported bin edges are layout.ts's own, not a second copy of Sturges' rule", () => {
  const values = [1, 2, 2, 3, 3, 3, 4, 5, 5, 20];
  const data: ChartData = { kind: "histogram", values };
  const onScreen = layoutChart(data).histogram!;
  const bins = histBins(values);
  assert.equal(onScreen.length, bins.length);
  const tex = pgfplotsOf(data);
  for (const b of bins) {
    const lo = Math.round(b.lo * 1e6) / 1e6;
    const hi = Math.round(b.hi * 1e6) / 1e6;
    assert.ok(tex.includes(`${lo}–${hi}`), `expected the exported labels to include ${lo}–${hi}, got: ${tex}`);
  }
});

test("a box plot's quartiles match core/tabular/stats.ts's own numbers exactly", () => {
  // n=9, exclusive/Tukey-hinges method: the middle element (index 4, value 5)
  // is excluded from both halves, leaving [1,2,3,4] and [6,7,8,9] -- each an
  // even count, so each quartile is itself the average of two values.
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] };
  const tex = pgfplotsOf(data);
  assert.match(tex, /lower quartile=2\.5/);
  assert.match(tex, /median=5/);
  assert.match(tex, /upper quartile=7\.5/);
  assert.match(tex, /boxplot prepared/);
});

test("a box plot's outlier is drawn as its own point, never absorbed into the whisker", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3, 4, 5, 100] }] };
  const tex = pgfplotsOf(data);
  assert.match(tex, /\(1,100\)/);
});

test("a series name and axis labels are escaped in the legend and axis options", () => {
  // Two series, so a legend is actually shown -- the escaping is what this
  // test is about, not whether one appears at all (see the no-legend test
  // below for that).
  const data: ChartData = {
    kind: "line",
    series: [
      { name: "50% Yield", points: [{ x: 0, y: 1 }] },
      { name: "Control", points: [{ x: 0, y: 2 }] },
    ],
  };
  const tex = pgfplotsOf(data, { title: "A & B", xLabel: "x_1", yLabel: "y%" });
  assert.match(tex, /title=\{A \\& B\}/);
  assert.match(tex, /xlabel=\{x\\_1\}/);
  assert.match(tex, /ylabel=\{y\\%\}/);
  assert.match(tex, /addlegendentry\{50\\% Yield\}/);
});

test("a single series with no fit line gets no legend at all, matching the on-screen figure", () => {
  // PGFPlots shows a legend box automatically the moment any
  // \addlegendentry exists, whatever `legend pos` says -- so this has to be
  // gated on whether one is emitted, not only on where it would sit.
  const data: ChartData = { kind: "line", series: [{ name: "Temperature", points: [{ x: 0, y: 1 }] }] };
  const tex = pgfplotsOf(data);
  assert.doesNotMatch(tex, /addlegendentry/);
  assert.doesNotMatch(tex, /legend pos/);
});

test("required packages are named in a leading comment", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3] }] };
  const tex = pgfplotsOf(data);
  assert.match(tex, /Requires \\usepackage\{pgfplots\}/);
});

test("a bar chart's error bars are exported too, not silently dropped", () => {
  // The bar branch never read .error at all: a bar chart built with an
  // errors column showed error bars on screen but exported none, an
  // on-screen/export divergence in a file whose whole point is that they
  // agree.
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A", "B"],
    series: [{ name: "s", points: [{ x: 0, y: 5, error: 0.5 }, { x: 1, y: 8 }] }],
  };
  const tex = pgfplotsOf(data);
  assert.match(tex, /error bars\/\.cd, y dir=both, y explicit/);
  assert.match(tex, /\(1,5\) \+- \(0,0\.5\)/);
  assert.match(tex, /\(2,8\)/);
});

test("scatter error bars use the explicit y-error convention, not a guessed one", () => {
  const data: ChartData = {
    kind: "scatter",
    series: [{ name: "s", points: [{ x: 1, y: 2, error: 0.5 }] }],
  };
  const tex = pgfplotsOf(data);
  assert.match(tex, /error bars\/\.cd, y dir=both, y explicit/);
  assert.match(tex, /\+- \(0,0\.5\)/);
});
