/**
 * Turning "32k of context, two conversations, half-precision cache" into flags.
 *
 * llama-server's defaults are not wrong so much as *not what the panel above
 * them says*. Three behaviours, all measured against b10639 rather than assumed,
 * are why this module exists:
 *
 *   - **`-c 0` does not mean "the model's context".** It means the model's
 *     trained context *per slot*, so `-c 0 -np 2` on a 128k model allocates
 *     256k of KV cache. Karen shipped exactly that while telling people the
 *     cache would cost what it costs at 8192 -- out by 32x on the long-context
 *     models people most want.
 *   - **`-c` is a total that gets divided by `-np`**, so asking for 4096 across
 *     2 slots gives each conversation 2048. A control that did that to someone
 *     would be worse than no control.
 *   - **`-kvu` fixes both.** With a unified cache, `-c` is one shared buffer and
 *     every slot sees all of it: `-c 4096 -np 4 -kvu` gives four conversations
 *     4096 each out of one 4096 allocation. So the memory cost stops depending
 *     on the slot count, which is what makes an honest budget readout possible.
 *
 * The trade is real and worth naming: slots share the pool, so several long
 * conversations at once draw from the same buffer rather than each owning one.
 * For an assistant -- one chat, plus short concurrent research stages -- that is
 * the right trade, and it is the difference between a 24 GB allocation and a
 * 12 GB one.
 */

import { CONTEXT_LADDER, fitModel, type Machine, type Verdict } from "./fit.ts";
import type { ModelShape } from "./gguf.ts";

/**
 * KV cache element types, with what one element actually costs.
 *
 * Not the obvious 1 and 0.5: `q8_0` stores 32 values plus an fp16 scale in 34
 * bytes, and `q4_0` packs the same 32 into 18. Using 1.0 and 0.5 would
 * understate the cache by 6% and 12%, which is the wrong direction to be wrong
 * in when the number decides whether a model loads.
 */
export const CACHE_TYPES = [
  { id: "f16", label: "Full", bytesPerElement: 2, hint: "What llama.cpp uses by default" },
  { id: "q8_0", label: "Half", bytesPerElement: 34 / 32, hint: "About half the memory, no visible quality cost" },
  { id: "q4_0", label: "Quarter", bytesPerElement: 18 / 32, hint: "About a quarter, and long contexts start to drift" },
] as const;

export type CacheType = (typeof CACHE_TYPES)[number]["id"];

export function bytesPerElement(type: CacheType): number {
  return CACHE_TYPES.find((c) => c.id === type)?.bytesPerElement ?? 2;
}

export interface LaunchSettings {
  /*
   * The optionals are written `?: T | undefined` rather than `?: T` because
   * undefined is a value this type is *given*, not merely one it may omit:
   * "as much as fits" and "let llama.cpp decide" are choices a person makes,
   * and a patch expressing them has to be able to carry an explicit undefined.
   */
  /** Tokens each conversation gets. Undefined means "whatever fits". */
  context?: number | undefined;
  /** Server slots: how many requests can be in flight at once. */
  slots: number;
  cacheType: CacheType;
  /** Layers on the GPU. Undefined leaves llama.cpp's `auto`, which is right
   *  almost always -- this exists for the machine where it is not. */
  gpuLayers?: number | undefined;
  /** Anything this module did not anticipate, typed by the user. */
  extraArgs?: string | undefined;
}

export const DEFAULT_SLOTS = 2;

export interface Budget {
  weightsBytes: number;
  /** The KV cache at this context, exact when the header was readable. */
  cacheBytes: number;
  /** True when the cache figure is a rule of thumb rather than the header. */
  estimated: boolean;
  overheadBytes: number;
  totalBytes: number;
  /** What it is being measured against: VRAM where there is a GPU, else RAM. */
  budgetBytes: number;
  /** Negative when it does not fit. */
  headroomBytes: number;
  verdict: Verdict;
  /** The context this budget was computed at, resolved from `auto`. */
  context: number;
}

/** The model's own ceiling, and the ladder rungs that do not exceed it. */
export function contextChoices(shape?: ModelShape): number[] {
  const trained = shape?.contextLength;
  const rungs = CONTEXT_LADDER.filter((c) => !trained || c <= trained);
  // A model trained on something that is not a power of two (Gemma's 8192 is,
  // Phi's 131072 is, plenty are not) still deserves its exact ceiling offered.
  if (trained && !rungs.includes(trained)) rungs.push(trained);
  return rungs.length ? rungs : [2048];
}

/**
 * What a given configuration will actually ask the machine for.
 *
 * Slots deliberately do not appear: with `-kvu` the cache is one shared buffer,
 * so raising the slot count costs bookkeeping rather than gigabytes. That is
 * the whole reason the unified cache is not optional here.
 */
export function budgetFor(
  fileBytes: number,
  machine: Machine,
  settings: LaunchSettings,
  shape?: ModelShape,
): Budget {
  const context = settings.context ?? autoContext(fileBytes, machine, settings, shape);
  const elem = bytesPerElement(settings.cacheType);
  const fit = fitModel(fileBytes, machine, {
    ...(shape ? { shape } : {}),
    context,
    bytesPerElement: elem,
  });
  const budgetBytes = machine.vramBytes ?? machine.ramBytes;

  return {
    weightsBytes: fileBytes,
    cacheBytes: fit.cacheBytes,
    estimated: fit.estimated,
    overheadBytes: fit.overheadBytes,
    totalBytes: fit.requiredBytes,
    budgetBytes,
    headroomBytes: budgetBytes - fit.requiredBytes,
    verdict: fit.verdict,
    context,
  };
}

/**
 * The largest rung that still fits, which is what `auto` resolves to.
 *
 * Sized against VRAM where there is a GPU rather than against VRAM plus RAM:
 * a context that only fits by spilling into system memory is a context that
 * makes the model crawl, and picking it *for* someone is not a favour.
 */
export function autoContext(
  fileBytes: number,
  machine: Machine,
  settings: LaunchSettings,
  shape?: ModelShape,
): number {
  const choices = contextChoices(shape);
  const elem = bytesPerElement(settings.cacheType);
  const budget = machine.vramBytes ?? machine.ramBytes;
  let best = choices[0]!;
  for (const context of choices) {
    const fit = fitModel(fileBytes, machine, {
      ...(shape ? { shape } : {}),
      context,
      bytesPerElement: elem,
    });
    if (fit.requiredBytes <= budget) best = context;
    else break;
  }
  return best;
}

export function defaultSettings(): LaunchSettings {
  return { slots: DEFAULT_SLOTS, cacheType: "f16" };
}

/**
 * Flags a user must not be able to set, and why each one matters.
 *
 * `--host` is the dangerous one: llama-server binds loopback because Karen
 * tells it to, and someone pasting `--host 0.0.0.0` into the advanced box
 * would publish an unauthenticated model server to their network without
 * anything on screen saying so. `--api-key` would move the key from the
 * process environment into argv, where `/proc/<pid>/cmdline` makes it readable
 * by every other user on the machine.
 */
export const RESERVED_ARGS = [
  "-m", "--model", "--host", "--port", "--api-key", "--api-key-file", "-kvu", "--kv-unified",
];

export class ReservedArgError extends Error {
  override readonly name = "ReservedArgError";
  constructor(flag: string) {
    super(
      flag === "--host"
        ? `Karen sets ${flag} itself: the model server listens on this machine only, and ` +
          `overriding that would put an unauthenticated server on your network.`
        : `Karen sets ${flag} itself, so it cannot be given here.`,
    );
  }
}

/** Split a command line the way a shell would, honouring quotes. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function parseExtraArgs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  const tokens = tokenize(text);
  for (const token of tokens) {
    // Compare on the flag alone: `--host=0.0.0.0` is the same instruction as
    // `--host 0.0.0.0` and must not slip through on punctuation.
    const flag = token.split("=")[0]!;
    if (RESERVED_ARGS.includes(flag)) throw new ReservedArgError(flag);
  }
  return tokens;
}

/**
 * The tuning half of llama-server's command line.
 *
 * Transport -- the model path, the address, the port -- stays in server.ts,
 * because those are not the user's to set and this function's output is shown
 * to them.
 */
export function launchArgs(
  settings: LaunchSettings,
  context: number,
): string[] {
  const args = [
    // Required for tool calling. Upstream enables it by default; being explicit
    // means a future default change cannot quietly break tools.
    "--jinja",
    /*
     * One shared cache, always. Without this `-np N` allocates N separate
     * buffers and divides `-c` between them, so both the memory and the context
     * a conversation actually gets stop matching what the user chose.
     */
    "--kv-unified",
    "-np", String(Math.max(1, settings.slots)),
    "-c", String(context),
  ];

  if (settings.cacheType !== "f16") {
    // Both halves, deliberately. Quantising K alone saves half of what people
    // expect, and a mixed pair is a surprising thing to end up with by default.
    args.push("--cache-type-k", settings.cacheType, "--cache-type-v", settings.cacheType);
    /*
     * Flash attention is left on `auto` rather than forced on. A quantised V
     * cache needs it, and auto enables it wherever it is available -- verified
     * on b10639, where `-ctk q8_0 -ctv q8_0` starts with no `-fa` given. Forcing
     * it would turn "unsupported here" from a slower run into a failed one.
     */
  }

  if (settings.gpuLayers !== undefined) args.push("-ngl", String(settings.gpuLayers));
  args.push(...parseExtraArgs(settings.extraArgs));
  return args;
}
