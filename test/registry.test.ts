/**
 * Registry search parsing.
 *
 * The payloads here are trimmed copies of what lemonade 11.8.0 actually
 * returned on this machine, not invented shapes -- including the two facts
 * that drove the design: `total` counts what was fetched rather than what came
 * back, and a result carries its own `source`, which is the only thing that
 * can label a row once two registries are merged into one list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { quantRank } from "../src/core/runtime/fit.ts";
import { enabledOnly, parseCatalog } from "../src/core/runtime/catalog.ts";
import { displayModelName, sourceOfModel } from "../src/core/runtime/foreign.ts";
import {
  checkpointFor,
  ENABLED_SOURCES,
  isEnabled,
  KNOWN_SOURCES,
  explainRegistryError,
  modelNameFor,
  parseVariants,
  recommendVariant,
  readSource,
  REGISTRY_LABEL,
} from "../src/core/runtime/registry.ts";

const HF_SEARCH = {
  query: "qwen",
  source: "huggingface",
  total: 50,
  results: [
    {
      description: "",
      display_name: "Qwen3-Coder-30B-A3B-Instruct-GGUF",
      downloads: 12078219,
      has_gguf: true,
      likes: 929,
      repository_id: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
      repository_type: "model",
      source: "huggingface",
      tags: ["transformers", "gguf"],
    },
  ],
};

const MS_SEARCH = {
  query: "qwen",
  source: "modelscope",
  total: 24742,
  results: [
    {
      description: "Qwen 2.5 系列开源模型",
      display_name: "千问3-8B",
      downloads: 7369625,
      has_gguf: false,
      likes: 337,
      repository_id: "Qwen/Qwen3-8B",
      repository_type: "model",
      source: "modelscope",
      tags: ["license:apache-2.0"],
    },
  ],
};

test("the country is part of every label", () => {
  assert.equal(REGISTRY_LABEL.huggingface, "Hugging Face [US]");
  assert.equal(REGISTRY_LABEL.modelscope, "ModelScope [CN]");
});

test("an absent source means Hugging Face, never unknown", () => {
  // The catalogue states `source` only when it is not the default, so this is
  // load-bearing: reading it as "unknown" would leave rows unlabelled.
  assert.equal(readSource(undefined), "huggingface");
  assert.equal(readSource(""), "huggingface");
  assert.equal(readSource("modelscope"), "modelscope");
  assert.equal(readSource("MODELSCOPE"), "huggingface");
});

const VARIANTS = {
  checkpoint: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
  recipe: "llamacpp",
  source: "huggingface",
  suggested_name: "Qwen3-Coder-30B-A3B-Instruct-GGUF",
  suggested_labels: ["chat"],
  mmproj_files: [],
  draft_files: [],
  repo_kind: "gguf",
  variants: [
    { files: ["a-Q8_0.gguf"], name: "Q8_0", primary_file: "a-Q8_0.gguf", sharded: false, size_bytes: 32483935392 },
    { files: ["a-Q4_K_M.gguf"], name: "Q4_K_M", primary_file: "a-Q4_K_M.gguf", sharded: false, size_bytes: 18556689568 },
    {
      files: ["BF16/a-00001-of-00002.gguf", "BF16/a-00002-of-00002.gguf"],
      name: "BF16",
      primary_file: "BF16/a-00001-of-00002.gguf",
      sharded: true,
      size_bytes: 61000000000,
    },
  ],
};

test("parseVariants reads exact sizes and shard counts", () => {
  const parsed = parseVariants(VARIANTS, "huggingface");
  assert.equal(parsed.recipe, "llamacpp");
  assert.equal(parsed.variants.length, 3);
  const sharded = parsed.variants.find((v) => v.name === "BF16");
  assert.equal(sharded?.sharded, true);
  assert.equal(sharded?.files.length, 2);
  // Exact bytes, where the catalogue only had rounded gigabytes.
  assert.equal(parsed.variants.find((v) => v.name === "Q4_K_M")?.sizeBytes, 18556689568);
});

test("a variants response with no source falls back to the one asked for", () => {
  // Otherwise a ModelScope lookup would silently report itself as Hugging Face.
  assert.equal(parseVariants({ variants: [] }, "modelscope").source, "modelscope");
});

test("the recommended variant follows the quantisation rule of thumb", () => {
  const parsed = parseVariants(VARIANTS, "huggingface");
  assert.equal(recommendVariant(parsed.variants, quantRank)?.name, "Q4_K_M");
  assert.equal(recommendVariant([], quantRank), undefined);
});

test("a sharded variant is pulled by its first file, not its file list", () => {
  const parsed = parseVariants(VARIANTS, "huggingface");
  const sharded = parsed.variants.find((v) => v.name === "BF16");
  assert.ok(sharded);
  assert.equal(
    checkpointFor("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", sharded),
    "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:BF16/a-00001-of-00002.gguf",
  );
});

test("two quantisations of one repository get different model names", () => {
  const parsed = parseVariants(VARIANTS, "huggingface");
  const names = parsed.variants.map((v) => modelNameFor("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", v));
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[1], "Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M");
});

test("registry failures are explained rather than pasted", () => {
  const raw =
    '/pull/variants?checkpoint=Qwen%2FQwen2.5-0.5B-Instruct&source=modelscope failed (500): ' +
    '{"error":"ModelScope API returned status 500 for Qwen/Qwen2.5-0.5B-Instruct"}';
  const said = explainRegistryError(raw, "modelscope");
  // No URL, no status code, no JSON: a sentence about what to do instead.
  assert.ok(!said.includes("/pull/variants"));
  assert.ok(!said.includes("{"));
  assert.match(said, /ModelScope did not answer in time/);
  assert.match(said, /other registry/);
});

test("an error with no known shape is passed through, not swallowed", () => {
  assert.equal(
    explainRegistryError("could not reach Lemonade: fetch failed", "huggingface"),
    "could not reach Lemonade: fetch failed",
  );
  assert.match(explainRegistryError("", "huggingface"), /Hugging Face could not be read/);
});

test("ModelScope is disabled, and disabling is what the main process checks", () => {
  // The user's instruction was unambiguous: nothing on this machine may fetch
  // from ModelScope. The label and parser stay so re-enabling is one line, but
  // `isEnabled` is the gate, and it is checked in the main process.
  assert.deepEqual(ENABLED_SOURCES, ["huggingface"]);
  assert.equal(isEnabled("huggingface"), true);
  assert.equal(isEnabled("modelscope"), false);
  // Still known, still labelled — a disabled registry is not an unknown one.
  assert.deepEqual(KNOWN_SOURCES, ["huggingface", "modelscope"]);
  assert.equal(REGISTRY_LABEL.modelscope, "ModelScope [CN]");
});

test("catalogue entries from disabled registries never reach the UI", () => {
  // Ten of upstream's 228 entries are ModelScope, all marked `suggested`, so
  // they sort to the top of the default list. They must not be offered.
  const entries = parseCatalog({
    "SmolLM2-135M": { checkpoint: "a/b", recipe: "llamacpp", labels: ["chat"], size: 0.28 },
    "MiniCPM5-1B-GGUF": {
      source: "modelscope",
      checkpoint: "OpenBMB/MiniCPM5-1B-GGUF:MiniCPM5-1B-Q4_K_M.gguf",
      recipe: "llamacpp",
      suggested: true,
      labels: ["chat"],
      size: 0.69,
    },
  });
  assert.equal(entries.length, 2);
  const kept = enabledOnly(entries);
  assert.deepEqual(kept.map((e) => e.id), ["SmolLM2-135M"]);
});

test("model ids are shown as the name someone downloaded", () => {
  // The complaint that started this: an LM Studio model showing its bookkeeping.
  assert.equal(displayModelName("lmstudio__LFM2.5-8B-A1B"), "LFM2.5-8B-A1B");
  assert.equal(displayModelName("ollama__llama3.2:3b"), "llama3.2:3b");
  // A flattened repository path drops the publisher for the same reason.
  assert.equal(displayModelName("bartowski__SmolLM2-135M-Instruct-GGUF"), "SmolLM2-135M-Instruct-GGUF");
  // Plain catalogue ids are already the name and must be left alone.
  assert.equal(displayModelName("Qwen3-0.6B-GGUF"), "Qwen3-0.6B-GGUF");
  assert.equal(displayModelName(""), "");
  // The id itself never changes: it is what `load` and every request name.
  assert.equal(sourceOfModel("lmstudio__LFM2.5-8B-A1B"), "lmstudio");
  assert.equal(sourceOfModel("Qwen3-0.6B-GGUF"), undefined);
});
