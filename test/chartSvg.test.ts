/**
 * A chart's own labels -- a title, a series name, a category -- are user
 * text or column headers, exactly as capable of carrying a stray `<` or `&`
 * as a diagram's node labels. `toChartSvg` builds the file by string
 * concatenation, where React would have escaped for free, so this is pinned
 * the same way diagramSvg.test.ts pins `xmlEscape`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { layoutChart, type ChartData } from "../src/core/charts/layout.ts";
import { toChartSvg } from "../src/core/charts/svg.ts";

test("a hostile title is escaped, never raw markup", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }] }] };
  const svg = toChartSvg(layoutChart(data, { title: "<script>alert(1)</script>" }));
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("a series name with an ampersand survives the legend escaped", () => {
  const data: ChartData = {
    kind: "line",
    series: [{ name: "A & B", points: [{ x: 0, y: 1 }] }, { name: "C", points: [{ x: 0, y: 2 }] }],
  };
  const svg = toChartSvg(layoutChart(data));
  assert.match(svg, /A &amp; B/);
  assert.doesNotMatch(svg, /A & B/);
});

test("a bar category with a quote is escaped in its tick label", () => {
  const data: ChartData = {
    kind: "bar", stacked: false, categories: ['"quoted"'],
    series: [{ name: "s", points: [{ x: 0, y: 5 }] }],
  };
  const svg = toChartSvg(layoutChart(data));
  assert.doesNotMatch(svg, />"quoted"</);
  assert.match(svg, /&quot;quoted&quot;/);
});

test("the file is well-formed: one root svg element, opening and closing", () => {
  const data: ChartData = { kind: "histogram", values: [1, 2, 3, 4, 5] };
  const svg = toChartSvg(layoutChart(data));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
});

test("export background is always the light paper theme, regardless of the app's own theme", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }] }] };
  const svg = toChartSvg(layoutChart(data));
  assert.match(svg, /fill="#ffffff"/);
});

test("a fit line's own label, built from computed numbers, is still escaped like any other text", () => {
  const data: ChartData = {
    kind: "scatter",
    series: [{ name: "s", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    fit: { slope: 1, intercept: 0, r2: 1 },
  };
  const svg = toChartSvg(layoutChart(data));
  assert.match(svg, /R²/);
});

test("with no physical size, the output is exactly what it always was: pixels twice over", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }] }] };
  const layout = layoutChart(data);
  const svg = toChartSvg(layout);
  assert.match(svg, new RegExp(`width="${layout.width}" height="${layout.height}"`));
  assert.match(svg, new RegExp(`viewBox="0 0 ${layout.width} ${layout.height}"`));
});

test("a physical size is written in inches on the outer element, while the viewBox stays in pixels", () => {
  const data: ChartData = { kind: "line", series: [{ name: "s", points: [{ x: 0, y: 1 }] }] };
  const layout = layoutChart(data, { size: { width: 864, height: 624 } });
  const svg = toChartSvg(layout, undefined, { widthIn: 9, heightIn: 6.5 });
  assert.match(svg, /width="9in" height="6\.5in"/);
  assert.match(svg, /viewBox="0 0 864 624"/);
});
