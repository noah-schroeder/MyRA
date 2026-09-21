/**
 * Validating the folders the user can move.
 *
 * MyRA lets people choose where their documents, meetings, images, papers and
 * reviews live, and those choices are jail ROOTS: `meetingDir` resolves a
 * meeting against `meetingsRoot` and refuses anything outside it, and
 * `resolveInJail` does the same against `workspaceRoot`. Both are correct, and
 * both were being handed a root that arrived over IPC and was spread into
 * settings with no check at all -- so `meetingsRoot: "/"` turned a correct jail
 * into one containing the whole filesystem, and the next `meeting-delete`
 * recursively removed whatever it was pointed at.
 *
 * The shape is `mergeApiConfig`'s, deliberately: every field rebuilt, never
 * spread, because what these decide is whether something opens. A directory
 * picker is not validation -- it is one of the ways in, beside a hand-edited
 * settings.json and any build that ever wrote the field.
 *
 * Pure and synchronous. Two things it deliberately does NOT check:
 *
 *   - **Whether the directory exists, or could.** `load()` runs during startup
 *     before the window exists, and the runtime config makes this same
 *     argument for the same reason. More importantly a meetings root on an
 *     external disk that is currently unplugged is a legitimate "not there
 *     right now", and resetting it to the default would silently orphan a
 *     year of recordings.
 *   - **Environment variables.** MYRA_WORKSPACE, MYRA_CONFIG_DIR and the rest
 *     go unchecked on purpose: whoever sets this process's environment can
 *     already run code as this user, so checking buys nothing, and the test
 *     suite points all three at a temp directory to work at all.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR, insideRoot } from "./paths.ts";
import { safeRelativePath } from "./documents/formats.ts";

export interface RootOptions {
  /** True when an empty string is a real setting ("no vault", "look around"). */
  emptyMeans?: "none";
}

/** Whether a string could be one of MyRA's configurable roots. */
function usable(value: string): boolean {
  if (value.includes("\0")) return false;
  if (!isAbsolute(value)) return false;

  const abs = resolve(value);

  // A filesystem root. `dirname("/") === "/"`, and the same for `C:\`.
  if (dirname(abs) === abs) return false;

  // The home directory itself: every root gets files written into it and one
  // of them gets deleted recursively, and nobody means ~ by "my meetings".
  if (abs === resolve(homedir())) return false;

  /* Neither inside MyRA's own config directory nor containing it. The first
     would let a delete that walks a root take the settings file and the
     secrets beside it; the second is `~` and `/` wearing a different spelling
     on a machine whose CONFIG_DIR sits under them. */
  if (insideRoot(CONFIG_DIR, abs, { allowRoot: true })) return false;
  if (insideRoot(abs, CONFIG_DIR, { allowRoot: true })) return false;

  return true;
}

/**
 * A configurable root, or the fallback when the stored value cannot be one.
 *
 * Falls back rather than throwing. A value an older build wrote must not stop
 * this one starting, and the correction is visible without a new IPC channel:
 * the Settings folder box renders `config.current`, so it shows the default
 * the moment the bad value is replaced, and the next save writes it back.
 */
export function sanitiseRoot(value: unknown, fallback: string, opts?: RootOptions): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return opts?.emptyMeans === "none" ? "" : fallback;
  return usable(trimmed) ? trimmed : fallback;
}

/**
 * A configurable subdirectory NAME, joined onto a root by its caller.
 *
 * `vaultWriteSubdir` and `meetingReportDir` are not roots -- they are joined
 * onto one (`filingRoot` in meetings/store.ts) -- so the rule they need is the
 * one the document tools already have for a model-supplied name. A
 * `meetingReportDir` of "../../" wrote meeting notes above the vault.
 */
export function sanitiseSubdir(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.trim()) return "";
  return safeRelativePath(value) ?? fallback;
}
