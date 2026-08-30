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
  /** Supported here, but the engine has to be installed first. */
  | "needs-engine"
  /** No backend on this hardware. Downloading it achieves nothing. */
  | "unsupported";

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
    const state = engine.backends.some((b) => b.state === "installed")
      ? "ready"
      : engine.backends.some((b) => b.state === "installable")
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
