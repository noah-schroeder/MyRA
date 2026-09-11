/**
 * Giving Lemonade's engines the C runtime MyRA already carries.
 *
 * MyRA ships a glibc beside `lemond` when the host's is older than the
 * GLIBC_2.38 the embeddable needs, and starts the daemon through that loader.
 * The engines Lemonade downloads afterwards are built the same way and get
 * none of it, because **Lemonade starts them itself** -- MyRA never sees the
 * spawn and cannot wrap it.
 *
 * Measured on the released binaries, which is what makes this worth solving
 * rather than documenting:
 *
 *     whisper-server v1.8.4   GLIBC_2.38   GLIBCXX_3.4.32
 *     koko (kokoro) b17       GLIBC_2.38   GLIBCXX_3.4.30
 *     llama-server b10375     GLIBC_2.34   GLIBCXX_3.4.21
 *
 * So on Ubuntu 22.04 (2.35) chat works perfectly and every speech or image
 * model dies on startup with exit code 1, which reads as "MyRA is broken"
 * rather than "this machine is older than that build". Reported from exactly
 * such a machine.
 *
 * Since the spawn cannot be intercepted, the binary is replaced by a script
 * that re-execs it through the bundled loader. `exec` matters: Lemonade keeps
 * the pid it is given and kills the process by it, so the shell must become
 * the engine rather than parent it.
 *
 * The loader is copied INTO the engine's own directory, not referenced where
 * it sits beside lemond, and that placement is the whole trick working twice:
 * ggml looks for `libggml-vulkan.so` relative to `/proc/self/exe`, which under
 * a bundled loader is the loader. Put it anywhere else and whisper-server
 * starts and then finds no backend. See core/runtime/libc.ts, where the same
 * rule was learned on ggml itself.
 */

import { LIBC_DIR, loaderName } from "./libc.ts";

/**
 * What the real binary is renamed to.
 *
 * Kept beside the shim rather than hidden in a subdirectory, because ggml's
 * backend search is relative to the executable's directory either way and one
 * fewer moving part is one fewer thing to get wrong on the next engine.
 */
export const REAL_SUFFIX = ".myra-real";

/** The line that identifies a shim as ours, so it is never renamed as a binary. */
export const SHIM_MARK = "# MyRA: run this engine through the bundled C runtime.";

export interface ShimSpec {
  /** Architecture, for the loader's name. */
  arch: string;
  /** Absolute directories to search after the bundle and the engine's own. */
  hostDirs: string[];
}

/**
 * The script that replaces the engine binary.
 *
 * Paths are resolved from `$0` at run time rather than baked in: an engine
 * directory lives under the user's home, and a home that moves -- a restored
 * backup, a renamed account -- would otherwise leave every engine pointing at
 * a directory that no longer exists.
 */
export function shimScript(name: string, spec: ShimSpec): string {
  /* The bundle first, then the engine's own directory, then the host's --
     `--library-path` REPLACES the loader's search rather than adding to it, so
     anything left out here is simply not found. */
  const path = `$d/${LIBC_DIR}:$d:${spec.hostDirs.join(":")}`;
  return [
    "#!/bin/sh",
    SHIM_MARK,
    "# The real binary is beside this file, with the suffix above appended.",
    'd=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
    `exec "$d/${loaderName(spec.arch)}" --library-path "${path}" ` +
      `"$d/${name}${REAL_SUFFIX}" "$@"`,
    "",
  ].join("\n");
}

/** Whether a file at an engine binary's name is one of our scripts. */
export function isShimScript(text: string): boolean {
  return text.startsWith("#!/bin/sh") && text.includes(SHIM_MARK);
}

/**
 * Whether this file could be an engine to wrap.
 *
 * Names only -- the caller checks the ELF header and the executable bit. The
 * exclusions are the two that would break things rather than merely waste
 * effort: wrapping a shared object produces a library nothing can load, and
 * wrapping an already-renamed binary would nest a shim inside a shim on the
 * second run.
 */
export function couldBeEngine(name: string): boolean {
  if (name.endsWith(REAL_SUFFIX)) return false;
  if (/\.so(\.\d+)*$/.test(name)) return false;
  return !name.startsWith(loaderName("x64")) && !name.startsWith(loaderName("arm64"));
}
