/**
 * How a llama.cpp build is actually invoked.
 *
 * For every build Karen installs from a release asset this is "run the binary",
 * and the only help it needs is LD_LIBRARY_PATH pointing at its own directory.
 *
 * The CUDA build taken from upstream's container image can need more, because
 * it is compiled on Ubuntu 24.04 and will not load on anything older. When the
 * install has brought a C runtime along, the build is started through THAT
 * loader instead of the system's — see core/runtime/libc.ts for why the two
 * cannot be separated.
 *
 * The decision is made by looking for the bundle on disk rather than by
 * remembering a flag, so an install that predates this behaviour keeps running
 * exactly as it did.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  defaultLibDirs, LIBC_DIR, loaderName, parseLdSoConf, searchPath,
} from "../../core/runtime/libc.ts";

export interface Launch {
  command: string;
  args: string[];
  /** Extra environment, to merge over `process.env`. */
  env: Record<string, string | undefined>;
}

/**
 * The environment a llama.cpp build needs to find its own shared libraries.
 *
 * Necessary because of one detail in the CUDA build taken from upstream's
 * container image: its RUNPATH is the absolute `/app/build/bin:`, the path
 * inside the image where it was compiled. That directory does not exist on a
 * user's machine, so without this the loader finds nothing beside the binary
 * and the CUDA backend silently does not load -- which presents as "no GPU
 * detected" on a machine with a perfectly good card, the worst possible
 * symptom because it looks like an answer rather than a fault.
 *
 * Harmless for the release-asset builds, which find their libraries anyway.
 */
export function libraryEnv(binary: string): Record<string, string | undefined> {
  if (process.platform === "win32") return {};
  const dir = dirname(binary);
  const key = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const existing = process.env[key];
  return { [key]: existing ? `${dir}:${existing}` : dir };
}

/**
 * Every directory the system itself would search.
 *
 * `--library-path` replaces the loader's search rather than adding to it, so
 * this has to be complete: the NVIDIA driver's `libcuda.so.1` is found through
 * a file in `/etc/ld.so.conf.d` on several distributions, and a build that
 * cannot find the driver reports no GPU — the same silence this whole change
 * exists to remove.
 */
export function hostLibDirs(arch: string = process.arch, etc = "/etc"): string[] {
  const dirs: string[] = [];
  const read = (path: string): void => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const { dirs: found, includes } = parseLdSoConf(text);
    dirs.push(...found);
    for (const pattern of includes) {
      /* `include ld.so.conf.d/*.conf`: only the directory part is used, and
         every .conf in it is read. Globbing properly would need a dependency
         to reach the same answer. */
      const dir = pattern.startsWith("/") ? dirname(pattern) : join(etc, dirname(pattern));
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) if (name.endsWith(".conf")) read(join(dir, name));
    }
  };
  read(join(etc, "ld.so.conf"));
  return [...dirs, ...defaultLibDirs(arch)];
}

/** Whether an installed build carries its own C runtime. */
export function bundledLoader(dir: string): string | undefined {
  if (process.platform !== "linux") return undefined;
  const path = join(dir, LIBC_DIR, loaderName(process.arch));
  return existsSync(path) ? path : undefined;
}

/** How to start this build, with its arguments. */
export function launchSpec(binary: string, args: string[]): Launch {
  const dir = dirname(binary);
  const loader = bundledLoader(dir);
  if (!loader) return { command: binary, args, env: libraryEnv(binary) };

  const path = searchPath(join(dir, LIBC_DIR), dir, hostLibDirs());
  /* LD_LIBRARY_PATH is ignored once --library-path is given; it is left unset
     rather than set-and-ignored so that nothing reading this back is misled. */
  return { command: loader, args: ["--library-path", path, binary, ...args], env: {} };
}

/**
 * How to ask what a library's dependencies resolve to.
 *
 * Deliberately the same loader and the same search path the build will use at
 * run time, rather than plain `ldd`. The two can disagree: `ldd` consults the
 * system cache, while `--library-path` replaces the search entirely, so a CUDA
 * runtime that ldd finds through `ldconfig` might not be found by the process
 * that matters. Asking the wrong one is how "you already have CUDA" turns into
 * "no GPU found" after the install has finished and it is too late to fix.
 */
export function resolveSpec(target: string, dir: string): Launch {
  const loader = bundledLoader(dir);
  if (!loader) {
    return {
      command: "ldd",
      args: [target],
      env: {
        LD_LIBRARY_PATH: [dir, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
      },
    };
  }
  const path = searchPath(join(dir, LIBC_DIR), dir, hostLibDirs());
  /*
   * `LD_TRACE_LOADED_OBJECTS`, not the loader's `--list` flag, and the
   * difference is not cosmetic: `--list` on a library whose dependencies are
   * missing stops at the first one with "cannot open shared object file" and
   * exits 127, so a parser looking for ldd's "=> not found" reads that as
   * nothing missing -- concluding the machine already has CUDA, installing a
   * build that cannot load, and reporting no GPU. Measured against a real
   * image, where ldd found four missing libraries and `--list` reported none.
   *
   * The environment variable is what ldd itself sets; it traces the whole
   * graph and lists every unresolved name at once.
   */
  return {
    command: loader,
    args: ["--library-path", path, target],
    env: { LD_TRACE_LOADED_OBJECTS: "1" },
  };
}
