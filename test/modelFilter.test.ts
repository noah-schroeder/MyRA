/**
 * Filtering the model menu.
 *
 * Tested rather than eyeballed because the box that drives it only appears
 * once there are more than six models, which is more than any machine this was
 * written on has. The behaviour that matters is that a publisher's name still
 * matches after the row has been shortened to hide it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { filterModels } from "../src/core/runtime/foreign.ts";

const MODELS = [
  { path: "unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF", name: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF" },
  { path: "LiquidAI__LFM2.5-2.6B-GGUF", name: "LiquidAI/LFM2.5-2.6B-GGUF" },
  { path: "bartowski__SmolLM2-135M-Instruct-GGUF", name: "bartowski/SmolLM2-135M-Instruct-GGUF" },
  { path: "embeddinggemma-300M-GGUF-Q8_0", name: "embeddinggemma-300M-GGUF-Q8_0" },
];

const names = (list: { path: string }[]): string[] => list.map((m) => m.path);

test("an empty query changes nothing", () => {
  assert.equal(filterModels(MODELS, "").length, 4);
  assert.equal(filterModels(MODELS, "   ").length, 4);
});

test("a publisher matches even though the rows do not show one", () => {
  /* The row for the first model reads "Qwen3-Coder-30B-A3B-Instruct": the
     publisher is shortened away. Matching only the visible text would make the
     most natural search on a big library return nothing. */
  assert.deepEqual(names(filterModels(MODELS, "unsloth")), ["unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF"]);
  assert.deepEqual(names(filterModels(MODELS, "bartowski")), ["bartowski__SmolLM2-135M-Instruct-GGUF"]);
});

test("a model name matches on what is shown", () => {
  assert.deepEqual(names(filterModels(MODELS, "smollm")), ["bartowski__SmolLM2-135M-Instruct-GGUF"]);
  assert.deepEqual(names(filterModels(MODELS, "LFM")), ["LiquidAI__LFM2.5-2.6B-GGUF"]);
});

test("matching ignores case, because nobody types capitals into a filter", () => {
  assert.equal(filterModels(MODELS, "QWEN").length, 1);
  assert.equal(filterModels(MODELS, "qwen").length, 1);
});

test("a partial word matches, so typing narrows as you go", () => {
  /* Substring, not prefix, and over the id as well as the name -- so a single
     letter is genuinely broad: "q" reaches Qwen, the Q8_0 quantisation, and the
     q in LiquidAI. That is the correct behaviour for a filter you type into,
     and the second keystroke is what makes it useful. */
  assert.equal(filterModels(MODELS, "q").length, 3);
  assert.equal(filterModels(MODELS, "qw").length, 1);
  assert.deepEqual(names(filterModels(MODELS, "qwe")), ["unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF"]);
});

test("nothing matching returns nothing rather than everything", () => {
  // The failure mode worth pinning: a filter that falls open on no match
  // silently tells the user their search worked.
  assert.deepEqual(filterModels(MODELS, "llama"), []);
});
