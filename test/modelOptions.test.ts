/**
 * Per-model load settings.
 *
 * The payloads are what lemonade 11.8.0 returned on this machine for a
 * `llamacpp` model and a `whispercpp` one. The difference between them is the
 * point: the options a model accepts depend on its recipe, and posting a key
 * the recipe does not know is rejected outright.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  effectiveValue,
  fieldsFor,
  isOverridden,
  parseModelOptions,
  patchFrom,
  readContextSize,
} from "../src/core/runtime/modelOptions.ts";

const LLAMACPP = {
  model_name: "LiquidAI__LFM2.5-2.6B-GGUF",
  recipe: "llamacpp",
  resolved_ctx_size: 4096,
  defaults: {
    auto_evict: null,
    auto_update: null,
    ctx_size: -1,
    downsize_idle_timeout: 60,
    evict_idle_timeout: 300,
    evict_weight_factor: 1.0,
    llamacpp_args: "--parallel 1",
    llamacpp_backend: "vulkan",
    llamacpp_device: "",
    merge_args: true,
    model_name: "LiquidAI__LFM2.5-2.6B-GGUF",
  },
  saved: { ctx_size: 16384 },
  effective: { ctx_size: 16384, llamacpp_backend: "vulkan", evict_idle_timeout: 300 },
};

const WHISPERCPP = {
  model_name: "Whisper-Tiny",
  recipe: "whispercpp",
  defaults: {
    auto_evict: null,
    downsize_idle_timeout: 60,
    evict_idle_timeout: 300,
    merge_args: true,
    model_name: "Whisper-Tiny",
    whispercpp_args: "",
    whispercpp_backend: "vulkan",
  },
  saved: {},
  effective: {},
};

test("default, saved and effective are kept apart", () => {
  const options = parseModelOptions(LLAMACPP);
  assert.equal(options.recipe, "llamacpp");
  assert.equal(options.defaults["ctx_size"], -1);
  assert.equal(options.saved["ctx_size"], 16384);
  assert.equal(options.resolvedCtxSize, 4096);
  assert.equal(isOverridden(options, "ctx_size"), true);
  assert.equal(isOverridden(options, "llamacpp_backend"), false);
});

test("the fields offered are the ones the recipe actually has", () => {
  const llama = fieldsFor(parseModelOptions(LLAMACPP)).map((f) => f.key);
  const whisper = fieldsFor(parseModelOptions(WHISPERCPP)).map((f) => f.key);
  assert.ok(llama.includes("ctx_size"));
  assert.ok(llama.includes("llamacpp_args"));
  // whispercpp has no context size at all, and posting one is a 400.
  assert.ok(!whisper.includes("ctx_size"));
  assert.ok(whisper.includes("whispercpp_args"));
  // The model's own name is reported here but is not a setting.
  assert.ok(!llama.includes("model_name"));
});

test("an option Karen has never heard of is still editable", () => {
  // A future Lemonade adding a key must not need a Karen release to set it.
  const options = parseModelOptions({
    recipe: "llamacpp",
    defaults: { some_new_knob: 7, another_flag: false },
    saved: {},
    effective: {},
  });
  const fields = fieldsFor(options);
  const knob = fields.find((f) => f.key === "some_new_knob");
  assert.equal(knob?.kind, "number");
  assert.equal(knob?.label, "Some new knob");
  assert.equal(fields.find((f) => f.key === "another_flag")?.kind, "toggle");
});

test("everyday settings come before advanced ones", () => {
  const fields = fieldsFor(parseModelOptions(LLAMACPP));
  assert.equal(fields[0]?.key, "ctx_size");
  const firstAdvanced = fields.findIndex((f) => f.advanced);
  assert.ok(fields.slice(0, firstAdvanced).every((f) => !f.advanced));
});

test("only genuine changes are sent, so defaults do not become overrides", () => {
  const options = parseModelOptions(LLAMACPP);
  const patch = patchFrom(options, {
    ctx_size: 16384, // unchanged from what is already in force
    evict_idle_timeout: 900, // changed
    llamacpp_backend: "vulkan", // equals the default
    model_name: "nope", // never a setting
  });
  assert.deepEqual(patch, { evict_idle_timeout: 900 });
});

test("a default reported as null and an untouched form field are the same thing", () => {
  const options = parseModelOptions(LLAMACPP);
  assert.equal(effectiveValue(options, "auto_evict"), null);
  assert.deepEqual(patchFrom(options, { auto_evict: undefined }), {});
});

test("context input accepts what the screen prints back", () => {
  // formatTokens shows 16384 as "16k", so "16k" must mean 16384, not 16000.
  assert.deepEqual(readContextSize("16k"), { value: 16384 });
  assert.deepEqual(readContextSize("32768"), { value: 32768 });
  assert.deepEqual(readContextSize("32,768"), { value: 32768 });
  assert.deepEqual(readContextSize("auto"), { value: -1 });
  assert.deepEqual(readContextSize(""), { value: -1 });
  assert.deepEqual(readContextSize("-1"), { value: -1 });
});

test("context input refuses what the daemon would refuse", () => {
  for (const bad of ["0", "-5", "big", "4.5"]) {
    const read = readContextSize(bad);
    assert.ok("error" in read, `${bad} should not be accepted`);
  }
});

test("an option that was never set is not turned into an explicit false", () => {
  // The daemon reports "never set" as null. A checkbox has two states and this
  // has three, and collapsing them wrote two overrides nobody asked for: only
  // the context size was edited, and auto_evict and auto_update came back as
  // false. `patchFrom` must treat null and "untouched" as the same.
  const options = parseModelOptions(LLAMACPP);
  const patch = patchFrom(options, {
    ctx_size: 16384,
    auto_evict: null,
    auto_update: null,
  });
  assert.deepEqual(patch, {});
});

test("turning an unset option off explicitly is still a change", () => {
  const options = parseModelOptions(LLAMACPP);
  assert.deepEqual(patchFrom(options, { auto_evict: false }), { auto_evict: false });
  assert.deepEqual(patchFrom(options, { auto_evict: true }), { auto_evict: true });
});
