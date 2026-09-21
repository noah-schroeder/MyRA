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

import {
  autoContext, CONTEXT_LADDER, fitModel, knownMachine, kvCacheBytes, largestContext, memoryBudget,
  quantRank,
} from "../src/core/runtime/fit.ts";
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

/*
 * Choosing the window to load with, and leaving room.
 *
 * The buffer is not a preference. A probe asked lemond for a 1,000,000-token
 * window on a model whose ceiling is 131,072; the daemon passed it straight to
 * `llama-server --ctx-size` without clamping, and the OOM killer took the
 * process. So the arithmetic has to bind, the trained length has to bind, and
 * what is left of the card after everything else on it has to bind too.
 */

/** 16 GB card, 64 GB of system memory, and an 11 GB model file. */
const CARD = { vramBytes: 16 * GIB, ramBytes: 64 * GIB };
/** An 8 GB card beside 16 GB of system memory: small enough that the memory
 *  budget binds before the model's trained length does, which is what the
 *  tests below below need in order to say anything about the budget at all. */
const SMALL_CARD = { vramBytes: 8 * GIB, ramBytes: 16 * GIB };
const FILE = 11 * GIB;

test("uses system memory to make up what a small card cannot hold alone", () => {
  const tightCard = { vramBytes: 4 * GIB, ramBytes: 64 * GIB };
  const auto = autoContext({ fileBytes: FILE, machine: tightCard, shape: QWEN });
  /* 4 GB of VRAM alone could not hold an 11 GB file, let alone any cache on
     top of it -- llama-server's own `--fit` is what actually places the layers
     that do not fit on the card, and degrades to the processor rather than
     failing, so sizing the window against the whole machine is safe again. */
  assert.equal(auto.tokens, 262144);
  assert.equal(auto.cappedAt, 262144);
  assert.ok(CONTEXT_LADDER.includes(auto.tokens!));
});

test("leaves the last of the machine alone, not just the last of the card", () => {
  const auto = autoContext({ fileBytes: FILE, machine: SMALL_CARD, shape: QWEN });
  const needed = fitModel(FILE, SMALL_CARD, { shape: QWEN, context: auto.tokens! }).requiredBytes;
  /* Room for a compositor, a browser, and an allocator that fragments --
     measured against the combined pool the budget is actually drawn from now. */
  const combined = (SMALL_CARD.vramBytes + SMALL_CARD.ramBytes) * 0.85;
  assert.ok(needed <= combined, `${needed} exceeds the safe share of ${combined}`);
  assert.equal(auto.tokens, 65536);
});

test("stays on the card wherever that is possible at all", () => {
  /* The exact shape of the bug this fixed. Fixing shapes without also fixing
     this would have handed a small model on a big card an enormous window:
     LFM2.5-2.6B on a 32 GB card, with no VRAM-first budget, picks 128k+ tokens
     of cache that needs far more than the card holds and spills most of the
     model itself off it. */
  const HYBRID: ModelShape = {
    architecture: "lfm2",
    layers: 30,
    embeddingLength: 2048,
    headCount: 32,
    headCountKvPerLayer: [0, 0, 8, 0, 0, 8, 0, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0, 0, 0, 0],
    headCountKv: 8,
    keyLength: 64,
    valueLength: 64,
    contextLength: 131072,
    hasChatTemplate: true,
  };
  const bigCard = { vramBytes: 32 * GIB, ramBytes: 32 * GIB };
  const auto = autoContext({ fileBytes: 1.6 * GIB, machine: bigCard, shape: HYBRID });
  const needed = fitModel(1.6 * GIB, bigCard, { shape: HYBRID, context: auto.tokens! }).requiredBytes;
  assert.ok(
    needed <= bigCard.vramBytes * 0.85,
    `${needed} spills past the card's own budget of ${bigCard.vramBytes * 0.85}`,
  );
  assert.ok(auto.why.includes("graphics card") || auto.why.includes("trained for"), auto.why);
});

test("a large model on a large card still fits within the card's own budget, not just the machine's", () => {
  /* The measured case from the report this exists to fix: Qwen3.8-27B on a
     32 GB card. Without the VRAM-first stage this picks 131072 or 262144,
     which needs 48-80 GB and is guaranteed to spill; with it the answer stays
     inside what the card alone can hold. */
  const bigCard = { vramBytes: 32 * GIB, ramBytes: 32 * GIB };
  const auto = autoContext({ fileBytes: 15.2 * GIB, machine: bigCard, shape: QWEN });
  const needed = fitModel(15.2 * GIB, bigCard, { shape: QWEN, context: auto.tokens! }).requiredBytes;
  assert.ok(needed <= bigCard.vramBytes * 0.85, `${needed} exceeds the card's own budget`);
  // 131072 needs 28.6 GiB, over the card's 27.2 GiB budget -- so it must have
  // stopped short of it, the way the old vram+ram budget never would have.
  assert.ok(auto.tokens! < 131072, `expected a window short of what would spill, got ${auto.tokens}`);
});

test("allowOffload opts back into the old vram+ram budget, deliberately", () => {
  /* A wide, low-GQA shape so the KV cache grows fast enough with context to
     show the effect clearly: room for 16k on the card alone, room for 131k
     once the processor's memory is allowed to help hold it. */
  const wide: ModelShape = {
    architecture: "test", layers: 48, headCount: 32, headCountKv: 16,
    keyLength: 128, valueLength: 128, contextLength: 2_000_000, hasChatTemplate: true,
  };
  const card = { vramBytes: 16 * GIB, ramBytes: 64 * GIB };
  const restrained = autoContext({ fileBytes: 4 * GIB, machine: card, shape: wide });
  const spilling = autoContext({ fileBytes: 4 * GIB, machine: card, shape: wide, allowOffload: true });

  assert.equal(restrained.tokens, 16384);
  assert.match(restrained.why, /graphics card/);
  const restrainedNeeds = fitModel(4 * GIB, card, { shape: wide, context: restrained.tokens! }).requiredBytes;
  assert.ok(restrainedNeeds <= card.vramBytes * 0.85, "restrained must not spill off the card");

  assert.equal(spilling.tokens, 131072);
  assert.match(spilling.why, /spilling off the graphics card/);
  const spillingNeeds = fitModel(4 * GIB, card, { shape: wide, context: spilling.tokens! }).requiredBytes;
  assert.ok(spillingNeeds > card.vramBytes * 0.85, "this is meant to demonstrate an actual spill");
  assert.ok(spillingNeeds <= (card.vramBytes + card.ramBytes) * 0.85);

  assert.ok(spilling.tokens! > restrained.tokens!, "allowOffload should be able to pick a longer window");
});

test("memoryBudget sums to exactly what it reports as the total", () => {
  const card = { vramBytes: 16 * GIB, ramBytes: 64 * GIB };
  const budget = memoryBudget(FILE, card, { shape: QWEN, context: 32768 });
  assert.equal(budget.weightsBytes + budget.cacheBytes + budget.overheadBytes, budget.totalBytes);
  assert.equal(budget.budgetBytes - budget.totalBytes, budget.headroomBytes);
});

test("memoryBudget's headroom goes negative rather than the segments rescaling", () => {
  // Deliberately more than the card can hold, so the bar this feeds has to
  // run past its own end -- the rule the CSS this draws with is built on.
  const tinyCard = { vramBytes: 2 * GIB, ramBytes: 64 * GIB };
  const budget = memoryBudget(FILE, tinyCard, { shape: QWEN, context: 32768 });
  assert.ok(budget.headroomBytes < 0, "an 11 GB file on a 2 GB card must not fit");
  assert.equal(budget.budgetBytes, tinyCard.vramBytes, "drawn against VRAM alone by default");
});

test("memoryBudget agrees with fitModel's own breakdown, by construction", () => {
  // The whole point of building it as a projection: a bar and a load must
  // never be able to disagree about what a configuration costs.
  const card = { vramBytes: 16 * GIB, ramBytes: 64 * GIB };
  const fit = fitModel(FILE, card, { shape: QWEN, context: 65536 });
  const budget = memoryBudget(FILE, card, { shape: QWEN, context: 65536 });
  assert.equal(budget.cacheBytes, fit.cacheBytes);
  assert.equal(budget.overheadBytes, fit.overheadBytes);
  assert.equal(budget.totalBytes, fit.requiredBytes);
  assert.equal(budget.verdict, fit.verdict);
});

test("memoryBudget draws against VRAM alone unless allowOffload is set", () => {
  const card = { vramBytes: 16 * GIB, ramBytes: 64 * GIB };
  const restrained = memoryBudget(FILE, card, { shape: QWEN, context: 32768 });
  const spilling = memoryBudget(FILE, card, { shape: QWEN, context: 32768, allowOffload: true });
  assert.equal(restrained.budgetBytes, 16 * GIB);
  assert.equal(spilling.budgetBytes, 16 * GIB + 64 * GIB);
});

test("knownMachine tells a probe that has not answered from a real machine with none", () => {
  // The renderer's `useState<Machine>({ ramBytes: 0 })` initialiser, standing
  // in for `lemonadeInfo()` before it resolves -- and forever, if it fails.
  assert.equal(knownMachine({ ramBytes: 0 }), false);
  assert.equal(knownMachine({ ramBytes: 32 * GIB }), true);
  // VRAM alone counts too: a machine could in principle report a card with no
  // RAM figure attached, and that is still a real answer, not an unanswered one.
  assert.equal(knownMachine({ ramBytes: 0, vramBytes: 16 * GIB }), true);
});

test("never goes above what the model was trained for", () => {
  const small = { ...QWEN, contextLength: 8192 };
  const auto = autoContext({ fileBytes: 1 * GIB, machine: CARD, shape: small });
  assert.equal(auto.tokens, 8192);
  assert.equal(auto.cappedAt, 8192);
});

test("never goes above the ceiling the daemon reports", () => {
  /* `/models` carries max_context_window per model, so this needs no guessing
     and no network -- measured against lemond 11.8.0. */
  const auto = autoContext({ fileBytes: 1 * GIB, machine: CARD, shape: QWEN, ceiling: 16384 });
  assert.equal(auto.tokens, 16384);
});

test("writes down nothing at all when even the floor will not fit", () => {
  const tiny = { vramBytes: 8 * GIB, ramBytes: 16 * GIB };
  const huge = 30 * GIB;
  const auto = autoContext({ fileBytes: huge, machine: tiny, shape: QWEN });
  /* The daemon's own default stands. A number written here that stops the model
     loading is worse than the 4,096 this feature exists to improve on. */
  assert.equal(auto.tokens, undefined);
  assert.match(auto.why, /will not load|does not leave room/);
});

test("falls back to the floor, marked as a guess, when the shape is unknown", () => {
  const auto = autoContext({ fileBytes: 2 * GIB, machine: CARD });
  assert.equal(auto.tokens, 8192);
  assert.equal(auto.estimated, true);
  assert.match(auto.why, /could not read this model's shape/);
});

test("does not hand the floor to a model that cannot hold it either", () => {
  const auto = autoContext({ fileBytes: 30 * GIB, machine: { vramBytes: 8 * GIB, ramBytes: 8 * GIB } });
  assert.equal(auto.tokens, undefined);
  assert.equal(auto.estimated, true);
});

test("a quantised KV cache buys a longer window, and the sizing knows it", () => {
  /* SMALL_CARD, not CARD: on the bigger machine the model's own trained length
     is already the binding limit at full precision, so quantising the cache
     would have nowhere left to buy room and the comparison would prove
     nothing. */
  const full = autoContext({ fileBytes: FILE, machine: SMALL_CARD, shape: QWEN });
  const half = autoContext({ fileBytes: FILE, machine: SMALL_CARD, shape: QWEN, bytesPerElement: 1 });
  assert.ok(half.tokens! > full.tokens!, `${half.tokens} should beat ${full.tokens}`);
});

test("largestContext still answers the old question the old way", () => {
  /* The default path is unchanged: existing callers ask "will this run", and
     the budget for that is still the whole machine. */
  assert.equal(largestContext(FILE, CARD, QWEN), largestContext(FILE, CARD, QWEN, {}));
});
