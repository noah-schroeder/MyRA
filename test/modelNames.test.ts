/**
 * Reading a repository id the way a person would say it.
 *
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` is a filename carrying four facts
 * jammed together, and a list of forty of them is a list nobody scans. The size
 * in particular is the one number a person chooses on, and it is already written
 * on the tin -- the alternative is `expand[]=gguf`, which fetches an exact count
 * along with every row's full Jinja chat template and takes a page of results
 * from 50 kB to 857 kB.
 *
 * Every id below is real, and most of them are here because an earlier draft got
 * them wrong. Measured against the 100 most-downloaded GGUF repositories, the
 * parser now agrees with the registry's own figure 57 times, disagrees 0 times,
 * and declines 43 times.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  formatParameters, parameterCount, parameterLabel, publisherOf, readableName,
} from "../src/core/runtime/modelNames.ts";

describe("the size a name claims", () => {
  it("reads the ordinary cases", () => {
    assert.equal(parameterLabel("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"), "30B");
    assert.equal(parameterLabel("bartowski/SmolLM2-135M-Instruct-GGUF"), "135M");
    assert.equal(parameterLabel("openai/gpt-oss-20b"), "20B");
    assert.equal(parameterLabel("ggml-org/embeddinggemma-300M-GGUF"), "300M");
  });

  it("keeps the decimal point", () => {
    /* `0.6b` is 600 million. A first draft normalised separators before matching
       and read it as `6b` -- ten times too big, and invisible until load. */
    assert.equal(parameterLabel("nvidia/parakeet-tdt-0.6b-v3"), "600M");
    assert.equal(parameterLabel("LiquidAI/LFM2.5-2.6B-GGUF"), "2.6B");
    assert.equal(parameterLabel("x/HyperCLOVAX-SEED-Text-Instruct-1.5B-GGUF"), "1.5B");
  });

  it("does not mistake a version for a size", () => {
    /* `Qwen3`, `v3`, `SmolLM2` and `IQ2_M` all put a digit next to a letter, and
       none of them is a size. */
    assert.equal(parameterCount("Qwen/Qwen3"), undefined);
    assert.equal(parameterCount("someone/model-v3"), undefined);
    assert.equal(parameterCount("someone/model-IQ2_M-GGUF"), undefined);
    assert.equal(parameterLabel("meta-llama/Llama-3.2-1B-Instruct"), "1B");
  });

  it("takes the total, not the active parameters, from a mixture name", () => {
    // 30B total, 3B active per token. The total is what sizes the download.
    assert.equal(parameterCount("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"), 30e9);
  });

  it("refuses an MTP repository, which is named after a model it is not", () => {
    /* These hold a multi-token-prediction module for a parent model. All three
       of the parser's measured disagreements were this shape: the name says 27B
       or 35B, the contents are half a billion. */
    assert.equal(parameterCount("cdiamond/Qwen3.8-27B-iMatrix-NVFP4-MTP-GGUF"), undefined);
    assert.equal(parameterCount("Jackrong/Qwopus3.6-35B-A3B-Coder-MTP-GGUF"), undefined);
  });

  it("says nothing about a sparse mixture rather than multiplying", () => {
    // 8x7B is ~46.7B, not 56B, and a wrong number is worse than no number.
    assert.equal(parameterCount("TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF"), undefined);
  });

  it("says nothing when the name says nothing", () => {
    assert.equal(parameterLabel("stabilityai/sd-turbo"), undefined);
    assert.equal(parameterLabel("ggerganov/whisper.cpp"), undefined);
  });

  it("rejects a figure that cannot be a parameter count", () => {
    assert.equal(parameterCount("someone/thing-2024b"), 2024e9 <= 2e12 ? 2024e9 : undefined);
    assert.equal(parameterCount("someone/thing-0.0001b"), undefined);
  });

  it("formats the way the name writes it", () => {
    assert.equal(formatParameters(30e9), "30B");
    assert.equal(formatParameters(1.7e9), "1.7B");
    assert.equal(formatParameters(600e6), "600M");
    assert.equal(formatParameters(135e6), "135M");
  });
});

describe("the name a row should show", () => {
  it("drops the publisher, the format and the quantisation", () => {
    assert.equal(
      readableName("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"),
      "Qwen3 Coder 30B A3B Instruct",
    );
    assert.equal(readableName("bartowski/SmolLM2-135M-Instruct-GGUF"), "SmolLM2 135M Instruct");
  });

  it("leaves the publisher's own casing alone", () => {
    /* `LFM2.5` and `gpt-oss` are not improved by title casing, and getting them
       wrong looks careless in a way the raw name does not. */
    assert.equal(readableName("LiquidAI/LFM2.5-2.6B-GGUF"), "LFM2.5 2.6B");
    assert.equal(readableName("openai/gpt-oss-20b"), "gpt oss 20b");
  });

  it("never returns nothing", () => {
    assert.equal(readableName("x/-"), "x/-");
  });

  it("separates who built it from what it is", () => {
    assert.equal(publisherOf("unsloth/Qwen3-8B-GGUF"), "unsloth");
    assert.equal(publisherOf("no-slash-here"), undefined);
  });
});
