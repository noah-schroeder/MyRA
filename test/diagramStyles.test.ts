/**
 * The looks a diagram can be drawn in. The standard look is pinned to the
 * numbers MyRA drew with before looks existed, and every palette is checked
 * for legibility rather than trusted to have been picked carefully.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CATEGORY_PALETTE_SIZE } from "../src/core/diagrams/layout.ts";
import { contrastRatio, toGrey } from "../src/core/diagrams/colors.ts";
import { DIAGRAM_STYLES, LOOKS, parseDiagramStyle, STYLE_THEMES } from "../src/core/diagrams/styles.ts";
import { PAPER_THEME, themeForStyle } from "../src/core/diagrams/svg.ts";

test("the standard look is exactly the geometry diagrams always had", () => {
  const s = LOOKS.standard;
  assert.deepEqual(
    [s.fontSize, s.lineHeight, s.charW, s.padX, s.padY, s.minW, s.minH, s.rankGap, s.siblingGap, s.margin],
    [13, 17, 0.58, 16, 12, 96, 40, 56, 28, 20],
  );
  assert.deepEqual(
    [s.radius, s.nodeStrokeWidth, s.edgeWidth, s.arrowSize, s.elbowRadius, s.shadow, s.shadowBlur, s.shadowDy],
    [10, 1.5, 1.5, 8, 0, true, 3, 2],
  );
});

test("a style name is validated, not trusted", () => {
  for (const name of DIAGRAM_STYLES) assert.equal(parseDiagramStyle(name), name);
  for (const bad of ["", "Poster", "fancy", 3, undefined, null]) assert.equal(parseDiagramStyle(bad), undefined);
});

test("the standard look exports on paper; every named look has its own palette", () => {
  assert.equal(themeForStyle(undefined), PAPER_THEME);
  assert.equal(themeForStyle("standard"), PAPER_THEME);
  assert.equal(themeForStyle("poster"), STYLE_THEMES.poster);
});

test("every palette's category fills are legible under its own text, and complete", () => {
  for (const [name, theme] of Object.entries(STYLE_THEMES)) {
    assert.equal(theme.categoryFill.length, CATEGORY_PALETTE_SIZE, name);
    if (theme.categoryStroke) assert.equal(theme.categoryStroke.length, CATEGORY_PALETTE_SIZE, name);
    for (const fill of [theme.nodeFill, theme.tintFill, ...theme.categoryFill]) {
      assert.ok(contrastRatio(fill, theme.text) >= 7, `${name}: ${fill} against ${theme.text}`);
    }
  }
});

test("the monochrome palette holds nothing but greys", () => {
  const t = STYLE_THEMES.monochrome;
  const hexes = [t.background, t.nodeFill, t.tintFill, t.nodeStroke, t.text, t.edge, t.edgeLabel, t.edgeLabelBg, ...t.categoryFill];
  for (const hex of hexes) assert.equal(toGrey(hex), hex, hex);
});

test("a colour turned grey keeps its lightness", () => {
  assert.equal(toGrey("#ffffff"), "#ffffff");
  assert.equal(toGrey("#000000"), "#000000");
  const grey = toGrey("#ff0000");
  assert.match(grey, /^#([0-9a-f]{2})\1\1$/);
  assert.ok(Math.abs(contrastRatio(grey, "#ffffff") - contrastRatio("#ff0000", "#ffffff")) < 0.05);
});
