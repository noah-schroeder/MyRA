/**
 * Reading the daemon's health payload.
 *
 * The sample is what lemonade 11.8.0 returned on this machine with a model
 * loaded. Two things in it drove changes: `all_models_loaded` holds objects
 * rather than strings, and the context the server was launched with is not the
 * model's own ceiling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHealth, parseProps, propsUrl } from "../src/core/runtime/lemonade.ts";

const HEALTH = {
  model_loaded: "bartowski__SmolLM2-135M-Instruct-GGUF",
  all_models_loaded: [
    {
      model_name: "bartowski__SmolLM2-135M-Instruct-GGUF",
      status: "ready",
      loaded: true,
      device: "gpu",
      recipe: "llamacpp",
      max_context_window: 8192,
      recipe_options: { ctx_size: 4096, llamacpp_args: "--parallel 1" },
    },
  ],
};

test("the loaded list reads objects, not just strings", () => {
  // It only ever accepted strings, so this list was silently always empty.
  assert.deepEqual(parseHealth(HEALTH).loaded, ["bartowski__SmolLM2-135M-Instruct-GGUF"]);
  assert.deepEqual(parseHealth({ all_models_loaded: ["older-shape"] }).loaded, ["older-shape"]);
});

test("the context actually in use is reported next to the model's ceiling", () => {
  const active = parseHealth(HEALTH).active;
  // 4096 is what llama.cpp was started with; 8192 is what the model could do.
  assert.equal(active?.contextTokens, 4096);
  assert.equal(active?.maxContextTokens, 8192);
  assert.equal(active?.device, "gpu");
  assert.equal(active?.ready, true);
});

test("health with nothing loaded reports nothing loaded", () => {
  const health = parseHealth({ model_loaded: null, all_models_loaded: [] });
  assert.equal(health.modelLoaded, undefined);
  assert.equal(health.active, undefined);
  assert.deepEqual(health.loaded, []);
});

test("a payload of an unexpected shape does not throw", () => {
  for (const junk of [undefined, null, 7, "text", { all_models_loaded: "no" }, { all_models_loaded: [null, {}] }]) {
    assert.deepEqual(parseHealth(junk).loaded, []);
  }
});

test("the context is read from llama-server's per-slot figure", () => {
  // The top-level n_ctx is the total across slots; one conversation gets the
  // per-slot number. They differ as soon as --parallel is above 1, and it is
  // the per-slot one a token meter must count against.
  assert.equal(
    parseProps({ n_ctx: 8192, total_slots: 2, default_generation_settings: { n_ctx: 4096 } }),
    4096,
  );
  // Falls back to the total when no per-slot figure is given.
  assert.equal(parseProps({ n_ctx: 4096 }), 4096);
  for (const junk of [undefined, null, {}, { n_ctx: 0 }, { n_ctx: "4096" }, 7]) {
    assert.equal(parseProps(junk), undefined);
  }
});

test("health records where the context figure came from", () => {
  // Lemonade's ctx_size is what it asked for; only /props says what happened.
  assert.equal(parseHealth(HEALTH).active?.contextFrom, "daemon");
  assert.equal(parseHealth(HEALTH).active?.backendUrl, undefined);
  const withBackend = {
    ...HEALTH,
    all_models_loaded: [{ ...HEALTH.all_models_loaded[0], backend_url: "http://127.0.0.1:8002/v1" }],
  };
  assert.equal(parseHealth(withBackend).active?.backendUrl, "http://127.0.0.1:8002/v1");
});

test("the props URL is the server root, not the OpenAI path", () => {
  assert.equal(propsUrl("http://127.0.0.1:8002/v1"), "http://127.0.0.1:8002/props");
  assert.equal(propsUrl("http://127.0.0.1:8002"), "http://127.0.0.1:8002/props");
  assert.equal(propsUrl("not a url"), undefined);
});
