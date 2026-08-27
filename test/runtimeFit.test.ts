/**
 * Whether a model fits, which is the question a model list has to answer.
 *
 * Sized against the real Qwen3-Coder-30B shape, because the interesting result
 * is not arithmetic: at a 32k context that model's KV cache is over 3 GB, which
 * is larger than the difference between two quantisations. A list that compares
 * file size against VRAM recommends models that then fail to load.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_LADDER, fitModel, kvCacheBytes, largestContext, quantRank } from "../src/core/runtime/fit.ts";
import type { ModelShape } from "../src/core/runtime/fit.ts";

const GIB = 1024 ** 3;

const QWEN: ModelShape = {
  architecture: "qwen3moe",
  layers: 48,
  embeddingLength: 2048,
  headCount: 32,
  headCountKv: 4,
  keyLength: 128,
  valueLength: 128,
  contextLength: 262144,
  hasChatTemplate: true,
};

test("the KV cache is computed from the KV heads, not the attention heads", () => {
  // 2 x 48 layers x 4 kv heads x 128 wide x 32768 tokens x 2 bytes.
  const expected = 2 * 48 * 4 * 128 * 32768 * 2;
  assert.equal(kvCacheBytes(QWEN, 32768), expected);
  assert.equal(expected, 3 * GIB, "exactly 3GB of cache — which is why it cannot be ignored");

  // Using head_count instead would be eight times too big -- the bug this guards.
  const wrong = 2 * 48 * 32 * 128 * 32768 * 2;
  assert.equal(wrong / expected, 8);
});

test("head dimension is derived when the header does not state it", () => {
  const { keyLength: _k, valueLength: _v, ...implied } = QWEN;
  // 2048 embedding / 32 heads = 64 wide.
  assert.equal(kvCacheBytes(implied, 4096), 2 * 48 * 4 * 64 * 4096 * 2);
});

test("a model that fits the card is called fast, and one that does not is not", () => {
  const machine = { vramBytes: 24 * GIB, ramBytes: 64 * GIB };
  const small = fitModel(11 * GIB, machine, { shape: QWEN, context: 8192 });
  assert.equal(small.verdict, "gpu");
  assert.match(small.label, /Fits on your GPU/);

  // The same model at a long context stops fitting -- entirely because of the
  // cache, which is the case the naive comparison gets wrong.
  const long = fitModel(11 * GIB, machine, { shape: QWEN, context: 262144 });
  assert.notEqual(long.verdict, "gpu");
  assert.ok(long.kvBytes! > 20 * GIB);
});

test("the ladder walks down to what actually fits", () => {
  const machine = { vramBytes: 8 * GIB, ramBytes: 16 * GIB };
  const context = largestContext(11 * GIB, machine, QWEN);
  assert.ok(context !== undefined);
  assert.ok(CONTEXT_LADDER.includes(context!), "a round number a user can be shown");
  // And it must be a context that genuinely fits the combined budget.
  assert.ok(fitModel(11 * GIB, machine, { shape: QWEN, context: context! }).requiredBytes <= 24 * GIB);
});

test("a model is never offered a context longer than it was trained for", () => {
  const short: ModelShape = { ...QWEN, contextLength: 4096 };
  assert.equal(largestContext(1 * GIB, { vramBytes: 80 * GIB, ramBytes: 256 * GIB }, short), 4096);
});

test("without a header the answer is still given, and marked as a guess", () => {
  const fit = fitModel(4 * GIB, { vramBytes: 8 * GIB, ramBytes: 16 * GIB });
  assert.equal(fit.estimated, true);
  assert.match(fit.label, /estimated/);
});

test("no GPU is a verdict, not an absence", () => {
  const fit = fitModel(4 * GIB, { ramBytes: 32 * GIB }, { shape: QWEN, context: 4096 });
  assert.equal(fit.verdict, "cpu");
  assert.match(fit.label, /processor/);
});

test("a model larger than the machine says so plainly", () => {
  const fit = fitModel(200 * GIB, { vramBytes: 8 * GIB, ramBytes: 16 * GIB }, { shape: QWEN });
  assert.equal(fit.verdict, "too-large");
  assert.match(fit.label, /Too large/);
});

test("Q4_K_M is the default recommendation", () => {
  assert.ok(quantRank("model-Q4_K_M.gguf") < quantRank("model-Q2_K.gguf"));
  assert.ok(quantRank("model-Q4_K_M.gguf") < quantRank("model-Q8_0.gguf"));
  assert.ok(quantRank("model-BF16.gguf") >= quantRank("model-Q6_K.gguf"));
});
