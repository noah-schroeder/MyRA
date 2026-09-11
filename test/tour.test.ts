/**
 * The tour's list against the renderer it points at, and the placement math
 * against a window too small or too large for the card.
 *
 * Modelled on researchStages.test.ts: the failure worth pinning is a step
 * whose anchor was renamed on one side and not the other, which would leave
 * the tour silently spotlighting nothing -- nothing else in the app would
 * notice, because `data-tour` exists for no other reader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TOUR_STEPS } from "../src/core/tour/steps.ts";
import { placeCard, unionRect, type Rect, type Size } from "../src/core/tour/place.ts";

/**
 * The tour itself is excluded: it only ever READS `data-tour`, built as
 * `` `[data-tour="${CSS.escape(...)}"]` `` -- a dynamic query, not a literal
 * attribute on an element, and the regex below would otherwise misread the
 * interpolation as an anchor nothing declares.
 */
const TOUR_COMPONENT = join("src", "renderer", "components", "Tour.tsx");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/**
 * Every anchor actually wired up in the renderer's markup.
 *
 * Two shapes count: a literal `data-tour="…"` on an element, and a literal
 * `tour="…"` passed to `RailButton`, which forwards it to `data-tour` itself
 * -- so a rail icon's hook is not a literal attribute in the source, only a
 * prop that becomes one at render time.
 */
function anchorsInRenderer(): Set<string> {
  const found = new Set<string>();
  for (const file of sources(join("src", "renderer"))) {
    if (file === TOUR_COMPONENT) continue;
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/\b(?:data-tour|tour)="([a-z][\w-]*)"/g)) found.add(m[1]!);
  }
  return found;
}

test("every step's anchor exists in the renderer, and every anchor is used by a step", () => {
  const declared = new Set(TOUR_STEPS.map((s) => s.anchor).filter((a): a is string => Boolean(a)));
  const rendered = anchorsInRenderer();

  for (const anchor of declared) {
    assert.ok(rendered.has(anchor), `step anchor "${anchor}" has no data-tour="${anchor}" in the renderer`);
  }
  for (const anchor of rendered) {
    assert.ok(declared.has(anchor), `data-tour="${anchor}" in the renderer names no step`);
  }
});

test("the tour stays inside the budget it was designed to", () => {
  // "At most 10-15 steps, definitely less-is-more" was the brief. Both ends
  // are worth pinning: a future edit that quietly grows this into a feature
  // tour is exactly the failure the brief was written to prevent.
  assert.ok(TOUR_STEPS.length >= 10 && TOUR_STEPS.length <= 15, `${TOUR_STEPS.length} steps`);
});

test("every step reads as a sentence, for a reader who is not a developer", () => {
  for (const step of TOUR_STEPS) {
    assert.ok(step.id.length > 0);
    assert.ok(step.title.length > 2, step.id);
    assert.ok(step.body.endsWith("."), `${step.id} body is not a sentence`);
    // The title is never the raw id shown back to the person reading it.
    assert.notEqual(step.title.toLowerCase(), step.id);
  }
});

test("step ids are unique", () => {
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
});

/* ---------------------------------------------------------------- unionRect */

test("unionRect is the bounding box of every rect it is given", () => {
  const a: Rect = { left: 10, top: 10, width: 20, height: 20 };
  const b: Rect = { left: 40, top: 5, width: 10, height: 10 };
  assert.deepEqual(unionRect([a, b]), { left: 10, top: 5, width: 40, height: 25 });
  assert.deepEqual(unionRect([a]), a);
  assert.equal(unionRect([]), null);
});

/* ---------------------------------------------------------------- placeCard */

const VIEWPORT: Size = { width: 1280, height: 800 };
const CARD: Size = { width: 320, height: 200 };
const MARGIN = 16;

function withinViewport(pos: { left: number; top: number }, card: Size, viewport: Size): void {
  assert.ok(pos.left >= MARGIN - 0.001, `left ${pos.left} off the left edge`);
  assert.ok(pos.top >= MARGIN - 0.001, `top ${pos.top} off the top edge`);
  assert.ok(pos.left + card.width <= viewport.width - MARGIN + 0.001, `right edge overflows at ${pos.left}`);
  assert.ok(pos.top + card.height <= viewport.height - MARGIN + 0.001, `bottom edge overflows at ${pos.top}`);
}

test("a rail anchor near the left edge puts the card to its right", () => {
  const anchor: Rect = { left: 8, top: 400, width: 32, height: 32 };
  const pos = placeCard(anchor, CARD, VIEWPORT, "right");
  assert.equal(pos.side, "right");
  assert.ok(pos.left > anchor.left + anchor.width, "card did not clear the anchor");
  withinViewport(pos, CARD, VIEWPORT);
});

test("a composer anchor near the bottom puts the card above it", () => {
  const anchor: Rect = { left: 300, top: 760, width: 600, height: 40 };
  const pos = placeCard(anchor, CARD, VIEWPORT, "above");
  assert.equal(pos.side, "above");
  assert.ok(pos.top + CARD.height <= anchor.top, "card overlaps the anchor it is describing");
  withinViewport(pos, CARD, VIEWPORT);
});

test("a top-bar anchor puts the card below it", () => {
  const anchor: Rect = { left: 260, top: 12, width: 160, height: 30 };
  const pos = placeCard(anchor, CARD, VIEWPORT, "below");
  assert.equal(pos.side, "below");
  assert.ok(pos.top >= anchor.top + anchor.height, "card overlaps the anchor it is describing");
  withinViewport(pos, CARD, VIEWPORT);
});

test("a right-preferred card flips to the left when the right edge has no room", () => {
  const anchor: Rect = { left: 1200, top: 100, width: 40, height: 40 };
  const pos = placeCard(anchor, CARD, VIEWPORT, "right");
  assert.equal(pos.side, "left");
  assert.ok(pos.left + CARD.width <= anchor.left, "card did not clear the anchor on the flip");
  withinViewport(pos, CARD, VIEWPORT);
});

test("no anchor centres the card", () => {
  const pos = placeCard(null, CARD, VIEWPORT, "right");
  assert.equal(pos.side, "center");
  assert.equal(pos.left, (VIEWPORT.width - CARD.width) / 2);
  assert.equal(pos.top, (VIEWPORT.height - CARD.height) / 2);
});

test("a card larger than the viewport still stays reachable", () => {
  // The case that is invisible until someone runs the app in a small window:
  // a card that cannot fit must still land somewhere with Skip and Next on
  // screen, rather than centred on a negative coordinate.
  const anchor: Rect = { left: 8, top: 400, width: 32, height: 32 };
  const huge: Size = { width: 2000, height: 2000 };
  const small: Size = { width: 500, height: 400 };

  for (const pos of [
    placeCard(anchor, huge, small, "right"),
    placeCard(null, huge, small, "right"),
    placeCard(anchor, huge, small, "above"),
  ]) {
    assert.equal(pos.left, MARGIN);
    assert.equal(pos.top, MARGIN);
  }
});
