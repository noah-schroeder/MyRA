/**
 * Reading a GGUF file's metadata header.
 *
 * The header sits at the very start of the file, which is the useful part: a
 * Range request for the first few megabytes tells us a model's layer count,
 * attention shape, trained context length and whether it carries a chat
 * template -- **before** committing to a 15 GB download.
 *
 * That is the difference between "this file is 8 GB and you have 8 GB of VRAM,
 * good luck" and an honest answer, because the KV cache is not in the file
 * size and at a long context it is not small. A 30k-token context on a large
 * model can want several gigabytes of its own.
 *
 * Format reference: magic `GGUF`, u32 version, u64 tensor count, u64 metadata
 * count, then that many key/value pairs. Values are typed; arrays carry an
 * element type and a length. Everything is little-endian.
 */

export class GgufError extends Error {
  override readonly name: string = "GgufError";
}

/** Ran out of bytes mid-header. Distinct so a caller can fetch more and retry. */
export class GgufTruncated extends GgufError {
  override readonly name = "GgufTruncated";
}

const MAGIC = 0x46554747; // "GGUF" little-endian

/* A const object rather than an enum: these files are loaded by Node's
 * type-stripping, which rejects `enum` outright as real emit. */
const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const;

export type GgufValue = number | bigint | boolean | string | GgufValue[];

/** A cursor that refuses to read past the end, so a truncated header says so. */
class Reader {
  #view: DataView;
  #buf: Uint8Array;
  #offset = 0;
  /* Explicit field assignment, not a parameter property: type-stripping treats
   * `constructor(private buf)` as real emit and refuses it. Same reason as
   * LlmError in core/llm/chat.ts. */
  constructor(buf: Uint8Array) {
    this.#buf = buf;
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get offset(): number {
    return this.#offset;
  }
  #need(n: number): void {
    if (this.#offset + n > this.#buf.byteLength) {
      throw new GgufTruncated("the GGUF header is longer than the bytes provided");
    }
  }
  u32(): number {
    this.#need(4);
    const v = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return v;
  }
  u64(): bigint {
    this.#need(8);
    const v = this.#view.getBigUint64(this.#offset, true);
    this.#offset += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.#need(n);
    const out = this.#buf.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }
  /*
   * Every scalar reads through the one DataView, positioned by the cursor.
   *
   * The previous version copied the bytes out and built a fresh DataView over
   * them -- `new DataView(this.bytes(4).slice().buffer)`. That is correct for a
   * plain Uint8Array and silently wrong for a Node Buffer, because
   * `Buffer.prototype.slice` is an alias for `subarray` and does not copy: the
   * `.buffer` it hands back is the whole file, so every signed and floating
   * value in the header was decoded from byte 0 -- the letters `GGUF`. It read
   * as 1179993927 as an int and 13649.82 as a float, and those two numbers
   * appeared wherever a model stated a head count, an epsilon or a rope base.
   * Unsigned reads were unaffected, which is why layer counts looked right and
   * only the fit arithmetic came out absurd.
   */
  #scalar<T>(size: number, read: (view: DataView, at: number) => T): T {
    this.#need(size);
    const v = read(this.#view, this.#offset);
    this.#offset += size;
    return v;
  }
  string(): string {
    const len = Number(this.u64());
    // A corrupt length would otherwise try to allocate the whole address space.
    if (len < 0 || len > 1 << 24) throw new GgufError("implausible string length in GGUF header");
    return new TextDecoder().decode(this.bytes(len));
  }
  value(type: number): GgufValue {
    switch (type) {
      case T.UINT8: return this.#scalar(1, (v, at) => v.getUint8(at));
      case T.INT8: return this.#scalar(1, (v, at) => v.getInt8(at));
      case T.UINT16: return this.#scalar(2, (v, at) => v.getUint16(at, true));
      case T.INT16: return this.#scalar(2, (v, at) => v.getInt16(at, true));
      case T.UINT32: return this.u32();
      case T.INT32: return this.#scalar(4, (v, at) => v.getInt32(at, true));
      case T.FLOAT32: return this.#scalar(4, (v, at) => v.getFloat32(at, true));
      case T.BOOL: return this.#scalar(1, (v, at) => v.getUint8(at) !== 0);
      case T.STRING: return this.string();
      case T.UINT64: return this.u64();
      case T.INT64: return this.#scalar(8, (v, at) => v.getBigInt64(at, true));
      case T.FLOAT64: return this.#scalar(8, (v, at) => v.getFloat64(at, true));
      case T.ARRAY: {
        const elem = this.u32();
        const len = Number(this.u64());
        if (len < 0 || len > 1 << 26) throw new GgufError("implausible array length in GGUF header");
        const out: GgufValue[] = [];
        for (let i = 0; i < len; i++) out.push(this.value(elem));
        return out;
      }
      default:
        throw new GgufError(`unknown GGUF value type ${type}`);
    }
  }
}

export interface GgufHeader {
  version: number;
  tensorCount: number;
  metadata: Map<string, GgufValue>;
  /** True when the bytes ran out before every key was read. */
  truncated: boolean;
}

/**
 * Parse as much of the header as the given bytes contain.
 *
 * Partial by design. A modern model's header is dominated by
 * `tokenizer.ggml.tokens` -- a quarter of a million strings, tens of megabytes
 * -- and downloading all of it to learn a layer count would defeat the purpose
 * of reading the header at all. In practice `general.*` and `<arch>.*` are
 * written before the tokenizer, so a couple of megabytes answers every question
 * about the model's shape. `tokenizer.chat_template` sits after the vocabulary
 * and is the one field a small read will usually miss, which is why
 * `hasChatTemplate` is reported as unknown rather than false when truncated.
 */
export function parseGguf(buf: Uint8Array): GgufHeader {
  const r = new Reader(buf);
  if (r.u32() !== MAGIC) throw new GgufError("not a GGUF file (bad magic)");
  const version = r.u32();
  if (version < 2 || version > 3) throw new GgufError(`unsupported GGUF version ${version}`);
  const tensorCount = Number(r.u64());
  const kvCount = Number(r.u64());
  if (kvCount < 0 || kvCount > 100_000) throw new GgufError("implausible metadata count");

  const metadata = new Map<string, GgufValue>();
  let truncated = false;
  for (let i = 0; i < kvCount; i++) {
    try {
      const key = r.string();
      const type = r.u32();
      metadata.set(key, r.value(type));
    } catch (err) {
      if (err instanceof GgufTruncated) {
        truncated = true;
        break;
      }
      throw err;
    }
  }
  return { version, tensorCount, metadata, truncated };
}

/** The bits of the header that affect how a model is run and sized. */
export interface ModelShape {
  architecture?: string;
  /** Number of transformer blocks. */
  layers?: number;
  embeddingLength?: number;
  headCount?: number;
  /** Grouped-query models have fewer KV heads than attention heads. */
  headCountKv?: number;
  /**
   * Per-layer KV head counts, when the model states them that way.
   *
   * Hybrid architectures (LFM2, Jamba, and the Mamba-attention mixes) put an
   * attention block only every few layers and a convolution or state-space
   * block in between, and write a zero for each layer that keeps no KV cache.
   * Sizing those at `layers x max` overstates the cache by three or four times,
   * which is the difference between telling someone a model runs and telling
   * them it does not.
   */
  headCountKvPerLayer?: number[];
  /** Head dimension, when stated directly rather than implied. */
  keyLength?: number;
  valueLength?: number;
  /** The context the model was trained for -- the ceiling worth offering. */
  contextLength?: number;
  /**
   * Without one, llama.cpp cannot format a conversation and tool calling will
   * not work. `undefined` means the header was read only in part and the answer
   * is genuinely unknown -- which must not be shown to the user as "no".
   */
  hasChatTemplate: boolean | undefined;
  name?: string;
}

function numbers(v: GgufValue | undefined): number[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out = v
    .map((x) => (typeof x === "bigint" ? Number(x) : x))
    .filter((x): x is number => typeof x === "number");
  return out.length === v.length ? out : undefined;
}

function num(v: GgufValue | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  // head_count_kv is an array on models with per-layer variation. The largest
  // is the widest any single layer gets; the per-layer list is kept separately
  // for anything that needs the total rather than the peak.
  const nums = numbers(v);
  if (nums?.length) return Math.max(...nums);
  return undefined;
}

export function modelShape(header: GgufHeader): ModelShape {
  const m = header.metadata;
  const arch = typeof m.get("general.architecture") === "string" ? (m.get("general.architecture") as string) : undefined;
  const at = (suffix: string): number | undefined => (arch ? num(m.get(`${arch}.${suffix}`)) : undefined);

  const name = m.get("general.name");
  const template = m.has("tokenizer.chat_template") ? true : header.truncated ? undefined : false;
  const shape: ModelShape = { hasChatTemplate: template };
  if (arch !== undefined) shape.architecture = arch;
  if (typeof name === "string") shape.name = name;

  const fields: [keyof ModelShape, number | undefined][] = [
    ["layers", at("block_count")],
    ["embeddingLength", at("embedding_length")],
    ["headCount", at("attention.head_count")],
    ["headCountKv", at("attention.head_count_kv")],
    ["keyLength", at("attention.key_length")],
    ["valueLength", at("attention.value_length")],
    ["contextLength", at("context_length")],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined) (shape as unknown as Record<string, number>)[key] = value;
  }

  const perLayer = arch ? numbers(m.get(`${arch}.attention.head_count_kv`)) : undefined;
  if (perLayer && perLayer.some((n) => n !== perLayer[0])) shape.headCountKvPerLayer = perLayer;
  return shape;
}
