/**
 * Writing Karen's engine pins into the file Lemonade reads.
 *
 * The mechanism, all of it measured against lemond 11.8.0:
 *
 *   1. The daemon reads `resources/backend_versions.json` **once, at startup**.
 *      Editing it while the daemon runs changes nothing -- `/install/dry-run`
 *      kept resolving the old version until the process was restarted.
 *   2. With a pin ahead of the installed build, `/system-info` reports that
 *      backend as `update_required`, carrying `download_filename` and
 *      `release_url` for the new build and `version` for the one on disk.
 *   3. `POST /install` fetches it and, unlike the file, takes effect at once:
 *      the same `/system-info` then reads `installed` at the new version.
 *
 * So the order Karen has to work in is: write the pin, restart the daemon,
 * install. There is no shortcut, and the restart is why an update asks first
 * -- it drops whatever model is loaded.
 *
 * A pristine copy of the table is kept beside it, because the file is the only
 * record of what Lemonade itself chose and Karen overwrites it. Without the
 * copy the first update would make its own version look like the shipped one,
 * and "put it back the way it came" would have nothing to put back.
 */

import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OWNER_ONLY_FILE } from "../../core/paths.ts";
import { mergeBackendVersions, type EnginePins } from "../../core/runtime/enginePins.ts";

/** Lemonade's own table, inside the directory the daemon binary sits in. */
export const VERSIONS_FILE = "backend_versions.json";
/** Our copy of it as Lemonade shipped it, never written after it is made. */
export const SHIPPED_FILE = "backend_versions.karen-shipped.json";

export function versionsPath(lemondDir: string): string {
  return join(lemondDir, "resources", VERSIONS_FILE);
}

export function shippedPath(lemondDir: string): string {
  return join(lemondDir, "resources", SHIPPED_FILE);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The table as Lemonade shipped it, taking the copy the first time.
 *
 * Both files disappear together on a Lemonade upgrade -- `installLemonade`
 * removes the whole install directory -- so the copy can never be left
 * describing a version of the daemon that is no longer there.
 *
 * A copy that will not parse is treated as absent and taken again. That can
 * only bake a chosen version into the baseline, which costs the accuracy of
 * one "back to the shipped build" label; refusing to write anything instead
 * would strand the pins already applied, which is worse.
 */
export async function shippedVersions(
  lemondDir: string,
): Promise<Record<string, unknown> | undefined> {
  const copy = await readJson(shippedPath(lemondDir));
  if (copy) return copy;
  const live = await readJson(versionsPath(lemondDir));
  if (!live) return undefined;
  await copyFile(versionsPath(lemondDir), shippedPath(lemondDir));
  // copyFile keeps the archive's own 644; everything Karen writes is 600.
  await chmod(shippedPath(lemondDir), OWNER_ONLY_FILE).catch(() => undefined);
  return live;
}

/**
 * Write the shipped table with the user's pins over it.
 *
 * Called before every daemon start rather than when a pin changes, for the
 * reason `#pinConfig` gives about the config file: this file belongs to
 * Lemonade, Lemonade reinstalls replace it, and a setting that survives only
 * until something else touches the file is not a setting.
 *
 * Returns what it wrote, so the caller can say whether anything is pinned
 * without reading the file back.
 */
export async function applyEnginePins(
  lemondDir: string,
  pins: EnginePins,
): Promise<Record<string, unknown> | undefined> {
  const shipped = await shippedVersions(lemondDir);
  if (!shipped) return undefined;
  const merged = mergeBackendVersions(shipped, pins);
  await writeFile(versionsPath(lemondDir), `${JSON.stringify(merged, null, 2)}\n`, {
    mode: OWNER_ONLY_FILE,
  });
  return merged;
}

/** The directory holding `resources/`, given the daemon binary's path. */
export function lemondDirOf(binary: string): string {
  return dirname(binary);
}
