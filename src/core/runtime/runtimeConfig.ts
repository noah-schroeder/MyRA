/**
 * Rebuilding the runtime config, field by field.
 *
 * `myra:runtime-config` was `{...current, ...patch}` and a write, with nothing
 * between the window and the file. Three of these fields decide where the
 * process looks and what it deletes:
 *
 *   - `modelsDir` is the jail root for model deletion (`roots` in
 *     runtime/modelDelete.ts), so setting it to "/" turns the containment
 *     check there into a no-op.
 *   - `extraModelDirs` are mirrored into the index as symlinks and handed to
 *     the daemon as `extra_models_dir`.
 *   - `enginePins` names a version that becomes part of a URL the daemon
 *     fetches an engine build from.
 *
 * The shape is `mergeApiConfig`'s in core/api/config.ts, which is the pattern
 * this codebase already reaches for when a stored value decides whether
 * something opens: rebuilt, never spread.
 *
 * Here rather than in manager.ts so it is testable -- manager.ts pulls in the
 * whole daemon supervisor, and the thing worth testing is this.
 */

import { PIN_SEPARATOR, type EnginePins } from "./enginePins.ts";
import { sanitiseRoot } from "../roots.ts";

/**
 * A model id as Lemonade spells one, refused otherwise.
 *
 * Not `assertRunId`'s regex: a Lemonade id legitimately carries one slash
 * (`owner/name`), which is why this is its own function rather than a sixth
 * caller of that one. What it still must not carry is a climb, an absolute
 * path or a NUL, because `deleteModel` joins it onto the index directory --
 * the one id in the app that reached a path with no guard at all.
 */
export function assertModelId(id: string): string {
  const segments = id.split("/");
  const ok =
    segments.length >= 1 &&
    segments.length <= 2 &&
    segments.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..");
  if (!ok) throw new Error(`no model named ${JSON.stringify(id)}`);
  return id;
}

/** True when a model id could be one; for filtering rather than refusing. */
function isModelId(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    assertModelId(value);
    return true;
  } catch {
    return false;
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Only keys of the `recipe:backend` shape enginePins.ts defines. */
function pins(value: unknown): EnginePins | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: EnginePins = {};
  for (const [key, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version !== "string" || !version.trim()) continue;
    const parts = key.split(PIN_SEPARATOR);
    if (parts.length !== 2) continue;
    if (!parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p))) continue;
    /* The version becomes part of a release tag the daemon fetches, so it is
       held to the same shape rather than passed through as free text. */
    if (!/^[A-Za-z0-9._-]+$/.test(version.trim())) continue;
    out[key] = version.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Shape-only, so this module needs nothing from the daemon supervisor.
 *
 * manager.ts's `RuntimeConfig` extends nothing and is structurally this; the
 * duplication is one interface rather than an import cycle through a module
 * that spawns processes.
 */
export interface StoredRuntimeConfig {
  modelsDir: string;
  startOnLaunch: boolean;
  activeModel?: string | undefined;
  defaultModel?: string | undefined;
  useForChat: boolean;
  importForeignModels: boolean;
  extraModelDirs?: string[];
  enginePins?: EnginePins;
}

/**
 * Whatever was stored or sent, rebuilt into something safe to act on.
 *
 * A bad value falls back to the default rather than throwing, for the reason
 * `RuntimeManager.load` already gives for a malformed runtime.json: this runs
 * during startup, before the window exists, and a throw here skips every IPC
 * registration that follows.
 */
export function mergeRuntimeConfig<T extends StoredRuntimeConfig>(
  stored: unknown,
  defaults: T,
): T {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const dirs = Array.isArray(raw["extraModelDirs"])
    ? (raw["extraModelDirs"] as unknown[])
        .map((d) => sanitiseRoot(d, ""))
        .filter((d) => d !== "")
    : undefined;

  return {
    ...defaults,
    modelsDir: sanitiseRoot(raw["modelsDir"], defaults.modelsDir),
    startOnLaunch: bool(raw["startOnLaunch"], defaults.startOnLaunch),
    useForChat: bool(raw["useForChat"], defaults.useForChat),
    importForeignModels: bool(raw["importForeignModels"], defaults.importForeignModels),
    /* Dropped rather than defaulted when it is not a usable id: "no model
       chosen" is a real state, and substituting one would load something
       nobody asked for. */
    ...(isModelId(raw["activeModel"]) ? { activeModel: raw["activeModel"] } : { activeModel: undefined }),
    ...(isModelId(raw["defaultModel"]) ? { defaultModel: raw["defaultModel"] } : { defaultModel: undefined }),
    ...(dirs && dirs.length ? { extraModelDirs: dirs } : { extraModelDirs: undefined }),
    ...(pins(raw["enginePins"]) ? { enginePins: pins(raw["enginePins"]) } : { enginePins: undefined }),
  };
}
