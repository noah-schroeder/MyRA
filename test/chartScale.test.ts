/**
 * The axis-tick algorithm: deterministic "nice numbers" (Heckbert), asserted
 * as structural invariants rather than pinned to exact tick values -- the
 * same reason diagramLayout.test.ts gives, and it applies here for the same
 * reason: pinning exact numbers would test the constants, not the behaviour.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { niceScale } from "../src/core/charts/scale.ts";

test("the drawn range always encloses [min, max]", () => {
  for (const [min, max] of [[0, 97], [-5, 5], [0.001, 0.087], [3, 3], [-1000, 1000], [1, 1.0001]] as const) {
    const s = niceScale(min, max);
    assert.ok(s.lo <= min, `lo ${s.lo} should be <= ${min}`);
    assert.ok(s.hi >= max, `hi ${s.hi} should be >= ${max}`);
  }
});

test("ticks are strictly increasing and evenly spaced by `step`", () => {
  const s = niceScale(0, 97);
  for (let i = 1; i < s.ticks.length; i++) {
    assert.ok(s.ticks[i]! > s.ticks[i - 1]!);
    assert.ok(Math.abs(s.ticks[i]! - s.ticks[i - 1]! - s.step) < 1e-9);
  }
});

test("the step is always 1, 2 or 5 times a power of ten", () => {
  for (const [min, max] of [[0, 97], [-5, 5], [0.001, 0.087], [1, 1000000]] as const) {
    const s = niceScale(min, max);
    const exponent = Math.floor(Math.log10(s.step));
    const fraction = Math.round((s.step / 10 ** exponent) * 1e6) / 1e6;
    assert.ok([1, 2, 5, 10].includes(fraction), `step ${s.step} has fraction ${fraction}`);
  }
});

test("a zero-width range (min === max) still produces a usable axis", () => {
  const s = niceScale(3, 3);
  assert.ok(s.hi > s.lo);
  assert.ok(s.ticks.length >= 2);
  assert.ok(s.lo <= 3 && s.hi >= 3);
});

test("a zero-width range at zero still produces a usable axis", () => {
  const s = niceScale(0, 0);
  assert.ok(s.hi > s.lo);
});

test("the first and last tick are exactly lo and hi", () => {
  const s = niceScale(0, 97);
  assert.equal(s.ticks[0], s.lo);
  assert.equal(s.ticks[s.ticks.length - 1], s.hi);
});

test("more ticks are produced when asked for, within a reasonable margin", () => {
  const few = niceScale(0, 1000, 4);
  const many = niceScale(0, 1000, 12);
  assert.ok(many.ticks.length >= few.ticks.length);
});

test("floating point noise never reaches a tick label", () => {
  const s = niceScale(0, 1);
  for (const t of s.ticks) {
    // A tick like 0.30000000000000004 would print an ugly label; every tick
    // must round-trip through a short decimal string.
    assert.ok(String(t).length <= 6, `tick ${t} looks like floating-point noise`);
  }
});

test("a negative-to-positive range includes zero as a tick", () => {
  const s = niceScale(-5, 5);
  assert.ok(s.ticks.some((t) => t === 0));
});
