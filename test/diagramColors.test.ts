/**
 * Colours a model writes into a diagram, read strictly -- every one of them
 * lands in an SVG attribute, and the source is model output.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { contrastRatio, mergePaint, parseColor, parsePaint, readableTextOn } from "../src/core/diagrams/colors.ts";

test("hex, rgb() and CSS names all normalise to #rrggbb", () => {
  assert.equal(parseColor("#F9F"), "#ff99ff");
  assert.equal(parseColor("#1f5fa8"), "#1f5fa8");
  assert.equal(parseColor("#1f5fa880"), "#1f5fa8", "alpha is accepted and dropped");
  assert.equal(parseColor("rgb(74, 144, 217)"), "#4a90d9");
  assert.equal(parseColor("rgba(74,144,217,0.5)"), "#4a90d9");
  assert.equal(parseColor("LightBlue"), "#add8e6");
  assert.equal(parseColor("rebeccapurple"), "#663399");
});

test("anything that is not plainly a colour is refused", () => {
  for (const bad of ["", "blurple", "#12", "#12345", "rgb(300,0,0)", "url(#grad)", "var(--x)",
    "red; stroke: blue", 'red" onload="x', "linear-gradient(red, blue)", "transparent"]) {
    assert.equal(parseColor(bad), undefined, bad);
  }
});

test("text on a fill is whichever of near-black or white reads better", () => {
  assert.equal(readableTextOn("#000080"), "#ffffff");
  assert.equal(readableTextOn("#ffff00"), "#14161a");
  assert.ok(contrastRatio("#000000", "#ffffff") > 20);
  assert.equal(Math.round(contrastRatio("#777777", "#777777")), 1);
});

test("parsePaint reads the properties it draws, clamps a width, and names a bad colour", () => {
  const { paint, bad } = parsePaint("fill:#f96, stroke:#333 ,stroke-width:40px,color:white,stroke-dasharray: 5 5,font-size:20px,fill-opacity:0.5");
  assert.deepEqual(paint, { fill: "#ff9966", stroke: "#333333", strokeWidth: 6, text: "#ffffff" });
  assert.deepEqual(bad, []);
  assert.deepEqual(parsePaint("fill:blurple").bad, ["blurple"]);
});

test("mergePaint layers field by field, and nothing to merge is nothing", () => {
  assert.deepEqual(mergePaint({ fill: "#111111", stroke: "#222222" }, undefined, { fill: "#333333" }), {
    fill: "#333333", stroke: "#222222",
  });
  assert.equal(mergePaint(undefined, {}), undefined);
});
