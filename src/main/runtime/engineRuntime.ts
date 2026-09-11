/**
 * Repairing the engines Lemonade installs, on a machine older than they are.
 *
 * The disk half of core/runtime/engineShim.ts: find what Lemonade put under
 * its `bin/` directory, ask whether this machine can actually start it, and if
 * not, copy in the C runtime MyRA already fetched for `lemond` and wrap the
 * binary so it runs through it.
 *
 * The runtime is COPIED from the daemon's own directory rather than fetched.
 * It is the same 30 MB from the same Ubuntu 24.04 image, it is already on the
 * disk of every machine this applies to -- the daemon would not be running
 * otherwise -- and copying works with no network, which matters because the
 * machines that need this are the ones where a speech model just failed and
 * the user is already out of patience.
 */

import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { LIBC_DIR, loaderName, missingVersions } from "../../core/runtime/libc.ts";
import { couldBeEngine, isShimScript, REAL_SUFFIX, shimScript } from "../../core/runtime/engineShim.ts";
import { bundledLoader, hostLibDirs, resolveSpec } from "./loader.ts";

/** One engine backend as Lemonade lays it out: `bin/<recipe>/<backend>/`. */
export interface EngineDir {
  path: string;
  recipe: string;
  backend: string;
}

/** Every engine backend installed under a Lemonade cache directory. */
export async function engineDirs(cacheDir: string): Promise<EngineDir[]> {
  const root = join(cacheDir, "bin");
  const out: EngineDir[] = [];
  for (const recipe of await readdir(root).catch(() => [])) {
    for (const backend of await readdir(join(root, recipe)).catch(() => [])) {
      const path = join(root, recipe, backend);
      if ((await stat(path).catch(() => undefined))?.isDirectory()) {
        out.push({ path, recipe, backend });
      }
    }
  }
  return out;
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * The executables in an engine directory, shims and libraries excluded.
 *
 * The ELF magic is read rather than trusted from the name because an engine
 * directory is not only binaries -- kokoro ships `espeak-ng-data/` and a
 * `version.txt` beside `koko` -- and because a shim we wrote earlier must be
 * recognised as a script, not renamed a second time.
 */
export async function engineBinaries(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!couldBeEngine(name)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || !(info.mode & 0o111)) continue;
    const head = await readFile(path).then((b) => b.subarray(0, 4)).catch(() => Buffer.alloc(0));
    if (head.equals(ELF)) out.push(name);
  }
  return out;
}

/**
 * Symbol versions this machine cannot give a binary, empty when it can run it.
 *
 * Traced rather than run. `probe()` in cruntime.ts starts the program with
 * `--version`, which is right for a daemon that prints one and wrong for
 * `whisper-server`, which would take the argument as a flag it does not know
 * or, worse, begin listening. A dependency trace answers the same question
 * without the program's own code ever executing.
 */
export async function tooOldForEngine(binary: string, dir: string): Promise<string[]> {
  const launch = resolveSpec(binary, dir);
  const text = await new Promise<string>((resolve) => {
    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...launch.env },
    });
    let out = "";
    const take = (b: Buffer): void => { out += b.toString(); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => resolve(out));
    child.on("close", () => resolve(out));
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref?.();
  });
  return missingVersions(text);
}

/** Copy the daemon's C runtime into an engine directory. */
async function copyRuntime(from: string, to: string): Promise<boolean> {
  const loader = loaderName(process.arch);
  const source = join(from, LIBC_DIR);
  const names = await readdir(source).catch(() => []);
  if (!names.length) return false;

  await mkdir(join(to, LIBC_DIR), { recursive: true });
  for (const name of names) {
    await copyFile(join(source, name), join(to, LIBC_DIR, name));
    await chmod(join(to, LIBC_DIR, name), 0o755).catch(() => undefined);
  }
  await copyFile(join(from, loader), join(to, loader));
  await chmod(join(to, loader), 0o755);
  return true;
}

/**
 * Wrap one engine directory's binaries so they run under the bundled runtime.
 *
 * Returns the names wrapped. Idempotent: a binary that is already a shim is
 * left alone, so this can run on every launch and after every install without
 * nesting one wrapper inside another.
 */
export async function wrapEngine(dir: string, runtimeFrom: string): Promise<string[]> {
  await healOrphans(dir);
  const binaries = await engineBinaries(dir);
  if (!binaries.length) return [];
  if (!(await copyRuntime(runtimeFrom, dir))) return [];

  const spec = { arch: process.arch, hostDirs: hostLibDirs() };
  const wrapped: string[] = [];
  for (const name of binaries) {
    const path = join(dir, name);
    await rename(path, join(dir, name + REAL_SUFFIX));
    await writeFile(path, shimScript(name, spec), { mode: 0o755 });
    await chmod(path, 0o755);
    wrapped.push(name);
  }
  return wrapped;
}

export interface EngineRepair {
  recipe: string;
  backend: string;
  /** The binaries wrapped, or empty when this one was already fine. */
  wrapped: string[];
  /** What the machine could not satisfy, for the log. */
  missing: string[];
}

/**
 * Make every installed engine startable, and say what had to be done.
 *
 * Does nothing at all on a machine whose own C library is new enough, which is
 * decided by looking for the loader MyRA shipped beside `lemond` -- the same
 * on-disk test `launchSpec` uses to decide how to start the daemon, so the two
 * can never disagree about what kind of machine this is.
 */
export async function repairEngines(
  cacheDir: string,
  lemondDir: string,
): Promise<EngineRepair[]> {
  if (process.platform !== "linux") return [];
  if (!bundledLoader(lemondDir)) return [];

  const out: EngineRepair[] = [];
  for (const engine of await engineDirs(cacheDir)) {
    /*
     * An empty list means everything here is already wrapped -- a shim is a
     * shell script, so it is not an ELF executable, and the renamed binary is
     * excluded by name. Deriving it this way rather than looking for a
     * `.myra-real` file also survives the case that would otherwise strand a
     * user: Lemonade upgrading an engine writes fresh binaries over the shims
     * and leaves the renamed originals behind, so a directory that merely
     * CONTAINS one is not necessarily wrapped any more.
     */
    /* Before deciding there is nothing to do: an interrupted wrap leaves a
       renamed binary and no shim, which looks like an empty directory. */
    await healOrphans(engine.path).catch(() => []);
    const binaries = await engineBinaries(engine.path);
    if (!binaries.length) continue;

    const missing = new Set<string>();
    for (const name of binaries) {
      for (const v of await tooOldForEngine(join(engine.path, name), engine.path)) missing.add(v);
    }
    if (!missing.size) continue;

    const wrapped = await wrapEngine(engine.path, lemondDir);
    out.push({ recipe: engine.recipe, backend: engine.backend, wrapped, missing: [...missing] });
  }
  return out;
}

/**
 * Undo a wrap that was interrupted between its two steps.
 *
 * The binary is renamed and then the shim is written, so a crash, a full disk
 * or a kill in between leaves `whisper-server.myra-real` with nothing at
 * `whisper-server`. That state is worse than either end of it: the engine is
 * gone, and because `engineBinaries` skips the renamed file there is nothing
 * left for the next pass to find, so it would stay gone. Putting the binary
 * back makes the wrap retryable instead of one-way.
 */
export async function healOrphans(dir: string): Promise<string[]> {
  const names: string[] = await readdir(dir).catch(() => []);
  const healed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(REAL_SUFFIX)) continue;
    const base = name.slice(0, -REAL_SUFFIX.length);
    if (names.includes(base)) continue; // The shim is there; nothing to undo.
    await rename(join(dir, name), join(dir, base));
    healed.push(base);
  }
  return healed;
}

/** Whether a directory holds one of our shims, for tests and for the pane. */
export async function isWrapped(dir: string): Promise<boolean> {
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(REAL_SUFFIX)) continue;
    const shim = join(dir, name.slice(0, -REAL_SUFFIX.length));
    const text = await readFile(shim, "utf8").catch(() => "");
    if (isShimScript(text)) return true;
  }
  return false;
}
