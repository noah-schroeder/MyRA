/**
 * Which build of each engine Karen asks Lemonade to install.
 *
 * Lemonade keeps one table of engine versions in its own `resources/
 * backend_versions.json`, and invites this directly:
 *
 *   "This configuration file controls which llama.cpp, whisper.cpp, sd.cpp,
 *    ryzenai-llm, and FLM versions are downloaded for each backend. You can
 *    modify these values to pin specific versions without rebuilding the
 *    application."
 *
 * So updating an engine is not a matter of Karen fetching a tarball -- it is a
 * matter of changing one string and letting the daemon do what it already
 * does. The daemon reads the file once at startup, compares each pin against
 * the `version.txt` the installed engine carries, and reports the difference
 * as `update_required` on `/system-info`.
 *
 * **The choice lives in Karen's own config, not in that file.**
 * `installLemonade` does `rm -rf` on the install directory, so a Lemonade
 * upgrade would silently revert every version anybody had chosen -- and the
 * revert would look like the app deciding on its own to undo their work. Pins
 * are held in `runtime.json` and re-applied on every daemon start, which also
 * makes "put it back to the build Karen ships" free: delete the key.
 */

/** `llamacpp:vulkan` -- a backend, not an engine. */
export const PIN_SEPARATOR = ":";

/**
 * Keyed per backend, because one engine's backends are different projects.
 *
 * Measured through `/install/dry-run`: llama.cpp's Vulkan build comes from
 * `ggml-org/llama.cpp` at b10375 and its CUDA build from the
 * `lemonade-sdk/llama.cpp` fork at b10397 -- different repositories, different
 * release cadences, and a tag that exists in one is routinely absent from the
 * other. A pin per engine would offer people a version that cannot be
 * downloaded for the backend they actually run.
 */
export type EnginePins = Record<string, string>;

export function pinKey(recipe: string, backend: string): string {
  return `${recipe}${PIN_SEPARATOR}${backend}`;
}

export function parsePinKey(key: string): { recipe: string; backend: string } | undefined {
  const at = key.indexOf(PIN_SEPARATOR);
  if (at <= 0 || at === key.length - 1) return undefined;
  return { recipe: key.slice(0, at), backend: key.slice(at + 1) };
}

/** The version the shipped table names for a backend, if it names one. */
export function shippedVersion(
  shipped: Record<string, unknown>,
  recipe: string,
  backend: string,
): string | undefined {
  const block = shipped[recipe];
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const value = (block as Record<string, unknown>)[backend];
  return typeof value === "string" ? value : undefined;
}

/**
 * The shipped table with the user's choices written over it.
 *
 * **Only replaces a value that is already a version string.** The file holds
 * more than versions -- `therock` carries an `architectures` array, `vllm` a
 * nested `rocm_arch_overrides`, and both files have `comment` keys -- and a
 * pin that invented a key, or overwrote a structure with a string, would
 * produce a daemon that fails to parse its own resources. A pin naming
 * something this table does not already version is dropped rather than
 * honoured, because it can only have come from a stale config: the backends
 * Karen offers to update are the ones the daemon just reported.
 */
export function mergeBackendVersions(
  shipped: Record<string, unknown>,
  pins: EnginePins,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...shipped };
  for (const [key, version] of Object.entries(pins)) {
    const parsed = parsePinKey(key);
    if (!parsed || !version) continue;
    if (shippedVersion(shipped, parsed.recipe, parsed.backend) === undefined) continue;
    const block = out[parsed.recipe] as Record<string, unknown>;
    out[parsed.recipe] = { ...block, [parsed.backend]: version };
  }
  return out;
}

/** Drop a pin, which is how "back to the build Karen ships" is expressed. */
export function withoutPin(pins: EnginePins, key: string): EnginePins {
  const out = { ...pins };
  delete out[key];
  return out;
}

export function withPin(pins: EnginePins, key: string, version: string): EnginePins {
  return { ...pins, [key]: version };
}
