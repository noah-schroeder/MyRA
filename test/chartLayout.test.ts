/**
 * Placing a chart's marks. As with diagramLayout.test.ts, the assertions are
 * about relationships -- coordinates derived from the actual data, marks
 * inside the reported canvas, a zero baseline for bars -- rather than exact
 * pixel positions, which would pin the constants rather than the behaviour.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CANVAS_H, CANVAS_W, chartSizeFor, layoutChart, type ChartData } from "../src/core/charts/layout.ts";

function within(v: number, lo: number, hi: number, msg: string): void {
  assert.ok(v >= lo - 1e-6 && v <= hi + 1e-6, `${msg}: ${v} not within [${lo}, ${hi}]`);
}

test("scatter: every point sits inside the plot area", () => {
  const data: ChartData = { kind: "scatter", series: [{ name: "s", points: [{ x: 1, y: 2 }, { x: 5, y: 9 }, { x: 3, y: -4 }] }] };
  const layout = layoutChart(data);
  for (const p of layout.series![0]!.points) {
    within(p.x, layout.plot.x, layout.plot.x + layout.plot.w, "x");
    within(p.y, layout.plot.y, layout.plot.y + layout.plot.h, "y");
  }
});

test("scatter: a larger x value is always further right, a larger y value always higher on screen", () => {
  const data: ChartData = { kind: "scatter", series: [{ name: "s", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }] };
  const points = layoutChart(data).series![0]!.points;
  assert.ok(points[0]!.x < points[1]!.x && points[1]!.x < points[2]!.x);
  // SVG y grows downward, so a larger data-y is a SMALLER device-y.
  assert.ok(points[0]!.y > points[1]!.y && points[1]!.y > points[2]!.y);
});

test("scatter: an error bar is centred on its own point", () => {
  const data: ChartData = { kind: "scatter", series: [{ name: "s", points: [{ x: 1, y: 5, error: 2 }] }] };
  const p = layoutChart(data).series![0]!.points[0]!;
  const mid = (p.errorTop! + p.errorBottom!) / 2;
  assert.ok(Math.abs(mid - p.y) < 1e-6);
  assert.ok(p.errorTop! < p.y && p.errorBottom! > p.y, "top is smaller device-y (higher on screen) than the point");
});

test("scatter: a fit line's two ends span the full plotted x range", () => {
  const data: ChartData = {
    kind: "scatter",
    series: [{ name: "s", points: [{ x: 0, y: 0 }, { x: 10, y: 20 }] }],
    fit: { slope: 2, intercept: 0, r2: 1 },
  };
  const layout = layoutChart(data);
  assert.ok(layout.fit);
  assert.ok(Math.abs(layout.fit!.x1 - layout.plot.x) < 1e-6);
  assert.ok(Math.abs(layout.fit!.x2 - (layout.plot.x + layout.plot.w)) < 1e-6);
});

test("scatter: no fit line at all when the slope is not finite", () => {
  const data: ChartData = {
    kind: "scatter",
    series: [{ name: "s", points: [{ x: 1, y: 1 }] }],
    fit: { slope: NaN, intercept: NaN, r2: NaN },
  };
  assert.equal(layoutChart(data).fit, undefined);
});

test("line: two series get two different colour indices", () => {
  const data: ChartData = {
    kind: "line",
    series: [{ name: "A", points: [{ x: 0, y: 1 }] }, { name: "B", points: [{ x: 0, y: 2 }] }],
  };
  const layout = layoutChart(data);
  assert.equal(layout.series![0]!.colorIndex, 0);
  assert.equal(layout.series![1]!.colorIndex, 1);
  assert.deepEqual(layout.legend.map((l) => l.name), ["A", "B"]);
});

test("line: a single series draws no legend, since there is nothing to disambiguate", () => {
  const data: ChartData = { kind: "line", series: [{ name: "A", points: [{ x: 0, y: 1 }] }] };
  assert.equal(layoutChart(data).legend.length, 0);
});

test("bar: baselines sit at the zero line, whatever the values", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A", "B"],
    series: [{ name: "s", points: [{ x: 0, y: 10 }, { x: 1, y: 4 }] }],
  };
  const layout = layoutChart(data);
  // Both bars share the same yBottom (the zero line) since neither value is negative.
  assert.equal(layout.bars![0]!.yBottom, layout.bars![1]!.yBottom);
});

test("bar: a negative value draws its bar the other way from zero, not below the axis floor", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A", "B"],
    series: [{ name: "s", points: [{ x: 0, y: 10 }, { x: 1, y: -5 }] }],
  };
  const bars = layoutChart(data).bars!;
  const zero = bars[0]!.yBottom; // the positive bar's baseline is the zero line
  assert.ok(bars[1]!.yTop === zero, "a negative bar starts AT zero and extends downward on screen");
});

test("bar: grouped series for one category never overlap", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A"],
    series: [
      { name: "s1", points: [{ x: 0, y: 5 }] },
      { name: "s2", points: [{ x: 0, y: 5 }] },
    ],
  };
  const [b1, b2] = layoutChart(data).bars!;
  assert.ok(b1!.x + b1!.w <= b2!.x + 1e-6, "grouped bars sit side by side");
});

test("bar: stacked series for one category sit on top of each other, not side by side", () => {
  const data: ChartData = {
    kind: "bar", stacked: true, categories: ["A"],
    series: [
      { name: "s1", points: [{ x: 0, y: 5 }] },
      { name: "s2", points: [{ x: 0, y: 5 }] },
    ],
  };
  const [b1, b2] = layoutChart(data).bars!;
  assert.equal(b1!.x, b2!.x);
  assert.equal(b1!.w, b2!.w);
  // The second segment's top touches the first segment's bottom (continuing the stack).
  assert.ok(Math.abs(b1!.yTop - b2!.yBottom) < 1e-6);
});

test("bar: a stacked series' error bar centres on its own segment, not on the raw value", () => {
  // Without this, a stacked series' error bar was computed from its raw y
  // value rather than the cumulative height it actually draws at, so every
  // series after the bottom one got an error bar floating inside a
  // different segment entirely.
  const data: ChartData = {
    kind: "bar", stacked: true, categories: ["A"],
    series: [
      { name: "base", points: [{ x: 0, y: 5 }] },
      { name: "top", points: [{ x: 0, y: 3, error: 1 }] },
    ],
  };
  const [, top] = layoutChart(data).bars!;
  // The "top" segment visually spans data-values [5, 8], so its error bar
  // (data-values [7, 9]) must sit at or above the segment's own top edge --
  // never inside the "base" segment underneath it.
  assert.ok(top!.errorTop! <= top!.yTop + 1e-6, "the error bar's top must not sit below the segment's own top");
  assert.ok(top!.errorBottom! <= top!.yBottom + 1e-6, "the error bar's bottom must not dip below the segment's own bottom");
});

test("box: quartiles are ordered q1 below median below q3 in DATA terms (so device-y is reversed)", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] };
  const box = layoutChart(data).boxes![0]!;
  // Device-y: q3 (higher data value) draws above (smaller y) q1.
  assert.ok(box.q3 < box.median && box.median < box.q1);
});

test("box: the whiskers never extend past the drawn box on the wrong side", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3, 4, 5, 6, 7, 8, 100] }] };
  const box = layoutChart(data).boxes![0]!;
  assert.ok(box.whiskerHi <= box.q3 + 1e-6, "the high whisker is above (smaller device-y) q3");
  assert.ok(box.whiskerLo >= box.q1 - 1e-6, "the low whisker is below (larger device-y) q1");
});

test("box: an extreme value beyond the fence is drawn as an outlier, not silently absorbed", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2, 3, 4, 5, 100] }] };
  const box = layoutChart(data).boxes![0]!;
  assert.equal(box.outliers.length, 1);
});

test("box: fewer than three points still draws something rather than NaN", () => {
  const data: ChartData = { kind: "box", groups: [{ label: "A", values: [1, 2] }] };
  const box = layoutChart(data).boxes![0]!;
  assert.ok(Number.isFinite(box.q1) && Number.isFinite(box.median) && Number.isFinite(box.q3));
});

test("histogram: bin counts sum to the number of values", () => {
  const values = [1, 2, 2, 3, 3, 3, 4, 5, 5, 20];
  const layout = layoutChart({ kind: "histogram", values });
  const total = layout.histogram!.reduce((s, b) => s + b.count, 0);
  assert.equal(total, values.length);
});

test("histogram: bins are contiguous and cover the full data range", () => {
  const values = [1, 2, 2, 3, 3, 3, 4, 5, 5, 20];
  const layout = layoutChart({ kind: "histogram", values });
  const bars = layout.histogram!;
  for (let i = 1; i < bars.length; i++) {
    assert.ok(Math.abs(bars[i]!.x0 - bars[i - 1]!.x1) < 1e-6, "adjacent bins must touch");
  }
});

test("histogram: bin count follows Sturges' rule", () => {
  const values = Array.from({ length: 10 }, (_v, i) => i);
  const layout = layoutChart({ kind: "histogram", values });
  const expected = Math.ceil(Math.log2(10) + 1);
  assert.equal(layout.histogram!.length, expected);
});

test("every mark sits inside the reported width and height", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ["A", "B", "C"],
    series: [{ name: "s", points: [{ x: 0, y: 5, error: 1 }, { x: 1, y: -3 }, { x: 2, y: 9 }] }],
  };
  const layout = layoutChart(data);
  for (const bar of layout.bars!) {
    assert.ok(bar.x >= 0 && bar.x + bar.w <= layout.width + 1e-6);
    assert.ok(Math.min(bar.yTop, bar.yBottom) >= 0 && Math.max(bar.yTop, bar.yBottom) <= layout.height + 1e-6);
  }
});

/**
 * A chart's own size -- the artifact panel's "redraw to fit" behaviour, added
 * beside the fixed 640x420 canvas every test above still exercises by
 * leaving `size` out entirely.
 */

test("with no size given, the canvas is exactly the fixed 640x420 it always was", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] };
  const layout = layoutChart(data);
  assert.equal(layout.width, CANVAS_W);
  assert.equal(layout.height, CANVAS_H);
  assert.equal(CANVAS_W, 640);
  assert.equal(CANVAS_H, 420);
});

test("a given size is honoured exactly", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] };
  const layout = layoutChart(data, { size: { width: 900, height: 500 } });
  assert.equal(layout.width, 900);
  assert.equal(layout.height, 500);
});

for (const size of [
  { width: 320, height: 240 },
  { width: 640, height: 420 },
  { width: 624, height: 864 }, // a portrait Letter page
  { width: 864, height: 624 }, // a landscape Letter page
]) {
  test(`every mark sits inside a ${size.width}x${size.height} chart`, () => {
    const data: ChartData = {
      kind: "bar", stacked: false, categories: ["A", "B", "C", "D"],
      series: [
        { name: "First", points: [{ x: 0, y: 5, error: 1 }, { x: 1, y: -3 }, { x: 2, y: 9 }, { x: 3, y: 2 }] },
        { name: "Second", points: [{ x: 0, y: 4 }, { x: 1, y: 1 }, { x: 2, y: 6 }, { x: 3, y: -1 }] },
      ],
    };
    const layout = layoutChart(data, { size, title: "A title", xLabel: "X", yLabel: "Y" });
    assert.equal(layout.width, size.width);
    assert.equal(layout.height, size.height);
    for (const bar of layout.bars!) {
      assert.ok(bar.x >= 0 && bar.x + bar.w <= layout.width + 1e-6);
      assert.ok(Math.min(bar.yTop, bar.yBottom) >= 0 && Math.max(bar.yTop, bar.yBottom) <= layout.height + 1e-6);
    }
  });
}

test("a narrow multi-series chart puts its legend below the plot, inside the reported height", () => {
  const data: ChartData = {
    kind: "line",
    series: [
      { name: "Alpha", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      { name: "Beta", points: [{ x: 0, y: 3 }, { x: 1, y: 1 }] },
      { name: "Gamma", points: [{ x: 0, y: 2 }, { x: 1, y: 4 }] },
    ],
  };
  const layout = layoutChart(data, { size: { width: 350, height: 300 } });
  assert.equal(layout.legend.length, 3);
  for (const entry of layout.legend) {
    // Below the plot, not off to its right.
    assert.ok(entry.y > layout.plot.y + layout.plot.h);
    assert.ok(entry.y <= layout.height + 1e-6);
    assert.ok(entry.x >= layout.plot.x - 1e-6);
  }
});

test("a wide multi-series chart keeps its legend in the right margin, as before", () => {
  const data: ChartData = {
    kind: "line",
    series: [
      { name: "Alpha", points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      { name: "Beta", points: [{ x: 0, y: 3 }, { x: 1, y: 1 }] },
    ],
  };
  const layout = layoutChart(data, { size: { width: 640, height: 420 } });
  for (const entry of layout.legend) {
    assert.ok(entry.x > layout.plot.x + layout.plot.w);
  }
});

test("chartSizeFor floors both dimensions so a tiny panel never collapses the text", () => {
  const size = chartSizeFor({ width: 10, height: 10 });
  assert.ok(size.width >= 300);
  assert.ok(size.height >= 200);
});

test("chartSizeFor caps height relative to width, so a tall narrow panel gets no sliver", () => {
  const size = chartSizeFor({ width: 320, height: 2000 });
  assert.ok(size.height <= size.width * 0.8 + 1e-6);
});

test("chartSizeFor passes through a reasonable size unchanged, only rounded", () => {
  const size = chartSizeFor({ width: 500.4, height: 380.6 });
  assert.equal(size.width, 500);
  assert.equal(size.height, 381);
});
