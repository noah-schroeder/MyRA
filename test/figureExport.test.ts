/**
 * The three export sizes a chart or diagram can be drawn at, and the page
 * geometry behind "portrait" and "landscape" -- see core/figures/exportSize.ts's
 * own header for why this module carries no imports.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  fitWithin, pageBox, paperForLocale, parseExportSize, PNG_SCALE_PAGE, PNG_SCALE_STANDARD,
} from "../src/core/figures/exportSize.ts";

test("paperForLocale: the letter countries get letter, everyone else gets A4", () => {
  assert.equal(paperForLocale("en-US"), "letter");
  assert.equal(paperForLocale("en-CA"), "letter");
  assert.equal(paperForLocale("es-MX"), "letter");
  assert.equal(paperForLocale("en-PH"), "letter");
  assert.equal(paperForLocale("en-GB"), "a4");
  assert.equal(paperForLocale("de-DE"), "a4");
  assert.equal(paperForLocale("fr-FR"), "a4");
});

test("paperForLocale: a bare language tag, or nothing at all, defaults to A4", () => {
  assert.equal(paperForLocale("en"), "a4");
  assert.equal(paperForLocale(undefined), "a4");
});

test("paperForLocale: a script subtag between language and region is not mistaken for one", () => {
  assert.equal(paperForLocale("zh-Hans-CN"), "a4");
  assert.equal(paperForLocale("zh-Hant-US"), "letter");
});

test("pageBox: standard has no page", () => {
  assert.equal(pageBox("standard", "letter"), undefined);
  assert.equal(pageBox("standard", "a4"), undefined);
});

test("pageBox: a portrait Letter page is the text block inside 1-inch margins", () => {
  const box = pageBox("portrait", "letter")!;
  assert.ok(Math.abs(box.widthIn - 6.5) < 1e-6);
  assert.ok(Math.abs(box.heightIn - 9) < 1e-6);
  assert.equal(box.width, 624);
  assert.equal(box.height, 864);
});

test("pageBox: landscape swaps the two sides of the same page", () => {
  const portrait = pageBox("portrait", "a4")!;
  const landscape = pageBox("landscape", "a4")!;
  assert.ok(Math.abs(landscape.widthIn - portrait.heightIn) < 1e-6);
  assert.ok(Math.abs(landscape.heightIn - portrait.widthIn) < 1e-6);
});

test("pageBox: A4 comes out narrower and taller than Letter", () => {
  const a4 = pageBox("portrait", "a4")!;
  const letter = pageBox("portrait", "letter")!;
  assert.ok(a4.widthIn < letter.widthIn);
  assert.ok(a4.heightIn > letter.heightIn);
});

test("fitWithin: downscales a figure larger than the page", () => {
  const scale = fitWithin(1200, 300, { width: 600, height: 900 });
  // Width is the binding constraint: 600/1200 = 0.5, versus 900/300 = 3.
  assert.ok(Math.abs(scale - 0.5) < 1e-9);
});

test("fitWithin: upscales a figure smaller than the page, rather than leaving it small", () => {
  const scale = fitWithin(100, 50, { width: 600, height: 900 });
  assert.ok(scale > 1);
  assert.ok(Math.abs(scale - 6) < 1e-9);
});

test("fitWithin: a degenerate width or height falls back to no scaling rather than dividing by zero", () => {
  assert.equal(fitWithin(0, 50, { width: 600, height: 900 }), 1);
  assert.equal(fitWithin(50, 0, { width: 600, height: 900 }), 1);
});

test("parseExportSize: only the three real values pass, everything else is rejected", () => {
  assert.equal(parseExportSize("standard"), "standard");
  assert.equal(parseExportSize("portrait"), "portrait");
  assert.equal(parseExportSize("landscape"), "landscape");
  assert.equal(parseExportSize("huge"), undefined);
  assert.equal(parseExportSize(""), undefined);
  assert.equal(parseExportSize(null), undefined);
  assert.equal(parseExportSize(42), undefined);
});

test("the PNG scales are both positive and the page one is print resolution", () => {
  assert.ok(PNG_SCALE_STANDARD > 0);
  assert.ok(Math.abs(PNG_SCALE_PAGE - 300 / 96) < 1e-9);
});
