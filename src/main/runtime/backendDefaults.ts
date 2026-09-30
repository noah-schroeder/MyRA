/**
 * Reading and changing the runtime an engine's models start on.
 *
 * Split from `manager.ts` for the reason `modelDelete.ts` is split from its own
 * IPC: that module reaches `electron`, which the test runner cannot load, and
 * "reset every model" is a bulk write to state the daemon owns -- exactly the
 * path that has to be tested. The daemon's client comes in as a parameter, so
 * the rules run against a fake here and against the real thing in the manager.
 *
 * The facts this stands on -- where the default lives, what clears a single key,
 * which spelling each engine uses -- are in `core/runtime/backendDefault.ts`.
 */

import {
  assertChoosable,
  configuredBackend,
  engineBackendState,
  isName,
  modelChoice,
  optionKeyOf,
  type EngineBackendState,
  type ModelChoice,
} from "../../core/runtime/backendDefault.ts";
import { isOverridden, type ModelOptions } from "../../core/runtime/modelOptions.ts";
import type { InstalledModel } from "./lemonadeApi.ts";

/** The part of the daemon's client this needs, so a test can stand in for it. */
export interface BackendApi {
  config(): Promise<unknown>;
  listModels(): Promise<InstalledModel[]>;
  modelOptions(name: string): Promise<ModelOptions>;
  setModelOptions(name: string, patch: Record<string, unknown>): Promise<ModelOptions>;
  setEngineBackend(recipe: string, backend: string): Promise<void>;
}

/**
 * Models read at once.
 *
 * Each is a small loopback request, and a library of sixty would otherwise be
 * sixty in flight against a daemon that is also trying to answer the chat turn
 * that prompted the page to open.
 */
const AT_ONCE = 6;

async function inBatches<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) {
    out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(fn))));
  }
  return out;
}

/** What the engine's models are, the ones on the disk: a definition with no files has nothing to reset. */
function modelsOf(all: readonly InstalledModel[], recipe: string): InstalledModel[] {
  return all.filter((m) => m.recipe === recipe && m.downloaded !== false);
}

/**
 * Refuse an engine the daemon has no runtime setting for.
 *
 * The daemon's own config is the list of which engines have one, so this is
 * where "a recipe name the window sent" stops being a string and becomes a key
 * known to exist -- before it is used to build a write.
 */
function requireSetting(config: unknown, recipe: string): string {
  const configured = configuredBackend(config, recipe);
  if (configured === undefined) {
    throw new Error(`${isName(recipe) ? recipe : "That engine"} has no runtime setting to change.`);
  }
  return configured;
}

/**
 * The default and who overrides it, for each of the engines asked about.
 *
 * An engine with no runtime setting is left out of the answer rather than
 * failing it: the window asks about every engine that has two runtimes
 * installed, and one it could not read is not a reason to draw none of them.
 * A model whose options cannot be read is skipped the same way -- the counts are
 * then of the models that answered, which is all that can be honestly said.
 */
export async function readBackendDefaults(
  api: BackendApi,
  recipes: readonly string[],
  loaded: Readonly<Record<string, readonly string[]>> = {},
): Promise<Record<string, EngineBackendState>> {
  const config = await api.config();
  const all = await api.listModels();
  const states: Record<string, EngineBackendState> = {};
  for (const recipe of recipes) {
    const configured = configuredBackend(config, recipe);
    if (configured === undefined) continue;
    const reads = await inBatches(modelsOf(all, recipe), async (m): Promise<ModelChoice | undefined> => {
      try {
        return modelChoice(recipe, await api.modelOptions(m.id), m.id);
      } catch {
        return undefined;
      }
    });
    states[recipe] = engineBackendState({
      recipe,
      configured,
      choices: reads.filter((c): c is ModelChoice => c !== undefined),
      loaded: loaded[recipe] ?? [],
    });
  }
  return states;
}

/**
 * Choose what an engine's models start on.
 *
 * `installed` is what the machine has, passed in rather than asked for: the
 * caller has just read it, and this stays a rule about a list.
 */
export async function setDefaultBackend(
  api: BackendApi,
  recipe: string,
  backend: string,
  installed: readonly string[],
): Promise<void> {
  requireSetting(await api.config(), recipe);
  assertChoosable(backend, installed);
  await api.setEngineBackend(recipe, backend);
}

export interface ResetResult {
  /** Models that had a runtime of their own and no longer do. */
  cleared: string[];
  failed: { model: string; error: string }[];
}

/**
 * Hand every model of an engine back to the default.
 *
 * **Only the runtime is cleared.** A model's context window, its extra
 * arguments and its idle timeout are settings somebody chose on the same Tune
 * page, and a button named for the runtime that also took those would be a
 * wider promise than its label. `{key: null}` removes exactly one key -- see
 * `backendDefault.ts`.
 *
 * **Checked afterwards, per model.** The daemon answers a write with the options
 * as it now holds them, so "cleared" means the answer no longer carries the
 * key, not that the request returned 200. A model it kept is reported as
 * failed, which is the difference between a count the window can print and one
 * it would have to hope about.
 *
 * One at a time: each write rewrites the file the daemon keeps every model's
 * options in, and a failure part-way should leave the models it did reach
 * reset rather than an unknown subset of sixty concurrent ones.
 */
export async function resetModelBackends(api: BackendApi, recipe: string): Promise<ResetResult> {
  requireSetting(await api.config(), recipe);
  const key = optionKeyOf(recipe);
  const result: ResetResult = { cleared: [], failed: [] };
  for (const m of modelsOf(await api.listModels(), recipe)) {
    try {
      const choice = modelChoice(recipe, await api.modelOptions(m.id), m.id);
      if (choice?.own === undefined) continue;
      const after = await api.setModelOptions(m.id, { [key]: null });
      if (isOverridden(after, key)) {
        result.failed.push({ model: m.id, error: "The daemon kept the runtime that was set." });
      } else {
        result.cleared.push(m.id);
      }
    } catch (err) {
      result.failed.push({ model: m.id, error: (err as Error).message });
    }
  }
  return result;
}
