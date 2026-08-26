/**
 * Will this model run on this machine, and how well?
 *
 * The question a model list has to answer, and the reason the runtime is
 * installed before any model is chosen: Electron reports the GPU vendor but
 * never its memory, so only the `--list-devices` probe knows how much VRAM
 * there is.
 *
 * The naive version compares the file size against VRAM and is wrong in a way
 * that bites hardest on exactly the machines people care about. **The KV cache
 * is not in the file size.** For a 48-layer model with 4 KV heads at a 32k
 * context it is over 3 GB -- larger than the gap between two quantisations. A
 * list that ignores it will confidently recommend a model that then fails to
 * load, which is worse than saying nothing.
 */

import type { ModelShape } from "./gguf.ts";

const GIB = 1024 ** 3;

/**
 * Compute buffers, the context's own tensors, and fragmentation.
 *
 * A margin rather than a measurement: llama.cpp's own overhead depends on
 * batch size and backend, so this is deliberately generous. Being wrong
 * towards "it did not fit" costs a user some speed; being wrong the other way
 * costs them a failed load after a 15 GB download.
 */
const OVERHEAD_BYTES = 512 * 1024 * 1024;
const OVERHEAD_FRACTION = 0.06;

/**
 * Bytes the KV cache needs at a given context length.
 *
 *     2 (one K, one V) x layers x kv_heads x head_dim x context x element size
 *
 * Grouped-query attention is why `headCountKv` matters and `headCount` does
 * not: a model with 32 attention heads and 4 KV heads caches four heads' worth,
 * not thirty-two. Getting this backwards overestimates by 8x.
 */
export function kvCacheBytes(shape: ModelShape, context: number, bytesPerElement = 2): number | undefined {
  const layers = shape.layers;
  if (!layers || !context) return undefined;

  const kvHeads = shape.headCountKv ?? shape.headCount;
  // Head dimension is stated directly on most modern models; otherwise it is
  // the embedding width divided across the attention heads.
  let headDim = shape.keyLength;
  if (headDim === undefined && shape.embeddingLength && shape.headCount) {
    headDim = shape.embeddingLength / shape.headCount;
  }
  if (!kvHeads || !headDim) return undefined;

  const kBytes = layers * kvHeads * headDim * context * bytesPerElement;
  const vDim = shape.valueLength ?? headDim;
  const vBytes = layers * kvHeads * vDim * context * bytesPerElement;
  return kBytes + vBytes;
}

export type Verdict = "gpu" | "partial" | "cpu" | "too-large";

export interface Fit {
  verdict: Verdict;
  /** What the whole thing needs: weights, cache and overhead. */
  requiredBytes: number;
  /** Present when the model's shape was known, so the estimate is exact. */
  kvBytes?: number;
  /** True when `requiredBytes` came from a rule of thumb rather than the header. */
  estimated: boolean;
  /** One line, written for someone who does not know what a quant is. */
  label: string;
}

export interface Machine {
  /** Largest single GPU's memory, from the probe. Absent means no accelerator. */
  vramBytes?: number;
  /** Total system RAM. */
  ramBytes: number;
}

/**
 * When the GGUF header was not read, assume a cache proportional to the
 * weights. Crude, and marked as such in the result so the UI can hedge.
 */
const ESTIMATED_CACHE_FRACTION = 0.2;

export function fitModel(
  fileBytes: number,
  machine: Machine,
  opts: { shape?: ModelShape; context?: number } = {},
): Fit {
  const context = opts.context ?? 8192;
  const kv = opts.shape ? kvCacheBytes(opts.shape, context) : undefined;
  const estimated = kv === undefined;
  const cache = kv ?? fileBytes * ESTIMATED_CACHE_FRACTION;
  const required = fileBytes + cache + OVERHEAD_BYTES + fileBytes * OVERHEAD_FRACTION;

  const gib = (n: number): string => `${(n / GIB).toFixed(1)} GB`;
  const detail = `Needs about ${gib(required)}${estimated ? " (estimated)" : ""}`;

  if (machine.vramBytes !== undefined && required <= machine.vramBytes) {
    return {
      verdict: "gpu",
      requiredBytes: required,
      ...(kv !== undefined ? { kvBytes: kv } : {}),
      estimated,
      label: `Fits on your GPU — fast. ${detail}.`,
    };
  }

  // Partly offloaded still beats CPU-only, but only if the weights that do not
  // fit have somewhere to go.
  if (machine.vramBytes !== undefined && required <= machine.vramBytes + machine.ramBytes) {
    return {
      verdict: "partial",
      requiredBytes: required,
      ...(kv !== undefined ? { kvBytes: kv } : {}),
      estimated,
      label: `Fits with some layers on the processor — slower. ${detail}.`,
    };
  }

  if (required <= machine.ramBytes) {
    return {
      verdict: "cpu",
      requiredBytes: required,
      ...(kv !== undefined ? { kvBytes: kv } : {}),
      estimated,
      label: `Runs on the processor — much slower. ${detail}.`,
    };
  }

  return {
    verdict: "too-large",
    requiredBytes: required,
    ...(kv !== undefined ? { kvBytes: kv } : {}),
    estimated,
    label: `Too large for this machine — needs about ${gib(required)}${estimated ? " (estimated)" : ""}, and there is ${gib(machine.ramBytes)} of memory.`,
  };
}

/**
 * The largest context that still fits, so the server is not started with a
 * setting that will fail to allocate.
 *
 * Searched over the usual power-of-two ladder rather than solved algebraically:
 * the answer is presented to a user and 32768 is a better thing to show than
 * 37412.
 */
export const CONTEXT_LADDER = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

export function largestContext(fileBytes: number, machine: Machine, shape?: ModelShape): number | undefined {
  const ceiling = shape?.contextLength ?? Infinity;
  const budget = (machine.vramBytes ?? 0) + machine.ramBytes;
  let best: number | undefined;
  for (const context of CONTEXT_LADDER) {
    if (context > ceiling) break;
    const fit = fitModel(fileBytes, machine, { ...(shape ? { shape } : {}), context });
    if (fit.requiredBytes <= budget) best = context;
    else break;
  }
  return best;
}

/**
 * Which quantisation to recommend, given several of the same model.
 *
 * The rule of thumb, stated once so the UI can stop teaching it by trial and
 * error: below Q4 quality degrades noticeably, Q4_K_M is the usual default, and
 * above Q6 the gains are small relative to the size.
 */
export function quantRank(filename: string): number {
  const name = filename.toUpperCase();
  const order = ["Q4_K_M", "Q4_K_S", "Q5_K_M", "Q5_K_S", "Q6_K", "IQ4_XS", "IQ4_NL", "Q4_0", "Q8_0", "Q3_K_M", "Q2_K"];
  const index = order.findIndex((q) => name.includes(q));
  return index === -1 ? order.length : index;
}
