/**
 * Reading a model's shape out of its header.
 *
 * The numbers asserted below are the real ones from
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, read over a Range request while
 * this was written: 48 layers, 32 attention heads, 4 KV heads, 128-wide, and a
 * 262144 trained context. The grouped-query gap between 32 and 4 is the whole
 * reason this module exists -- sizing the cache off `head_count` would
 * overestimate by eight times.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { modelShape, parseGguf, GgufError } from "../src/core/runtime/gguf.ts";
import { kvCacheBytes } from "../src/core/runtime/fit.ts";

/* --- a minimal GGUF writer, so the fixture is a real file rather than a mock --- */

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function str(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat([u64(bytes.length), bytes]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** type 4 = UINT32, type 8 = STRING */
function kvU32(key: string, value: number): Uint8Array {
  return concat([str(key), u32(4), u32(value)]);
}
function kvStr(key: string, value: string): Uint8Array {
  return concat([str(key), u32(8), str(value)]);
}

function fixture(pairs: Uint8Array[]): Uint8Array {
  return concat([
    new Uint8Array([0x47, 0x47, 0x55, 0x46]), // "GGUF"
    u32(3),
    u64(579),
    u64(pairs.length),
    ...pairs,
  ]);
}

const QWEN = [
  kvStr("general.architecture", "qwen3moe"),
  kvStr("general.name", "Qwen3-Coder-30B-A3B-Instruct"),
  kvU32("qwen3moe.block_count", 48),
  kvU32("qwen3moe.embedding_length", 2048),
  kvU32("qwen3moe.attention.head_count", 32),
  kvU32("qwen3moe.attention.head_count_kv", 4),
  kvU32("qwen3moe.attention.key_length", 128),
  kvU32("qwen3moe.attention.value_length", 128),
  kvU32("qwen3moe.context_length", 262144),
  kvStr("tokenizer.chat_template", "{% for m in messages %}…{% endfor %}"),
];

test("a real model's shape comes out of the header", () => {
  const header = parseGguf(fixture(QWEN));
  assert.equal(header.version, 3);
  assert.equal(header.tensorCount, 579);
  assert.equal(header.truncated, false);

  const shape = modelShape(header);
  assert.equal(shape.architecture, "qwen3moe");
  assert.equal(shape.layers, 48);
  assert.equal(shape.headCount, 32);
  assert.equal(shape.headCountKv, 4);
  assert.equal(shape.keyLength, 128);
  assert.equal(shape.contextLength, 262144);
  assert.equal(shape.hasChatTemplate, true);
});

test("a truncated header yields what it can and admits the rest is unknown", () => {
  // This is the normal case over the network: a modern vocabulary makes the
  // header tens of megabytes, and the fields worth having are written first.
  const full = fixture(QWEN);
  const short = full.subarray(0, full.length - 40);

  const header = parseGguf(short);
  assert.equal(header.truncated, true);
  const shape = modelShape(header);
  assert.equal(shape.layers, 48, "the shape survives a partial read");
  // Crucially NOT false: a model whose template we did not reach still has one,
  // and reporting "no chat template" would wrongly condemn it.
  assert.equal(shape.hasChatTemplate, undefined);
});

test("something that is not a GGUF file says so", () => {
  assert.throws(() => parseGguf(new TextEncoder().encode("<!DOCTYPE html><html>")), GgufError);
});

test("a corrupt length is refused rather than allocated", () => {
  const evil = concat([
    new Uint8Array([0x47, 0x47, 0x55, 0x46]),
    u32(3), u64(1), u64(1),
    u64(2 ** 40), // a key claiming to be a terabyte long
  ]);
  assert.throws(() => parseGguf(evil), /implausible/);
});

test("head_count_kv given per layer is taken at its maximum", () => {
  // Some models vary it by layer; the cache has to be sized for the largest.
  const arr = concat([str("test.attention.head_count_kv"), u32(9), u32(4), u64(3), u32(2), u32(8), u32(4)]);
  const header = parseGguf(fixture([kvStr("general.architecture", "test"), arr]));
  assert.equal(modelShape(header).headCountKv, 8);
});

/* type 5 = INT32, type 6 = FLOAT32 */
function kvI32(key: string, value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value, true);
  return concat([str(key), u32(5), b]);
}
function kvF32(key: string, value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, value, true);
  return concat([str(key), u32(6), b]);
}

/**
 * The bug this guards against read every signed and floating value from byte
 * zero of the file rather than from the cursor, because `Buffer.prototype.slice`
 * aliases `subarray` and does not copy. It only bit when the input was a Node
 * Buffer -- which is what both callers pass, since one reads from disk and the
 * other from a fetch -- so a suite built entirely on Uint8Array never saw it.
 * Every model then reported a KV head count of 1179993927: the letters `GGUF`.
 */
test("a header read from a Node Buffer parses the same as from a Uint8Array", () => {
  const pairs = [
    kvStr("general.architecture", "test"),
    kvU32("test.block_count", 32),
    kvI32("test.attention.head_count_kv", 8),
    kvF32("test.attention.layer_norm_rms_epsilon", 1e-5),
    kvI32("general.sampling.top_k", -1),
  ];
  const bytes = fixture(pairs);
  const asBuffer = Buffer.from(bytes.buffer.slice(0), bytes.byteOffset, bytes.byteLength);

  for (const input of [bytes, asBuffer]) {
    const m = parseGguf(input).metadata;
    assert.equal(m.get("test.attention.head_count_kv"), 8);
    assert.equal(m.get("general.sampling.top_k"), -1);
    assert.ok(Math.abs(Number(m.get("test.attention.layer_norm_rms_epsilon")) - 1e-5) < 1e-9);
  }
});

test("a hybrid model keeps its per-layer KV widths, not just the peak", () => {
  // LFM2 writes a zero for every convolution layer. Sizing 30 layers at the
  // widest one claimed three times the cache the model actually allocates.
  const counts = [0, 0, 8, 0, 0, 8];
  const arr = concat([
    str("test.attention.head_count_kv"),
    u32(9),
    u32(4),
    u64(counts.length),
    ...counts.map(u32),
  ]);
  const shape = modelShape(parseGguf(fixture([kvStr("general.architecture", "test"), arr])));
  assert.equal(shape.headCountKv, 8);
  assert.deepEqual(shape.headCountKvPerLayer, counts);
});

test("a uniform per-layer list is not treated as hybrid", () => {
  const arr = concat([str("test.attention.head_count_kv"), u32(9), u32(4), u64(3), u32(4), u32(4), u32(4)]);
  const shape = modelShape(parseGguf(fixture([kvStr("general.architecture", "test"), arr])));
  assert.equal(shape.headCountKv, 4);
  assert.equal(shape.headCountKvPerLayer, undefined);
});

/**
 * The measured case this module exists for: LFM2.5-2.6B, read this session
 * off the real file. 22 of its 30 layers are convolution and keep no cache at
 * all -- sizing the whole model at `layers x max` overstates the cache by
 * about 3.75x, which is not a rounding error, it is the difference between a
 * window that fits on the card and one that spills to system memory.
 */
test("a hybrid model's real KV cost is a fraction of the flat estimate", () => {
  const counts = [
    0, 0, 8, 0, 0, 8, 0, 0, 0, 8, 0, 0, 8, 0, 0,
    8, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0, 0, 0, 0,
  ]; // 30 layers, 8 attend -- LFM2.5-2.6B's own head_count_kv array
  const arr = concat([
    str("lfm2.attention.head_count_kv"),
    u32(9),
    u32(4),
    u64(counts.length),
    ...counts.map(u32),
  ]);
  const shape = modelShape(parseGguf(fixture([
    kvStr("general.architecture", "lfm2"),
    kvU32("lfm2.block_count", counts.length),
    kvU32("lfm2.attention.head_count", 32),
    kvU32("lfm2.attention.key_length", 64),
    kvU32("lfm2.attention.value_length", 64),
    arr,
  ])));
  assert.deepEqual(shape.headCountKvPerLayer, counts);

  const { headCountKvPerLayer: _perLayer, ...flatShape } = shape;
  const real = kvCacheBytes(shape, 131072)!;
  const flat = kvCacheBytes(flatShape, 131072)!;
  assert.ok(real < flat, "the per-layer shape must cost less than the flat estimate");
  assert.ok(flat / real > 3.5, `expected roughly a 3.75x overstatement, got ${(flat / real).toFixed(2)}x`);
});

test("a missing head dimension falls back to embedding_length / head_count", () => {
  // Neither of these two real files (LFM2.5-2.6B, SmolLM2-135M) states
  // key_length or value_length directly; kvCacheBytes has to derive it.
  const header = parseGguf(fixture([
    kvStr("general.architecture", "test"),
    kvU32("test.block_count", 30),
    kvU32("test.embedding_length", 2048),
    kvU32("test.attention.head_count", 32),
    kvU32("test.attention.head_count_kv", 8),
  ]));
  const shape = modelShape(header);
  assert.equal(shape.keyLength, undefined);
  assert.equal(shape.valueLength, undefined);
  // 2048 / 32 = 64, a plausible head dimension -- not NaN, not undefined.
  assert.equal(kvCacheBytes(shape, 8192, 2), 8 * 30 * 64 * 8192 * 2 * 2);
});
