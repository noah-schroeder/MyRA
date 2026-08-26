/**
 * The flags, and the arithmetic the configurator prints beside them.
 *
 * Every expectation about llama-server's behaviour here was measured against
 * b10639 before it was written down, because all three of the ones that matter
 * are counter-intuitive: `-c 0` multiplies by the slot count, `-c` is divided
 * by it, and `--kv-unified` reverses both. Guessing at any of those produces a
 * memory figure that is wrong by a factor, on exactly the models where being
 * wrong is expensive.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetFor, autoContext, contextChoices, bytesPerElement, defaultSettings,
  launchArgs, parseExtraArgs, tokenize, ReservedArgError, type LaunchSettings,
} from "../src/core/runtime/launch.ts";
import type { ModelShape } from "../src/core/runtime/gguf.ts";

const GIB = 1024 ** 3;

/** Qwen3-Coder-30B-A3B's real shape: 48 layers, 4 KV heads, 128-wide, 128k. */
const QWEN30B: ModelShape = {
  architecture: "qwen3moe",
  layers: 48,
  headCount: 32,
  headCountKv: 4,
  keyLength: 128,
  valueLength: 128,
  embeddingLength: 4096,
  contextLength: 131072,
  hasChatTemplate: true,
};

const base = (): LaunchSettings => defaultSettings();

/* ------------------------------------------------------------------ flags -- */

test("the unified cache is not optional, and -c is what the user chose", () => {
  const args = launchArgs({ ...base(), context: 32768, slots: 2 }, 32768);

  // Measured: `-c 4096 -np 2` alone gives each conversation 2048, while
  // `-c 4096 -np 2 -kvu` gives each of them 4096 from one buffer. Without the
  // flag, every context number shown to the user would be a lie by a factor.
  assert.ok(args.includes("--kv-unified"));
  assert.equal(args[args.indexOf("-c") + 1], "32768");
  assert.equal(args[args.indexOf("-np") + 1], "2");
});

test("a slot count below one is not passed on", () => {
  const args = launchArgs({ ...base(), slots: 0 }, 4096);
  assert.equal(args[args.indexOf("-np") + 1], "1");
});

test("a quantised cache sets both halves", () => {
  const args = launchArgs({ ...base(), cacheType: "q8_0" }, 8192);
  assert.equal(args[args.indexOf("--cache-type-k") + 1], "q8_0");
  assert.equal(args[args.indexOf("--cache-type-v") + 1], "q8_0");
  // Flash attention stays on upstream's `auto`: measured to enable itself where
  // a quantised V cache needs it, and forcing it would break machines that
  // cannot do it at all.
  assert.ok(!args.includes("-fa"));
});

test("full precision passes no cache flags at all", () => {
  const args = launchArgs({ ...base(), cacheType: "f16" }, 8192);
  assert.ok(!args.some((a) => a.startsWith("--cache-type")));
});

test("gpu layers are omitted unless set, leaving llama.cpp's auto", () => {
  assert.ok(!launchArgs(base(), 4096).includes("-ngl"));
  assert.equal(launchArgs({ ...base(), gpuLayers: 20 }, 4096)[
    launchArgs({ ...base(), gpuLayers: 20 }, 4096).indexOf("-ngl") + 1
  ], "20");
});

/* ------------------------------------------------------------ extra args -- */

test("quoted arguments survive tokenising", () => {
  assert.deepEqual(tokenize(`--chat-template "a b c" --foo=1`), ["--chat-template", "a b c", "--foo=1"]);
});

test("the arguments Karen owns cannot be overridden", () => {
  for (const flag of ["--host", "--port", "-m", "--api-key", "--kv-unified"]) {
    assert.throws(() => parseExtraArgs(`${flag} something`), ReservedArgError, flag);
  }
});

test("a reserved flag cannot hide behind an equals sign", () => {
  // `--host=0.0.0.0` publishes an unauthenticated model server to the network
  // just as surely as `--host 0.0.0.0` does.
  assert.throws(() => parseExtraArgs("--host=0.0.0.0"), ReservedArgError);
});

test("anything else is passed through untouched", () => {
  assert.deepEqual(parseExtraArgs("--mlock -t 8"), ["--mlock", "-t", "8"]);
  assert.deepEqual(parseExtraArgs("   "), []);
  assert.deepEqual(parseExtraArgs(undefined), []);
});

/* -------------------------------------------------------------- the cost -- */

test("the cache cost does not depend on the slot count", () => {
  // The point of the unified cache: raising concurrency costs bookkeeping, not
  // gigabytes. Before this, `-np 2` doubled the allocation silently.
  const machine = { vramBytes: 24 * GIB, ramBytes: 64 * GIB };
  const one = budgetFor(17 * GIB, machine, { ...base(), context: 32768, slots: 1 }, QWEN30B);
  const four = budgetFor(17 * GIB, machine, { ...base(), context: 32768, slots: 4 }, QWEN30B);
  assert.equal(one.cacheBytes, four.cacheBytes);
  assert.equal(one.totalBytes, four.totalBytes);
});

test("the breakdown adds up to the total it is printed beside", () => {
  const b = budgetFor(17 * GIB, { vramBytes: 24 * GIB, ramBytes: 64 * GIB }, { ...base(), context: 8192 }, QWEN30B);
  assert.equal(b.weightsBytes + b.cacheBytes + b.overheadBytes, b.totalBytes);
});

test("a quantised cache costs what the block layout says, not the round number", () => {
  const machine = { vramBytes: 24 * GIB, ramBytes: 64 * GIB };
  const full = budgetFor(17 * GIB, machine, { ...base(), context: 32768, cacheType: "f16" }, QWEN30B);
  const half = budgetFor(17 * GIB, machine, { ...base(), context: 32768, cacheType: "q8_0" }, QWEN30B);

  // q8_0 is 34 bytes per 32 values, not 32 -- a hair over half, never exactly.
  assert.ok(half.cacheBytes > full.cacheBytes / 2);
  assert.ok(half.cacheBytes < full.cacheBytes * 0.55);
  assert.equal(bytesPerElement("q8_0"), 34 / 32);
});

test("the cache Karen used to ignore is the size of the model", () => {
  // 48 layers x 4 kv heads x 128 wide, K and V, fp16 => 98304 bytes a token.
  // At the 8192 Karen assumed: 0.75 GB. At the 262144 it actually launched with
  // (`-c 0 -np 2` on a 128k model): 24 GB. This is the bug the module exists for.
  const machine = { vramBytes: 24 * GIB, ramBytes: 64 * GIB };
  const shown = budgetFor(17 * GIB, machine, { ...base(), context: 8192 }, QWEN30B);
  const launched = budgetFor(17 * GIB, machine, { ...base(), context: 262144 }, QWEN30B);

  assert.ok(shown.cacheBytes / GIB < 1);
  assert.ok(launched.cacheBytes / GIB > 20);
  assert.equal(shown.verdict, "gpu");
  assert.notEqual(launched.verdict, "gpu");
});

/* ---------------------------------------------------------------- choices -- */

test("the ladder stops at the model's trained context", () => {
  const choices = contextChoices({ ...QWEN30B, contextLength: 8192 });
  assert.deepEqual(choices, [2048, 4096, 8192]);
});

test("a model trained on an off-ladder length is still offered its ceiling", () => {
  const choices = contextChoices({ ...QWEN30B, contextLength: 6000 });
  assert.deepEqual(choices, [2048, 4096, 6000]);
});

test("a model with no readable header still offers something", () => {
  assert.ok(contextChoices(undefined).length > 0);
});

test("auto picks the largest rung that fits in VRAM, not in swap", () => {
  // 8 GB card, 64 GB of RAM: the answer must be sized to the card. Choosing a
  // context that only fits by spilling into system memory is not a favour.
  const machine = { vramBytes: 8 * GIB, ramBytes: 64 * GIB };
  const context = autoContext(4 * GIB, machine, base(), QWEN30B);
  const fits = budgetFor(4 * GIB, machine, { ...base(), context }, QWEN30B);
  assert.ok(fits.totalBytes <= machine.vramBytes, `${context} should fit in VRAM`);

  const next = contextChoices(QWEN30B)[contextChoices(QWEN30B).indexOf(context) + 1];
  if (next) {
    const over = budgetFor(4 * GIB, machine, { ...base(), context: next }, QWEN30B);
    assert.ok(over.totalBytes > machine.vramBytes, "auto should have taken the next rung up");
  }
});

test("a quantised cache buys a longer context", () => {
  const machine = { vramBytes: 8 * GIB, ramBytes: 64 * GIB };
  const full = autoContext(4 * GIB, machine, { ...base(), cacheType: "f16" }, QWEN30B);
  const quarter = autoContext(4 * GIB, machine, { ...base(), cacheType: "q4_0" }, QWEN30B);
  assert.ok(quarter > full, `${quarter} should exceed ${full}`);
});

test("a machine with no GPU is measured against its RAM", () => {
  const b = budgetFor(4 * GIB, { ramBytes: 16 * GIB }, { ...base(), context: 4096 }, QWEN30B);
  assert.equal(b.budgetBytes, 16 * GIB);
  assert.ok(b.headroomBytes > 0);
});
