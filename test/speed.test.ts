/**
 * Turning a usage block and a clock into the number under a reply.
 *
 * The property that matters: a rate this app did not measure honestly is
 * never printed. No completion tokens means no tok/s, not a divide against
 * zero rounded away; no server timings means the wall clock stands in, and
 * `measured` says so rather than letting the card claim llama.cpp's own figure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatSpeed, statsFrom } from "../src/core/llm/speed.ts";
import type { ChatTiming, ChatUsage } from "../src/core/llm/chat.ts";

const usage = (input: number, output: number): ChatUsage => ({ input, output, total: input + output });

test("prefers the server's own timings over the wall clock", () => {
  const timing: ChatTiming = { totalMs: 10_000, ttftMs: 2_000, promptMs: 500, predictedMs: 4_000, measured: true };
  const stats = statsFrom(usage(512, 200), timing);
  // 200 tokens / 4000ms, not 200 / (10000-2000).
  assert.equal(stats?.tokensPerSecond, 50);
  // 512 tokens / 500ms.
  assert.equal(stats?.promptPerSecond, 1024);
  assert.equal(stats?.measured, true);
});

test("falls back to the wall clock when the server sent no timings", () => {
  const timing: ChatTiming = { totalMs: 5_000, ttftMs: 1_000, measured: false };
  const stats = statsFrom(usage(100, 80), timing);
  // 80 tokens over the 4000ms after the first token, not the whole 5000ms.
  assert.equal(stats?.tokensPerSecond, 20);
  // Prompt speed estimated from time-to-first-token, since nothing better was sent.
  assert.equal(stats?.promptPerSecond, 100);
  assert.equal(stats?.measured, false);
});

test("no completion tokens means no rate, not a rate of zero", () => {
  const timing: ChatTiming = { totalMs: 3_000, ttftMs: 500, measured: false };
  const stats = statsFrom(usage(50, 0), timing);
  assert.equal(stats?.tokensPerSecond, undefined);
  assert.equal(stats?.completionTokens, 0);
  assert.equal(stats?.totalMs, 3_000);
});

test("no prompt tokens means no prompt rate either", () => {
  const timing: ChatTiming = { totalMs: 3_000, ttftMs: 500, measured: false };
  const stats = statsFrom(usage(0, 40), timing);
  assert.equal(stats?.promptPerSecond, undefined);
});

test("nothing to divide by -- no ttft and no server timings -- yields no rate", () => {
  const timing: ChatTiming = { totalMs: 3_000, measured: false };
  const stats = statsFrom(usage(50, 40), timing);
  assert.equal(stats?.tokensPerSecond, undefined);
  assert.equal(stats?.promptPerSecond, undefined);
});

test("no timing at all -- the non-streaming path -- yields no stats", () => {
  assert.equal(statsFrom(usage(50, 40), undefined), undefined);
});

test("formatSpeed rounds to one decimal and falls back to elapsed time", () => {
  assert.equal(
    formatSpeed({ promptTokens: 10, completionTokens: 33, tokensPerSecond: 42.126, totalMs: 1000, measured: true }),
    "42.1 tok/s",
  );
  assert.equal(
    formatSpeed({ promptTokens: 10, completionTokens: 0, totalMs: 2_345, measured: false }),
    "2.3s",
  );
});
