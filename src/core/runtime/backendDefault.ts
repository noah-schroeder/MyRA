/**
 * Which runtime an engine's models start on, and which models chose their own.
 *
 * One engine can hold several runtimes at once -- Vulkan and ROCm for llama.cpp
 * is the ordinary pair on an AMD card -- and Lemonade answers "which one runs
 * this model" from two places, in a fixed order. Measured against lemond 11.8.0:
 *
 *   - **The engine's default**: `llamacpp.backend` in the daemon's `config.json`,
 *     `auto` until somebody says otherwise. It is changed live, with no restart,
 *     by `POST /internal/set {"llamacpp":{"backend":"rocm"}}` -- at the server
 *     root, not under `/api/v1` -- and the daemon persists it itself. It refuses a
 *     runtime the machine cannot run (`'llamacpp.backend' must be one of: auto,
 *     vulkan, cpu`), which is a check on hardware and not on what is installed.
 *   - **A model's own choice**: `<recipe>_backend` in `recipe_options.json`,
 *     reached through the options endpoint the Tune page already edits. It beats
 *     the default. `defaults.<recipe>_backend` in that same response is the
 *     *resolved* default -- what `auto` turned into -- and `saved` holds only the
 *     overrides, so "does this model have its own choice" is a question the
 *     response answers without a guess.
 *
 * So MyRA keeps no store of its own for this. A second copy of "which runtime"
 * would be a preference the launch never reads, which is the failure
 * `modelOptions.ts` already gives for keeping load settings anywhere but the
 * daemon. What is here is the reading and the rules.
 *
 * **Clearing is surgical only with `null`.** `DELETE …/options` drops every
 * saved setting, so using it to hand a model back to the default would take its
 * context window and extra arguments with it. Posting `{"<recipe>_backend":
 * null}` removes that one key and nothing else -- measured, with `ctx_size`
 * beside it surviving; `""` and `"auto"` do the same.
 *
 * Two irregular spellings, both measured: the image engine is `sd-cpp` as a
 * recipe and on a model (`sd-cpp_backend`) but `sdcpp` in the config, where
 * hyphens are not used. Every other engine that has a runtime choice spells all
 * three the same.
 *
 * No imports from the window or the daemon: the renderer reads the labels and
 * the sentences from here, and the tests read all of it.
 */

import type { ModelOptions } from "./modelOptions.ts";
import type { EngineInfo } from "./systemInfo.ts";

/** What the daemon's own config holds until somebody chooses: "you pick, Lemonade". */
export const AUTO = "auto";

/**
 * The runtimes of an engine that are on this machine, in the daemon's order.
 *
 * `update_required` counts: it is an installed build with a newer one waiting,
 * and the engine cards already draw it with a tick. The window offers exactly
 * this list and the main process validates against exactly this list, so what
 * the dropdown shows and what a write will accept cannot drift apart.
 */
export function installedRuntimes(engine: EngineInfo | undefined): string[] {
  return (engine?.backends ?? [])
    .filter((b) => b.state === "installed" || b.state === "update_required")
    .map((b) => b.id);
}

/** Runtime ids are upstream's; these say what each one is for. */
export const BACKEND_LABELS: Record<string, string> = {
  cuda: "NVIDIA (CUDA)",
  rocm: "AMD (ROCm)",
  vulkan: "Vulkan",
  metal: "Apple silicon (Metal)",
  cpu: "Processor",
  npu: "NPU",
  system: "Already on this machine",
};

/** The words for a runtime; an id MyRA has not heard of is still shown as itself. */
export function backendLabel(id: string): string {
  return BACKEND_LABELS[id] ?? id;
}

/**
 * Names that become part of a key in a JSON body the daemon reads.
 *
 * The same shape `enginePins` holds versions to: these are written into a file
 * and a request, never spliced into a command line, but a value that can carry
 * anything is one nobody reviewed.
 */
const NAME = /^[A-Za-z0-9._-]+$/;

export function isName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

/** The engine's block in the daemon's config: `sd-cpp` is `sdcpp` there. */
export function configKeyOf(recipe: string): string {
  return recipe.replace(/-/g, "");
}

/** The field on a model's options that names its runtime. */
export function optionKeyOf(recipe: string): string {
  return `${recipe}_backend`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const own = (o: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

/**
 * What the daemon's config says this engine runs on, or nothing.
 *
 * "Nothing" is the answer for an engine with no such setting at all -- kokoro
 * and moonshine ship a CPU build only, and the config has no `backend` for
 * them. That absence is the test for whether the window offers a choice, taken
 * from the daemon's own field list rather than from a list of engine names, so
 * an engine Lemonade adds later is covered without a release.
 */
export function configuredBackend(config: unknown, recipe: string): string | undefined {
  if (!isName(recipe)) return undefined;
  const block = obj(obj(config)[configKeyOf(recipe)]);
  const value = block["backend"];
  return isName(value) ? value : undefined;
}

/** One model, and what it has to say about its own runtime. */
export interface ModelChoice {
  model: string;
  /** The runtime it chose for itself; absent when it follows the default. */
  own?: string | undefined;
  /** What it gets when it has chosen nothing -- the daemon's resolved default. */
  fallback?: string | undefined;
}

/**
 * Read one model's runtime out of its options.
 *
 * `undefined` for a model whose options carry no such field: the daemon would
 * refuse a write to it (`Unknown option 'x' for recipe 'y'`), so counting it as
 * "follows the default" would promise a reset that cannot happen.
 */
export function modelChoice(
  recipe: string,
  options: ModelOptions,
  model: string,
): ModelChoice | undefined {
  const key = optionKeyOf(recipe);
  if (!own(options.defaults, key) && !own(options.saved, key)) return undefined;
  const chosen = options.saved[key];
  const fallback = options.defaults[key];
  return {
    model,
    ...(isName(chosen) ? { own: chosen } : {}),
    ...(isName(fallback) ? { fallback } : {}),
  };
}

/** Everything the window needs to draw one engine's default. */
export interface EngineBackendState {
  recipe: string;
  /** `auto`, or the runtime the daemon's config names. */
  configured: string;
  /**
   * What a model that chose nothing will run on, as the daemon reports it.
   *
   * It is the answer to "what is Automatic on this machine" -- the only way to
   * learn that is to ask a model -- so it is absent for an engine with none
   * downloaded, and the window says "Automatic" without the parenthesis.
   */
  resolved?: string | undefined;
  /** How many models were read. */
  models: number;
  /** The ones that chose for themselves. */
  chose: { model: string; backend: string }[];
  /** This engine's models in memory now, which keep their runtime until reloaded. */
  loaded: string[];
}

export function engineBackendState(input: {
  recipe: string;
  configured: string;
  choices: readonly ModelChoice[];
  loaded?: readonly string[];
}): EngineBackendState {
  const resolved = input.choices.find((c) => c.fallback !== undefined)?.fallback;
  return {
    recipe: input.recipe,
    configured: input.configured,
    ...(resolved !== undefined ? { resolved } : {}),
    models: input.choices.length,
    chose: input.choices.flatMap((c) => (c.own !== undefined ? [{ model: c.model, backend: c.own }] : [])),
    loaded: [...(input.loaded ?? [])],
  };
}

/** The runtimes models chose for themselves, most common first, ties by name. */
export function tallyChosen(
  chose: readonly { backend: string }[],
): { backend: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of chose) counts.set(c.backend, (counts.get(c.backend) ?? 0) + 1);
  return [...counts]
    .map(([backend, count]) => ({ backend, count }))
    .sort((a, b) => b.count - a.count || a.backend.localeCompare(b.backend));
}

/** "Vulkan ×2, Processor" -- the tally as a person would say it. */
export function describeChosen(chose: readonly { backend: string }[]): string {
  return tallyChosen(chose)
    .map((t) => (t.count > 1 ? `${backendLabel(t.backend)} ×${t.count}` : backendLabel(t.backend)))
    .join(", ");
}

export interface DefaultChoice {
  value: string;
  label: string;
}

/**
 * The options the default's dropdown offers.
 *
 * **Installed runtimes only, plus Automatic.** The daemon would accept any
 * runtime the machine supports, installed or not, and then fetch a missing one
 * silently at the next load -- measured for a pending engine build, and the
 * same daemon. A choice that turns into a hidden download in the middle of a
 * sentence is the opposite of what a dropdown of things you already have says.
 *
 * A configured runtime that is not installed (removed since, or written by hand)
 * is still listed and says so, because a dropdown that showed "Automatic" over a
 * config naming something else would be a false report of the machine.
 */
export function defaultChoices(input: {
  installed: readonly string[];
  configured: string;
  resolved?: string | undefined;
}): DefaultChoice[] {
  const choices: DefaultChoice[] = [
    {
      value: AUTO,
      label:
        input.resolved && input.configured === AUTO
          ? `Automatic (${backendLabel(input.resolved)})`
          : "Automatic",
    },
    ...input.installed.map((id) => ({ value: id, label: backendLabel(id) })),
  ];
  if (input.configured !== AUTO && !input.installed.includes(input.configured)) {
    choices.push({ value: input.configured, label: `${backendLabel(input.configured)} (not installed)` });
  }
  return choices;
}

/**
 * Refuse a default nothing could start on.
 *
 * The daemon checks the hardware; this checks the install. The window only
 * offers installed runtimes, but the renderer is not the boundary -- and what
 * is written here is read by the next load, not by a person who could see the
 * mistake.
 */
export function assertChoosable(backend: string, installed: readonly string[]): string {
  if (backend === AUTO) return backend;
  if (!isName(backend) || !installed.includes(backend)) {
    throw new Error(
      `${isName(backend) ? backendLabel(backend) : "That runtime"} is not installed for this ` +
        "engine, so nothing could start on it. Install it first.",
    );
  }
  return backend;
}

/**
 * Who has chosen for themselves, in a sentence that agrees with its numbers.
 *
 * Said to the person who is about to press Reset, so it names the runtimes: "3
 * of 12 models use a runtime of their own" is a count, and "Vulkan ×3" is what
 * tells them whether that is the one they meant to leave behind.
 */
export function chosenSentence(chose: readonly { backend: string }[], models: number): string {
  const what = describeChosen(chose);
  if (chose.length === 1) {
    return models === 1
      ? `This model uses a runtime of its own: ${what}.`
      : `1 of ${models} models uses a runtime of its own: ${what}.`;
  }
  return `${chose.length} of ${models} models use a runtime of their own: ${what}.`;
}

/** What the reset button says it will do, by naming where the models end up. */
export function resetLabel(count: number, target: string): string {
  return count === 1 ? `Reset it to ${target}` : `Reset all ${count} to ${target}`;
}

/** The line under the dropdown when nobody has chosen for themselves. */
export function followSentence(models: number): string | undefined {
  if (models <= 0) return undefined;
  return models === 1 ? "The one model here follows it." : `All ${models} models follow it.`;
}

/** `1 model`, `3 models`. */
function countModels(n: number): string {
  return n === 1 ? "1 model" : `${n} models`;
}

/**
 * The one line said after a change, in the words of what happened.
 *
 * Kept here with the rest of the rules rather than assembled in the window: which
 * of these sentences is true depends on the same counts the rest of this file
 * reads, and one of them says something the change itself cannot fix -- a model
 * that is loaded keeps the runtime it started on.
 */
export function changeNotice(input: {
  kind: "default" | "reset";
  /** What the models now start on, already worded. */
  now: string;
  /** Models whose runtime actually changed in a reset. */
  cleared?: number;
  /** Models that chose for themselves and still do, after a default change. */
  keepers?: number;
  failed?: number;
  loaded: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.kind === "default") {
    parts.push(`Models now start on ${input.now} unless they chose a runtime of their own.`);
    if (input.keepers === 1) parts.push("1 model has a runtime of its own and keeps it.");
    else if (input.keepers) {
      parts.push(`${input.keepers} models have runtimes of their own and keep them.`);
    }
  } else if (input.cleared === 1) {
    parts.push(`1 model now follows the default (${input.now}).`);
  } else if (input.cleared) {
    parts.push(`${input.cleared} models now follow the default (${input.now}).`);
  } else {
    parts.push("No model had a runtime of its own to reset.");
  }
  if (input.failed) parts.push(`${countModels(input.failed)} could not be changed.`);
  if (input.loaded.length === 1) {
    parts.push(`${input.loaded[0]} is loaded and keeps the runtime it started on until it is reloaded.`);
  } else if (input.loaded.length > 1) {
    parts.push(
      `${input.loaded.join(", ")} are loaded and keep the runtimes they started on until they ` +
        "are reloaded.",
    );
  }
  return parts.join(" ");
}
