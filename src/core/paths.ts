/**
 * Where Karen keeps its own files on the host.
 *
 * Its own module so that config and the broker can find it without importing
 * the secret vault, which imports Electron -- and a module that imports
 * Electron cannot be loaded by the test runner at all. One shared constant was
 * quietly making the app's configuration untestable.
 */

import { chmod, lstat, mkdir, readdir, stat } from "node:fs/promises";
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

/**
 * Tighten a tree Karen already wrote, once.
 *
 * `makeOwnDir` fixes the root of an old install, and every writer since passes
 * an explicit mode -- but neither reaches what is already on disk one level
 * down. An install that predates those fixes still has
 * `research/2026-08-19-do-pedagogical-agents-improve-recall/` at 0775 with its
 * `report.md` at 0644, and no amount of care in new code will ever touch them
 * again: they are finished runs that nothing will rewrite.
 *
 * So this walks a root Karen owns and narrows what is loose. Two limits keep it
 * honest rather than enthusiastic:
 *
 *   - **Only what is actually loose.** A path with no group or other bits set
 *     is left entirely alone, so a deliberate `chmod` inside a run survives and
 *     the second launch does no work at all.
 *   - **Never across a symlink.** `lstat`, not `stat`, and links are skipped
 *     rather than followed -- a link pointing at a shared folder would
 *     otherwise make this reach outside the tree it was given, which is the one
 *     thing a permission sweep must not do.
 *
 * Errors are swallowed per entry. A single unreadable directory on a mounted
 * disk should narrow everything else and not abort the sweep.
 */
export async function tightenTree(root: string, budget = 20_000): Promise<number> {
  let changed = 0;
  let seen = 0;

  const walk = async (path: string): Promise<void> => {
    if (seen >= budget) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= budget) return;
      seen += 1;
      const child = join(path, entry.name);
      try {
        const info = await lstat(child);
        if (info.isSymbolicLink()) continue;
        if ((info.mode & 0o077) !== 0) {
          /* Strip the group and other bits and keep the owner's exactly as
             they are. Not a flat 0700/0600: `tools/` holds downloaded
             binaries at 0755, and forcing them to 0600 would take the execute
             bit off pandoc and break the export that needs it. What is being
             fixed here is who else can read, which is only ever the low six
             bits. */
          await chmod(child, info.mode & ~0o077 & 0o7777);
          changed += 1;
        }
        if (info.isDirectory()) await walk(child);
      } catch {
        /* Vanished mid-walk, or a filesystem with no modes. Skip it. */
      }
    }
  };

  await walk(root);
  return changed;
}
