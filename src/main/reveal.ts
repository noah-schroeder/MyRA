/**
 * Whether a path is one of ours to show in the file manager.
 *
 * `shell.showItemInFolder` selects a file in the desktop's file manager. That
 * is less dangerous than opening one, but the argument was arriving as
 * `String(path)` straight off IPC in two handlers -- so it told the caller
 * whether any path on the machine exists, and pointed a file manager at it.
 * `myra:document-reveal` had always resolved through the jail first; these two
 * had not, and the difference was three files apart.
 *
 * Pure, and it answers the question rather than performing the action: the
 * `shell` call stays in the handler so this module is loadable by the test
 * runner, which a module importing `electron` is not.
 */

import { insideRoot } from "../core/paths.ts";

export type RevealVerdict = { ok: true; target: string } | { ok: false; error: string };

/**
 * The path, if it is inside one of the roots this button could have produced.
 *
 * `allowRoot` is on: revealing the folder a thing lives in is exactly what
 * this button is for, and unlike a delete there is nothing recursive about it.
 */
export function revealInside(path: unknown, roots: readonly string[], what: string): RevealVerdict {
  const target = String(path ?? "").trim();
  if (!target) return { ok: false, error: `that is not ${what}.` };
  const usable = roots.filter((root) => root.trim());
  if (!usable.some((root) => insideRoot(root, target, { allowRoot: true }))) {
    return { ok: false, error: `that is not ${what}.` };
  }
  return { ok: true, target };
}
