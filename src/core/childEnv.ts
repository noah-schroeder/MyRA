/**
 * What a child process is allowed to inherit.
 *
 * MyRA spawns pandoc, pdftotext, tar, `ps`, the Lemonade daemon and whatever
 * inference engines that daemon starts. Every one of them inherited this
 * process's whole environment, which on a developer's or a researcher's
 * machine routinely holds `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `HF_TOKEN`
 * and the rest -- exported in a shell profile for entirely unrelated work.
 * pandoc does not need them and llama-server does not need them; handing them
 * over is the sort of thing nobody notices until a crash reporter or a verbose
 * log writes an environment block somewhere.
 *
 * MyRA does not sandbox its children at the OS level -- see
 * docs/threat-model.md for why that decision is what it is -- so this is not
 * confinement. It is the one piece of it that costs nothing and needs no
 * dependency.
 *
 * **An allowlist, never a denylist.** A denylist of `*_API_KEY` misses
 * `HF_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `GH_TOKEN` and whatever the next
 * provider decides to call its variable. The set of secrets is open and the
 * set of variables a child needs is small, so the small one is the one to
 * enumerate.
 */

/** Needed by anything at all: found on PATH, run in a locale, write a temp file. */
const ALWAYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TZ", "LANG", "LANGUAGE",
  "TMPDIR", "TEMP", "TMP",
];

/** Windows cannot start a process without most of these. */
const WIN32 = [
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROGRAMW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USERNAME",
];

/**
 * How a GPU is found, for the engines only.
 *
 * Wider than it looks because it has to be: a working Vulkan or ROCm setup on
 * somebody's workstation can depend on any of these, and a model that stops
 * using the card is a worse bug than an inherited variable.
 */
const GRAPHICS = [
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XAUTHORITY",
  "LD_LIBRARY_PATH", "LD_PRELOAD",
];

const GRAPHICS_PREFIXES = [
  "VK_", "CUDA_", "NVIDIA_", "HIP_", "ROCM_", "ROCR_", "HSA_", "GGML_", "MESA_",
  "AMD_", "GPU_", "OCL_", "DRI_", "LIBVA_", "__GL", "__NV",
];

/** Only lemond, which downloads models and may sit behind a corporate proxy. */
const NETWORK = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
];

export type ChildKind = "tool" | "engine";

/** `LC_*` is a family, and every member of it is a locale rather than a secret. */
function localeVariable(name: string): boolean {
  return name.startsWith("LC_");
}

function allowed(name: string, kind: ChildKind): boolean {
  const upper = name.toUpperCase();
  if (ALWAYS.includes(upper) || localeVariable(upper)) return true;
  if (process.platform === "win32" && WIN32.includes(upper)) return true;
  if (kind !== "engine") return false;
  if (GRAPHICS.includes(upper)) return true;
  if (NETWORK.includes(name)) return true;
  return GRAPHICS_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * The environment to give a child, plus anything the caller sets explicitly.
 *
 * `extra` goes on top and always wins: `LEMONADE_*` and the daemon's own key
 * are passed deliberately by their caller and are not guesswork.
 *
 * `MYRA_CHILD_ENV=inherit` turns the whole thing off. That is the escape hatch
 * for somebody whose GPU stack depends on a variable this list has not heard
 * of -- the same convention `MYRA_WORKSPACE` and `MYRA_TOOLS_DIR` already use,
 * and better than making them wait for a release to get their card back.
 */
export function scrubbedEnv(
  env: NodeJS.ProcessEnv,
  kind: ChildKind = "tool",
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  /* Dropped rather than passed through as the string "undefined", which is
     what a spread of a Record holding one would hand the child. */
  const set: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) set[name] = value;
  }

  if (env["MYRA_CHILD_ENV"] === "inherit") return { ...env, ...set };

  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed(name, kind)) out[name] = value;
  }
  return { ...out, ...set };
}
