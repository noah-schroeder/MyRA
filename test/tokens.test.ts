/**
 * Token counts must never be shown rounded.
 *
 * The rule this enforces: a displayed context size is either exact in `k` or
 * exact in full. There is no third case, because "about 31k" for a 32,000
 * window is the kind of small inaccuracy that makes every other number on the
 * screen suspect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTokens } from "../src/core/tokens.ts";

test("powers of two print as exact k", () => {
  assert.equal(formatTokens(4096), "4k");
  assert.equal(formatTokens(8192), "8k");
  assert.equal(formatTokens(32768), "32k");
  assert.equal(formatTokens(131072), "128k");
  assert.equal(formatTokens(1048576), "1024k");
});

test("anything not a whole number of 1024s prints in full", () => {
  // The case that motivated this: 32000 / 1024 is 31.25, and "31k" is a lie.
  assert.equal(formatTokens(32000), "32,000");
  assert.equal(formatTokens(100000), "100,000");
  assert.equal(formatTokens(4097), "4,097");
});

test("small counts print as themselves", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(325), "325");
  assert.equal(formatTokens(1023), "1023");
});

test("nonsense does not render as a number", () => {
  assert.equal(formatTokens(Number.NaN), "—");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatTokens(-1), "—");
});
