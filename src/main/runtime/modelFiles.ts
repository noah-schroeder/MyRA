/**
 * The real files behind a model id, jailed to the folders MyRA actually owns.
 *
 * `modelDelete.ts` needed this resolver first -- a delete built out of string
 * concatenation on an id that came back from a window is how a delete ends up
 * somewhere else -- and its own header explains the two rules that make it
 * safe: the real path comes from `realpath`, never from the id, and a
 * resolved target must be inside a directory MyRA already knows about. Sizing
 * a model's GGUF header for context planning needs exactly the same walk, so
 * it lives here once rather than twice where the two could quietly disagree
 * about what is safe to open.
 */

import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isAuxiliaryGguf, isGguf, sameShardSet, type ForeignModel } from "../../core/runtime/foreign.ts";
import { insideRoot } from "../../core/paths.ts";

export interface ModelFilesDeps {
  /** What the last index build recorded, which is the only record of ownership. */
  foreign: readonly ForeignModel[];
  /** MyRA's own models folder. */
  modelsDir: string;
  /** The symlink tree the daemon is pointed at. */
  indexDir: string;
}

/**
 * `rel === ""` counts: a target that IS the root is inside it.
 *
 * Delegated rather than reimplemented. There is one containment check in this
 * codebase now (core/paths.ts), because two that disagree is how a jail ends
 * up correct in one caller and a prefix compare in the next.
 */
export function inside(parent: string, child: string): boolean {
  return insideRoot(parent, child, { allowRoot: true });
}

/**
 * The real files behind one entry in the index.
 *
 * An entry is a directory of symlinks (or, for a loose file, a link itself).
 * Every link is resolved and checked against the permitted roots before it
 * joins the list, and one bad link fails the whole call rather than being
 * skipped: a link pointing outside its library is a fact somebody should hear
 * about, not a file quietly left out.
 *
 * `refusal` is the verb the caller was trying to perform, past tense --
 * `modelDelete.ts`'s own copy of this refusal used to say "so it has not
 * been deleted.", and saying nothing about a delete once this moved into a
 * function shared with sizing is worse than the generic default below.
 */
export async function resolveTargets(
  entry: string,
  roots: string[],
  refusal = "used",
): Promise<string[]> {
  const info = await lstat(entry).catch(() => undefined);
  if (!info) return [];

  const links: string[] = [];
  if (info.isDirectory()) {
    for (const name of await readdir(entry)) links.push(join(entry, name));
  } else {
    links.push(entry);
  }

  const out: string[] = [];
  for (const link of links) {
    const target = await realpath(
      (await lstat(link)).isSymbolicLink() ? await readlink(link).then((t) => resolve(dirname(link), t)) : link,
    ).catch(() => undefined);
    if (!target) continue;
    if (!(await stat(target).catch(() => undefined))?.isFile()) continue;
    if (!roots.some((root) => inside(root, target))) {
      throw new Error(
        `${target} is not inside a folder MyRA manages, so it has not been ${refusal}.`,
      );
    }
    out.push(target);
  }
  return out;
}

/**
 * The GGUF that is this model's weights, and the total bytes across every
 * shard of it -- what `fitModel` means by a model's file size.
 *
 * Picks the largest file that is not `isAuxiliaryGguf` (a vision projector, or
 * a split archive's later parts): the header lives in part one, and a
 * projector sitting beside the weights is not the thing being sized. A model
 * that is not split has one such file and this returns its own size; a split
 * model's later parts are added on top because that is memory the daemon will
 * still map, even though the header MyRA reads never leaves part one.
 */
export async function weightsFile(
  id: string,
  deps: ModelFilesDeps,
): Promise<{ path: string; bytes: number } | undefined> {
  const foreign = deps.foreign.find((m) => m.id === id);
  const roots = foreign
    ? [dirname(await realpath(foreign.path).catch(() => foreign.path))]
    : [deps.modelsDir];
  const targets = await resolveTargets(join(deps.indexDir, id), roots).catch(() => []);
  if (!targets.length) return undefined;

  const ggufs = targets.filter((t) => isGguf(t));
  const primaries = ggufs.filter((t) => !isAuxiliaryGguf(basename(t)));
  if (!primaries.length) return undefined;

  const sized = await Promise.all(
    primaries.map(async (path) => ({ path, bytes: (await stat(path).catch(() => undefined))?.size ?? 0 })),
  );
  const primary = sized.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  if (!primary.bytes) return undefined;

  let bytes = primary.bytes;
  for (const t of ggufs) {
    if (t === primary.path) continue;
    if (!sameShardSet(basename(t), basename(primary.path))) continue;
    bytes += (await stat(t).catch(() => undefined))?.size ?? 0;
  }
  return { path: primary.path, bytes };
}
