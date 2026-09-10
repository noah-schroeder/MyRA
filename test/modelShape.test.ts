/**
 * Reading a model's shape out of the config its authors published.
 *
 * The point of it is `fit.ts`: with a shape the KV cache is arithmetic, and
 * without one it is a fraction of the file size that comes out identical at 4k
 * and at 128k. So the thing to pin is that a shape is either complete and
 * therefore usable, or absent -- never partial and confidently wrong.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { shapeFromConfig } from "../src/core/runtime/modelShape.ts";
import { kvCacheBytes } from "../src/core/runtime/fit.ts";

/** Qwen3-30B-A3B's real config.json, trimmed to the fields that matter. */
const QWEN3 = {
  architectures: ["Qwen3MoeForCausalLM"],
  model_type: "qwen3_moe",
  hidden_size: 2048,
  head_dim: 128,
  num_attention_heads: 32,
  num_hidden_layers: 48,
  num_key_value_heads: 4,
  max_position_embeddings: 262144,
  vocab_size: 151936,
};

test("reads the fields the cache arithmetic needs", () => {
  const shape = shapeFromConfig(QWEN3);
  assert.deepEqual(shape, {
    layers: 48,
    headCount: 32,
    headCountKv: 4,
    keyLength: 128,
    valueLength: 128,
    embeddingLength: 2048,
    contextLength: 262144,
    architecture: "Qwen3MoeForCausalLM",
  });
  /* The same 3 GiB at 32k that test/runtimeFit.test.ts pins by hand, now
     derived from the published file rather than typed into a fixture. */
  assert.equal(kvCacheBytes(shape!, 32768), 3 * 1024 ** 3);
});

test("derives the head dimension when the config does not state one", () => {
  const { head_dim: _drop, ...without } = QWEN3;
  assert.equal(shapeFromConfig(without)?.keyLength, 2048 / 32);
});

test("prefers a stated head_dim over the derived one", () => {
  /* Some families set it independently of hidden_size / heads, and where they
     do the derived figure is wrong rather than approximate. */
  const shape = shapeFromConfig({ ...QWEN3, head_dim: 64 });
  assert.equal(shape?.keyLength, 64);
});

test("treats a model with no grouped-query attention as one cache per head", () => {
  const { num_key_value_heads: _drop, ...without } = QWEN3;
  assert.equal(shapeFromConfig(without)?.headCountKv, 32);
});

test("returns nothing rather than a partial shape", () => {
  for (const missing of ["num_hidden_layers", "num_attention_heads"]) {
    const partial: Record<string, unknown> = { ...QWEN3 };
    delete partial[missing];
    assert.equal(shapeFromConfig(partial), undefined, `built a shape without ${missing}`);
  }
  /* No hidden_size and no head_dim: nothing to derive a head width from. */
  const { hidden_size: _a, head_dim: _b, ...bare } = QWEN3;
  assert.equal(shapeFromConfig(bare), undefined);
});

test("refuses what is not a config at all", () => {
  for (const bad of [undefined, null, 4, "text", [], { error: "not found" }]) {
    assert.equal(shapeFromConfig(bad), undefined);
  }
});

test("ignores nonsense values rather than believing them", () => {
  assert.equal(shapeFromConfig({ ...QWEN3, num_hidden_layers: 0 }), undefined);
  assert.equal(shapeFromConfig({ ...QWEN3, num_hidden_layers: -48 }), undefined);
  assert.equal(shapeFromConfig({ ...QWEN3, num_hidden_layers: "48" }), undefined);
});

/*
 * Whether this is a mixture-of-experts model, which decides whether the
 * settings panel offers `--n-cpu-moe` at all. No field name is universal
 * across families, so three are checked.
 */
describe("mixture-of-experts detection", () => {
  it("reads Qwen's own field name", () => {
    assert.equal(shapeFromConfig({ ...QWEN3, num_experts: 128 })?.experts, 128);
  });

  it("reads Mixtral's and GPT-OSS's field name", () => {
    assert.equal(shapeFromConfig({ ...QWEN3, num_local_experts: 8 })?.experts, 8);
  });

  it("reads DeepSeek's field name", () => {
    assert.equal(shapeFromConfig({ ...QWEN3, n_routed_experts: 256 })?.experts, 256);
  });

  it("is absent on a dense model -- Mixtral and DBRX do not spell \"moe\" in their name either", () => {
    assert.equal(shapeFromConfig(QWEN3)?.experts, undefined);
  });
});
