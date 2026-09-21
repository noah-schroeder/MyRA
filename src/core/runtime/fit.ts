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

/**
 * As much of a model's architecture as affects the KV cache.
 *
 * Two producers, in `main/runtime/`: `readShapeFromFile` in `ggufFile.ts` reads
 * it straight off the model's own GGUF header, and `shapeFromConfig` in
 * `modelFacts.ts` reads it from a Hugging Face `config.json` when the file is
 * not yet on disk. The GGUF reading is preferred where both are available --
 * see `gguf.ts`'s own header comment for why -- and `modelFacts.ts` records
 * which one answered, so a `config.json` guess is never allowed to overwrite a
 * measurement taken from the file that actually loads.
 *
 * Absent entirely means neither has run, or both came back empty -- a repo with
 * no `base_model` and no local file yet, most often. Every estimate here then
 * takes the rule-of-thumb path and says so via `estimated`.
 */
export interface ModelShape {
  architecture?: string;
  layers?: number;
  embeddingLength?: number;
  headCount?: number;
  /** Grouped-query models have fewer KV heads than attention heads. */
  headCountKv?: number;
  /** Per-layer KV head counts, for hybrids that keep no cache on some layers. */
  headCountKvPerLayer?: number[];
  keyLength?: number;
  valueLength?: number;
  contextLength?: number;
  hasChatTemplate?: boolean | undefined;
  name?: string;
  /**
   * How many experts a mixture-of-experts model routes between, when the
   * config says so. Informative only -- `--n-cpu-moe` offloads by layer, not
   * by individual expert, so this is not a bound on anything; it is what tells
   * the settings panel whether to offer that control at all.
   */
  experts?: number;
}

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
export function kvCacheBytes(
  shape: ModelShape,
  context: number,
  bytesPerElement: number | undefined = 2,
): number | undefined {
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

  /* Hybrid models cache nothing on their convolution layers, so the total is
     the sum of the per-layer widths rather than the layer count times the
     widest one. Falls back to the flat product when the header states a single
     number, which is every conventional transformer. */
  const heads = shape.headCountKvPerLayer?.length
    ? shape.headCountKvPerLayer.reduce((a, b) => a + b, 0)
    : layers * kvHeads;
  if (!heads) return undefined;

  const kBytes = heads * headDim * context * bytesPerElement;
  const vDim = shape.valueLength ?? headDim;
  const vBytes = heads * vDim * context * bytesPerElement;
  return kBytes + vBytes;
}

export type Verdict = "gpu" | "partial" | "cpu" | "too-large";

export interface Fit {
  verdict: Verdict;
  /** What the whole thing needs: weights, cache and overhead. */
  requiredBytes: number;
  /** Present when the model's shape was known, so the estimate is exact. */
  kvBytes?: number;
  /** The cache figure actually used: `kvBytes`, or the rule of thumb. */
  cacheBytes: number;
  /** Compute buffers, context tensors and fragmentation. */
  overheadBytes: number;
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
 * Whether `lemonadeInfo()` has actually answered, as opposed to a caller's
 * `useState` initialiser still standing in for it.
 *
 * `{ ramBytes: 0 }` is that initialiser, and also the state a failed or
 * pending probe leaves behind forever -- indistinguishable from a real
 * machine with no RAM, which does not exist. `memoryBudget` against it
 * returns `budgetBytes: 0`, and a bar drawn from that renders "does not fit"
 * for a model that is loaded and running fine. Callers that draw a bar, or
 * decide whether a context size fits, ask this first rather than reading
 * `machine.ramBytes` directly -- a truthiness test on RAM alone wrongly
 * suppresses a machine that reports VRAM only.
 */
export function knownMachine(m: Machine): boolean {
  return Boolean(m.ramBytes || m.vramBytes);
}

/**
 * When the GGUF header was not read, assume a cache proportional to the
 * weights. Crude, and marked as such in the result so the UI can hedge.
 */
const ESTIMATED_CACHE_FRACTION = 0.2;

export function fitModel(
  fileBytes: number,
  machine: Machine,
  opts: { shape?: ModelShape; context?: number; bytesPerElement?: number } = {},
): Fit {
  const context = opts.context ?? 8192;
  const kv = opts.shape ? kvCacheBytes(opts.shape, context, opts.bytesPerElement) : undefined;
  const estimated = kv === undefined;
  const cache = kv ?? fileBytes * ESTIMATED_CACHE_FRACTION;
  const overhead = OVERHEAD_BYTES + fileBytes * OVERHEAD_FRACTION;
  const required = fileBytes + cache + overhead;
  /* Spread into all four returns below rather than repeated: the breakdown and
     the total have to come from the same arithmetic, or a budget bar can add up
     to something other than the number printed beside it. */
  const parts = { cacheBytes: cache, overheadBytes: overhead };

  const gib = (n: number): string => `${(n / GIB).toFixed(1)} GB`;
  const detail = `Needs about ${gib(required)}${estimated ? " (estimated)" : ""}`;

  if (machine.vramBytes !== undefined && required <= machine.vramBytes) {
    return {
      verdict: "gpu",
      requiredBytes: required,
      ...(kv !== undefined ? { kvBytes: kv } : {}),
      ...parts,
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
      ...parts,
      estimated,
      label: `Fits with some layers on the processor — slower. ${detail}.`,
    };
  }

  if (required <= machine.ramBytes) {
    return {
      verdict: "cpu",
      requiredBytes: required,
      ...(kv !== undefined ? { kvBytes: kv } : {}),
      ...parts,
      estimated,
      label: `Runs on the processor — much slower. ${detail}.`,
    };
  }

  return {
    verdict: "too-large",
    requiredBytes: required,
    ...(kv !== undefined ? { kvBytes: kv } : {}),
    ...parts,
    estimated,
    label: `Too large for this machine — needs about ${gib(required)}${estimated ? " (estimated)" : ""}, and there is ${gib(machine.ramBytes)} of memory.`,
  };
}

/**
 * The same breakdown `fitModel` computes, drawn against a fixed budget rather
 * than turned into a verdict -- what a memory bar needs, since a bar cannot
 * render "gpu" | "partial" | "cpu" | "too-large", it needs the numbers those
 * verdicts were computed FROM.
 *
 * Deliberately a thin projection over `fitModel` rather than its own
 * arithmetic: `fitModel`'s own comment already names the failure two separate
 * calculations invites -- "the breakdown and the total have to come from the
 * same arithmetic, or a budget bar can add up to something other than the
 * number printed beside it" -- and this is that promise kept. Any bar drawn
 * from `MemoryBudget` and any load sized by `fitModel`/`autoContext` are
 * reading the same numbers by construction, not by two authors remembering to
 * agree.
 */
export interface MemoryBudget {
  weightsBytes: number;
  cacheBytes: number;
  overheadBytes: number;
  /** weights + cache + overhead -- always the sum of the three above. */
  totalBytes: number;
  /** What the segments are drawn against: VRAM alone when there is a card. */
  budgetBytes: number;
  /** `budgetBytes - totalBytes`. Negative means it does not fit. */
  headroomBytes: number;
  /** True when the cache figure is a rule of thumb, not a measurement. */
  estimated: boolean;
  verdict: Verdict;
}

/**
 * `budgetBytes` is VRAM alone when there is a card, matching `autoContext`'s
 * own stage-one budget -- a bar drawn against VRAM+RAM would make a window
 * that spills to the processor look exactly like one that fits the card,
 * which is the reading that led to the report this whole file was reworked
 * for. Pass `allowOffload` to draw the bar against the wider budget
 * deliberately, the same flag `autoContext` takes for the same reason.
 */
export function memoryBudget(
  fileBytes: number,
  machine: Machine,
  opts: { shape?: ModelShape; context?: number; bytesPerElement?: number; allowOffload?: boolean } = {},
): MemoryBudget {
  const fit = fitModel(fileBytes, machine, opts);
  const budgetBytes =
    !opts.allowOffload && machine.vramBytes !== undefined
      ? machine.vramBytes
      : machine.vramBytes !== undefined
        ? machine.vramBytes + machine.ramBytes
        : machine.ramBytes;
  return {
    weightsBytes: fileBytes,
    cacheBytes: fit.cacheBytes,
    overheadBytes: fit.overheadBytes,
    totalBytes: fit.requiredBytes,
    budgetBytes,
    headroomBytes: budgetBytes - fit.requiredBytes,
    estimated: fit.estimated,
    verdict: fit.verdict,
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

export function largestContext(
  fileBytes: number,
  machine: Machine,
  shape?: ModelShape,
  opts: {
    /** What the window may be sized against. Default: all memory, as before. */
    budgetBytes?: number;
    /** Never above this, whatever fits. */
    ceiling?: number;
    /** Below this, return nothing rather than a tiny window. */
    floor?: number;
    bytesPerElement?: number;
  } = {},
): number | undefined {
  const ceiling = Math.min(shape?.contextLength ?? Infinity, opts.ceiling ?? Infinity);
  const budget = opts.budgetBytes ?? (machine.vramBytes ?? 0) + machine.ramBytes;
  let best: number | undefined;
  for (const context of CONTEXT_LADDER) {
    if (context > ceiling) break;
    const fit = fitModel(fileBytes, machine, {
      ...(shape ? { shape } : {}),
      context,
      ...(opts.bytesPerElement ? { bytesPerElement: opts.bytesPerElement } : {}),
    });
    if (fit.requiredBytes <= budget) best = context;
    else break;
  }
  return best !== undefined && opts.floor !== undefined && best < opts.floor ? undefined : best;
}

/**
 * How much of the card MyRA is willing to plan to fill.
 *
 * The overhead above is llama.cpp's; this is everything else. Measured the
 * expensive way: a probe asked lemond for a 1,000,000-token window on a model
 * whose ceiling is 131,072, the daemon passed the number straight through to
 * `llama-server --ctx-size` without clamping it, and the OOM killer took the
 * process. A window that fits on paper still has to share the machine with a
 * compositor, a browser, whatever else holds the card, and an allocator that
 * fragments -- so the last sixth is not ours to plan into.
 *
 * The consequence to keep: this only ever makes the chosen window SMALLER.
 * Nothing here can talk a machine into a context it could not otherwise hold.
 */
const SAFETY_FRACTION = 0.85;

export interface AutoContext {
  /**
   * The window to ask for, or nothing at all.
   *
   * Nothing means "leave the daemon's own default alone", which is the honest
   * answer when even the floor will not fit. Writing a number down in that case
   * is how a settings panel becomes the reason a model stops loading.
   */
  tokens?: number | undefined;
  /** True when there is no shape, so this is the floor rather than a calculation. */
  estimated: boolean;
  /** What the model was trained for, when that is known and it bound the answer. */
  cappedAt?: number | undefined;
  /** One sentence, for the panel that offers it. */
  why: string;
}

/**
 * The window to load a model with, on this machine, with room left over.
 *
 * Three bounds, and the answer is the smallest of them: what fits in the safe
 * share of the machine, what the model was trained for, and what the daemon
 * says its ceiling is. The daemon's own default is 4,096 whatever the model
 * can do -- measured, on a model whose ceiling is 131,072 -- which is the
 * reason this exists at all.
 *
 * With no shape there is no honest calculation: `fitModel`'s fallback cache is a
 * fraction of the file size and therefore identical at 4k and at 128k, so it
 * cannot answer this question. The floor is returned instead and flagged
 * `estimated`, which is the same refusal to invent a number that `ContextHint`
 * already makes on screen.
 */
export function autoContext(opts: {
  fileBytes: number;
  machine: Machine;
  shape?: ModelShape | undefined;
  /** `max_context_window`, straight from the daemon's own model list. */
  ceiling?: number | undefined;
  bytesPerElement?: number | undefined;
  floor?: number;
  /**
   * Deliberately trade GPU residency for a longer window.
   *
   * Off is the default, and it is the whole point of the two-stage budget
   * below: left to plan against VRAM and system RAM together, this function
   * happily hands a 2.6B model on a 32 GB card a 128,000-token window that
   * needs 48 GB to hold, which `--fit` then satisfies by spilling most of the
   * model itself to system memory -- measured at roughly a fifteenth the
   * generation speed. That is not a smaller window costing some convenience;
   * it is the model silently leaving the card. `allowOffload` is there for
   * someone who wants a window that large anyway and has weighed the cost --
   * MyRA's own auto-tune never opts into it.
   */
  allowOffload?: boolean;
}): AutoContext {
  const floor = opts.floor ?? 8192;
  const { machine } = opts;
  const machineBudget = Math.floor(((machine.vramBytes ?? 0) + machine.ramBytes) * SAFETY_FRACTION);
  const vramBudget = machine.vramBytes ? Math.floor(machine.vramBytes * SAFETY_FRACTION) : undefined;
  /*
   * Two stages, and which one applies is decided once, up front, by whether
   * even the FLOOR context leaves the whole model on the card.
   *
   * Stage 1, the common case: if the smallest window worth offering already
   * fits in VRAM alone, every larger window `largestContext` might go on to
   * pick also fits there -- a bigger context only ever costs more -- so
   * budgeting against VRAM alone is enough, and it guarantees the model stays
   * off the CPU. This is what makes "the largest window that stays on the
   * card" the actual policy, rather than an accident of the floor happening
   * to be small.
   *
   * Stage 2, the fallback: if even the floor would already spill, the model
   * was always going to be partially offloaded regardless of context size --
   * llama-server's own `-ngl`/`--fit` (default `auto`/`on`, measured against
   * the bundled binary) decides layer placement, and it degrades to CPU
   * offload rather than failing outright. Budgeting against VRAM alone in
   * that case would find nothing fits and return the daemon's poor 4,096
   * default, which is strictly worse than sizing against the whole machine as
   * this always did before. The safety fraction and the hard ceiling below
   * are what actually stop the OOM this always guarded against, whichever
   * pool the budget is drawn from.
   */
  const floorFits = vramBudget !== undefined && fitModel(opts.fileBytes, machine, {
    ...(opts.shape ? { shape: opts.shape } : {}),
    context: floor,
    ...(opts.bytesPerElement ? { bytesPerElement: opts.bytesPerElement } : {}),
  }).requiredBytes <= vramBudget;
  const budget = !opts.allowOffload && floorFits ? vramBudget : machineBudget;
  const ceiling = Math.min(opts.ceiling ?? Infinity, opts.shape?.contextLength ?? Infinity);
  const capped = Number.isFinite(ceiling) ? ceiling : undefined;

  if (!opts.shape) {
    /* The floor, and only if the rule-of-thumb fit allows even that: a 30B on an
       8 GB card must not be handed 8,192 on the grounds that we cannot measure
       it properly. */
    const rough = fitModel(opts.fileBytes, machine, { context: floor });
    const fits = rough.requiredBytes <= budget && floor <= ceiling;
    return {
      ...(fits ? { tokens: floor } : {}),
      estimated: true,
      ...(capped !== undefined ? { cappedAt: capped } : {}),
      why: fits
        ? `About ${floor.toLocaleString()} tokens. MyRA could not read this model's shape, so ` +
          `this is the usual default rather than a measurement.`
        : `Left as the daemon chose it: this model does not leave room for ${floor.toLocaleString()} ` +
          `tokens on this machine, and MyRA will not write down a number that stops it loading.`,
    };
  }

  const best = largestContext(opts.fileBytes, machine, opts.shape, {
    budgetBytes: budget,
    ...(capped !== undefined ? { ceiling: capped } : {}),
    floor,
    ...(opts.bytesPerElement ? { bytesPerElement: opts.bytesPerElement } : {}),
  });

  if (best === undefined) {
    return {
      estimated: false,
      ...(capped !== undefined ? { cappedAt: capped } : {}),
      why:
        `Left as the daemon chose it: ${floor.toLocaleString()} tokens would not fit on this ` +
        `machine with room to spare, and a window that does not fit is a model that will not load.`,
    };
  }

  /* Named honestly, according to which budget actually produced this answer --
     "fits on your graphics card" is a claim `budget === machineBudget` does not
     back, since part of it spilled to the processor to get there. */
  const where =
    budget === vramBudget
      ? "your graphics card"
      : machine.vramBytes
        ? "this machine's memory, spilling off the graphics card"
        : "system memory";
  return {
    tokens: best,
    estimated: false,
    ...(capped !== undefined ? { cappedAt: capped } : {}),
    why:
      best === capped
        ? `${best.toLocaleString()} tokens — everything this model was trained for, and it fits.`
        : `${best.toLocaleString()} tokens — the largest that fits in ${where} with room left for ` +
          `everything else running on it.`,
  };
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
