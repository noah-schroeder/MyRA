/**
 * Running upstream's CUDA build on a Linux older than the one it was built on.
 *
 * The failure this exists for, reported from a real machine with an RTX 4060, a
 * 580 driver and a CUDA 13.0 ceiling -- every version check passing, and no GPU
 * found:
 *
 *     llama-server: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not
 *       found (required by .../libllama-server-impl.so)
 *     llama-server: /lib/x86_64-linux-gnu/libstdc++.so.6: version
 *       `GLIBCXX_3.4.32' not found (required by .../libllama-common.so)
 *
 * The card was never the problem. Upstream's container is built on Ubuntu
 * 24.04 (glibc 2.39, libstdc++ 6.0.33) and the binaries will not load at all on
 * anything older -- so the CUDA backend never gets as far as looking for a
 * device, and ggml's "no GPU" is reported for a machine with a perfectly good
 * one. Vulkan works there only because it comes from a GitHub release asset,
 * built on an older runner.
 *
 * Since a C library cannot be installed for someone, the build brings its own.
 * That is only half the trick, and the other half is not optional:
 *
 * **The loader and libc must be replaced together.** Dropping a newer libc.so.6
 * beside the binary and pointing LD_LIBRARY_PATH at it pairs the host's
 * `ld-linux` with a libc it does not match, and the process dies on
 * `undefined symbol: __nptl_change_stack_perm, version GLIBC_PRIVATE`. Measured
 * here, not reasoned about. The supported way is to invoke the bundled loader
 * as the program and hand it the binary:
 *
 *     ld-linux-x86-64.so.2 --library-path <libc>:<app>:<host…> llama-server …
 *
 * Which is why the C LIBRARIES live in their own subdirectory: `--library-path`
 * is the only thing that ever names it, so no ordinary launch can pick up a
 * libc that does not match the loader running it.
 *
 * The LOADER, though, has to sit beside the binary, and that took a second
 * round to find. Running through a loader changes what `/proc/self/exe` points
 * at -- it becomes the loader, not the program -- and that is exactly how ggml
 * finds its backends: it looks for `libggml-*.so` in the directory of the
 * running executable. With the loader in a subdirectory ggml searched THAT
 * directory, found no backends at all, and reported "Available devices:
 * (none)" -- the same silence as before, now for a completely different
 * reason. Measured: 28 backends loaded natively, 0 through a loader one
 * directory down, 28 again with the loader beside the binary.
 *
 * `GGML_BACKEND_PATH` does not rescue this; it was tried and changed nothing.
 *
 * Keeping the loader beside the binary and the libraries below it gives both
 * properties at once: ggml's search lands in the right directory, and no
 * `libc.so.6` is ever sitting somewhere an ordinary LD_LIBRARY_PATH launch
 * could find it.
 *
 * `--library-path` also REPLACES the system search rather than extending it,
 * so the host directories have to be listed explicitly -- including whatever
 * `/etc/ld.so.conf.d` adds, which is exactly where NVIDIA's packages put the
 * driver's own `libcuda.so.1`. Missing that would trade one invisible failure
 * for another.
 */

/** Where the bundled C libraries sit, relative to the binary. */
export const LIBC_DIR = "libc";

/** The dynamic loader's name, which is architecture-specific. */
export function loaderName(arch: string): string {
  return arch === "arm64" || arch === "aarch64"
    ? "ld-linux-aarch64.so.1"
    : "ld-linux-x86-64.so.2";
}

/** The GNU triplet directory a distribution puts its libraries in. */
export function gnuTriplet(arch: string): string {
  return arch === "arm64" || arch === "aarch64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
}

/**
 * What to take out of the base image, and nothing more.
 *
 * Anchored under `usr/lib/<triplet>/` on purpose: the same names exist in
 * `usr/lib64/` as relative symlinks pointing back out of the directory, and
 * flattening those into one directory would leave a link to nowhere sitting on
 * top of the real loader.
 *
 * The list is glibc plus the C++ runtime -- what the build's own libraries
 * declare versioned dependencies on. Everything else (libgomp, libssl, libz)
 * is taken from the host, where it matches the host's kernel and its own
 * packaging; those link against long-stable interfaces and load into a newer
 * glibc without complaint.
 */
export function cRuntimePatterns(arch: string): string[] {
  const t = gnuTriplet(arch);
  return [
    `usr/lib/${t}/${loaderName(arch)}`,
    `usr/lib/${t}/libc.so.6`,
    `usr/lib/${t}/libm.so.6`,
    `usr/lib/${t}/libdl.so.2`,
    `usr/lib/${t}/libpthread.so.0`,
    `usr/lib/${t}/librt.so.1`,
    `usr/lib/${t}/libresolv.so.2`,
    `usr/lib/${t}/libgcc_s.so.*`,
    `usr/lib/${t}/libstdc++.so.*`,
  ];
}

/**
 * The libraries that must be present, inside LIBC_DIR, for the bundle to work.
 *
 * The loader is not in this list because it does not live here: it belongs
 * beside the binary, so that ggml's backend search finds the build's own
 * directory rather than this one.
 */
export function cRuntimeEssentials(): string[] {
  return ["libc.so.6", "libm.so.6", "libstdc++.so.6"];
}

/** A shared object, as opposed to the gdb helper script shipped beside one. */
export function isSharedObject(name: string): boolean {
  return /\.so(\.\d+)*$/.test(name);
}

/**
 * Symbol versions the loader could not satisfy, from a failed run.
 *
 * These are the only reliable sign of this fault: `ldd` reports a soname it
 * cannot find, but a library that IS found and is merely too old resolves
 * cleanly and fails at the point of use.
 */
export function missingVersions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/version `([A-Za-z_]+_[\d.]+)' not found/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/** Whether a probe failed because the system is older than the build. */
export function isTooOld(text: string): boolean {
  return missingVersions(text).length > 0;
}

/**
 * Sonames the loader could not find, from a dependency trace.
 *
 * Two forms, because the loader has two moods and only one of them looks like
 * `ldd`:
 *
 *     libcudart.so.12 => not found                       (tracing)
 *     libcudart.so.12: cannot open shared object file     (giving up)
 *
 * Reading only the first is how a machine with no CUDA at all was reported as
 * already having it -- four missing libraries seen as none, an install that
 * could not load, and "no graphics acceleration was found" at the end of it.
 */
export function parseMissingLibraries(text: string): string[] {
  const missing = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const traced = /^\s*(\S+)\s*=>\s*not found/.exec(line);
    if (traced?.[1]) missing.add(traced[1]);
    const aborted = /(\S+\.so[.\d]*): cannot open shared object file/.exec(line);
    if (aborted?.[1]) missing.add(aborted[1]);
  }
  return [...missing];
}

/**
 * Directories named by `/etc/ld.so.conf` and the files it includes.
 *
 * Only the directory lines: `include` lines are returned separately because
 * resolving a glob is the caller's job, and comments and blanks are dropped.
 */
export function parseLdSoConf(text: string): { dirs: string[]; includes: string[] } {
  const dirs: string[] = [];
  const includes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const inc = /^include\s+(.+)$/.exec(line);
    if (inc?.[1]) includes.push(inc[1].trim());
    else if (line.startsWith("/")) dirs.push(line);
  }
  return { dirs, includes };
}

/** Where libraries live on a system that says nothing about it. */
export function defaultLibDirs(arch: string): string[] {
  const t = gnuTriplet(arch);
  return [`/usr/lib/${t}`, `/lib/${t}`, "/usr/lib64", "/lib64", "/usr/lib", "/lib"];
}

/** Order the search path, nearest first, without repeating a directory. */
export function searchPath(bundle: string, app: string, host: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [bundle, app, ...host]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

/** What to tell someone whose system is older than the build they installed. */
export function explainTooOld(versions: string[]): string {
  const which = versions.length ? ` (${versions.join(", ")})` : "";
  return (
    `This CUDA build was compiled on a newer Linux than the one on this machine, so its ` +
    `libraries cannot load${which} — which is why no graphics card was found, even though ` +
    `yours is working. Install the CUDA build again and MyRA will bring the C library it ` +
    `needs along with it.`
  );
}
