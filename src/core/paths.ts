/**
 * Where Karen keeps its own files on the host.
 *
 * Its own module so that config and the broker can find it without importing
 * the secret vault, which imports Electron -- and a module that imports
 * Electron cannot be loaded by the test runner at all. One shared constant was
 * quietly making the app's configuration untestable.
 */

import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR =
  process.env["KAREN_CONFIG_DIR"] ?? join(homedir(), ".config", "karen");

/**
 * Owner-only, because everything Karen writes is the user's private material.
 *
 * A default `mkdir` takes its mode from the umask, which on Ubuntu and Fedora
 * is 0002 or 0022 -- so Karen's directories were created world-readable and,
 * under 0002, group-writable. Measured on a clean install: `~/.config/karen`,
 * `~/.config/Karen` and `~/Documents/karen` all came out 0775. The secrets file
 * and settings were 0600 and so were never exposed, but meeting transcripts,
 * meeting audio, research reports and drafted documents were written with the
 * default 0644 inside those directories and could be read by any other account
 * on the machine.
 *
 * That is a real exposure for the people this is built for: a university-issued
 * or lab-shared laptop is exactly where a second local account exists, and a
 * meeting transcript is exactly the thing that must not be readable from it.
 */
export const OWNER_ONLY_DIR = 0o700;
export const OWNER_ONLY_FILE = 0o600;

/**
 * `mkdir -p`, owner-only, for a directory Karen creates.
 *
 * A directory that already exists is left exactly as it is. That restraint is
 * deliberate: these paths are configurable, and someone who points Karen's
 * meeting folder at a directory they share on purpose should not have Karen
 * silently change its permissions underneath them. New directories -- which is
 * every per-meeting folder, every research run -- are private from birth, which
 * is what actually protects the contents.
 */
export async function makePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIR });
}

/**
 * As above, and tighten it even if it is already there.
 *
 * Only for directories that are unambiguously Karen's own -- the config
 * directory, the sessions store, the tools directory. Never for one the user
 * chose. `recursive: true` sets the mode only on levels it actually creates, so
 * an install that predates this function keeps its 0775 until something says
 * otherwise; this is that something.
 */
export async function makeOwnDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIR });
  try {
    const info = await stat(path);
    // Only when it is actually looser, so this is a no-op on every launch after
    // the first and never fights a deliberate `chmod` on a subdirectory.
    if ((info.mode & 0o077) !== 0) await chmod(path, OWNER_ONLY_DIR);
  } catch {
    /* Racing with another process, or a filesystem with no modes at all
       (a FAT-formatted external disk). Neither is worth failing a write over. */
  }
}

/**
 * Where downloaded helper binaries live.
 *
 * Not `vendor/`: that sits inside the installed application bundle, which is
 * read-only on every platform we ship to and is wiped by the next update. A
 * tool fetched on first run belongs with the user's own data, beside the model
 * runtime, which is downloaded for exactly the same reasons.
 */
export function toolsDir(): string {
  return process.env["KAREN_TOOLS_DIR"] ?? join(CONFIG_DIR, "tools");
}
