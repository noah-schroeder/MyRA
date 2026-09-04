/**
 * Can this machine run this model at all?
 *
 * A different question from `fit.ts`, and the one the model list was getting
 * wrong. `fitModel` asks whether the weights fit in memory; it assumes anything
 * that fits can be loaded. On a machine with 15 GB of RAM that is a
 * comfortable "yes" for most of the catalogue -- and for 95 of the 168 chat
 * models it is beside the point, because nothing on the machine can execute
 * them whatever the memory situation.
 *
 * Measured on this laptop, from `/api/v1/system-info`:
 *
 *   - **79 chat models are `ryzenai-llm`.** Its only backend is `npu`, and the
 *     daemon reports that as `unsupported` here. They will never load.
 *   - **11 are `vllm`**, whose only backend is `rocm`: also unsupported.
 *   - **One is `ds4`**, likewise.
 *   - **Four name an engine the daemon does not list at all.**
 *
 * Every one of those rows offered a Download button and a fit verdict of
 * "Processor", which reads as a green light. Pressing it spends several
 * gigabytes of somebody's bandwidth -- possibly on a metered connection, in a
 * hotel, before a conference talk -- on a file that cannot be loaded
 * afterwards, with nothing on screen having hinted otherwise.
 *
 * The names actively mislead: `Qwen2.5-0.5B-Instruct-CPU` and
 * `Llama-3.2-3B-Instruct-CPU` are both `ryzenai-llm`. "CPU" there means AMD's
 * OGA CPU runtime, not "runs on any processor", and no user is going to know
 * that.
 */

import type { EngineInfo } from "./systemInfo.ts";

export type Runnable =
  /** An engine backend is installed. Downloading this gets you a usable model. */
  | "ready"
  /**
   * Installed and working, but a different build is pinned.
   *
   * The daemon calls this `update_required`, and its message -- "Backend update
   * is required before use" -- reads worse than it behaves. Measured: with the
   * llama.cpp pin moved from b10375 to b10793, `/load` still succeeded, because
   * the daemon quietly fetched the new build first (`Installing llama-server
   * (version: b10793)` in its own log) and then generated normally.
   *
   * So the model runs; what it does not do is warn anyone that loading it is
   * about to spend 34 MB -- or, on CUDA, several hundred. That is the whole
   * reason Karen installs updates deliberately instead of letting them ambush
   * somebody mid-sentence.
   *
   * Reachable without anybody touching a pin: a Karen release that bumps
   * LEMONADE_VERSION ships new recipe versions, and every engine installed
   * under the old one lands here until it is reinstalled.
   */
  | "update-pending"
  /** Supported here, but the engine has to be installed first. */
  | "needs-engine"
  /** No backend on this hardware. Downloading it achieves nothing. */
  | "unsupported";

/**
 * Whether this engine can run a model right now.
 *
 * The distinction `update-pending` draws is about downloads, not capability, so
 * every gate that asks "can this run" has to accept both -- and asking through
 * one function is what stops the next such gate from being written as
 * `=== "ready"` and quietly excluding a working engine.
 */
export function engineUsable(state: Runnable | undefined): boolean {
  return state === "ready" || state === "update-pending";
}

export interface RunVerdict {
  state: Runnable;
  /** The engine this model needs, for naming it in the sentence. */
  engine: string;
  /** One line, in the words of what to do about it. */
  reason: string;
}

/**
 * What the machine can do with each engine, as one lookup.
 *
 * Built once per render rather than scanned per row: the chat group alone is
 * 168 rows and each would otherwise walk all fifteen engines.
 */
export function engineStates(engines: EngineInfo[]): Map<string, Runnable> {
  const out = new Map<string, Runnable>();
  for (const engine of engines) {
    const has = (want: string): boolean => engine.backends.some((b) => b.state === want);
    /*
     * `update_required` is listed BEFORE `installable` and after `installed`,
     * because it means an engine that is on the disk and works. It used to
     * fall off the end of this chain into `unsupported`, and the sentence that
     * produced -- "This machine has no way to run llama.cpp models, the
     * hardware it needs is not here" -- was false about a machine that had
     * just been chatting.
     */
    const state: Runnable = has("installed")
      ? "ready"
      : has("update_required")
        ? "update-pending"
        : has("installable")
          ? "needs-engine"
          : "unsupported";
    out.set(engine.id, state);
  }
  return out;
}

/**
 * Whether a model's engine can run here.
 *
 * An engine the daemon does not mention at all is treated as unsupported
 * rather than as unknown. `collection.omni` is the case that made the choice:
 * four catalogue entries name it, no engine does, and the honest reading of
 * "Lemonade lists every engine it has and this is not one of them" is that
 * there is nothing to run it with.
 */
export function runnable(recipe: string, states: Map<string, Runnable>): RunVerdict {
  const state = states.get(recipe) ?? "unsupported";
  return { state, engine: recipe, reason: REASONS[state](recipe) };
}

const REASONS: Record<Runnable, (engine: string) => string> = {
  ready: () => "Ready to run — its engine is installed.",
  "update-pending": (engine) =>
    `Ready to run. A newer ${engineWords(engine)} build is waiting, and loading a model ` +
    "would download it first — install it under Settings → Runtime to get that out of the way.",
  "needs-engine": (engine) =>
    `Needs the ${engineWords(engine)} engine, which this machine can install. ` +
    "Install it under Settings → Runtime first.",
  unsupported: (engine) =>
    `This machine has no way to run ${engineWords(engine)} models — the hardware it needs ` +
    "is not here. Downloading it would not give you anything that answers.",
};

/** Engine ids as they read in a sentence; the id itself when there is no better word. */
function engineWords(id: string): string {
  return ENGINE_WORDS[id] ?? id;
}

const ENGINE_WORDS: Record<string, string> = {
  llamacpp: "llama.cpp",
  "ryzenai-llm": "AMD Ryzen AI NPU",
  flm: "FastFlowLM NPU",
  vllm: "vLLM",
  whispercpp: "whisper.cpp",
  "sd-cpp": "Stable Diffusion",
  kokoro: "Kokoro speech",
  moonshine: "Moonshine",
  onnxruntime: "ONNX Runtime",
};

/**
 * Split a list into what this machine can use and what it cannot.
 *
 * Returned as two lists rather than a filter, because the count of the second
 * one has to be said out loud. Hiding 95 of 168 rows silently would leave
 * someone searching for a model they can see documented elsewhere and
 * concluding Karen's list is broken.
 */
export function partitionByRunnable<T extends { recipe: string }>(
  entries: T[],
  states: Map<string, Runnable>,
): { usable: T[]; blocked: T[] } {
  const usable: T[] = [];
  const blocked: T[] = [];
  for (const entry of entries) {
    (runnable(entry.recipe, states).state === "unsupported" ? blocked : usable).push(entry);
  }
  return { usable, blocked };
}
