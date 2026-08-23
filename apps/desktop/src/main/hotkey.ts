/**
 * A global dictation hotkey on GNOME Wayland.
 *
 * Electron's `globalShortcut` DOES NOT WORK HERE (electron#51875), and neither
 * does Tauri's equivalent: on Wayland a client cannot grab a key it does not
 * own, and GNOME's GlobalShortcuts portal rejects application IDs that are not
 * reverse-DNS. This is not a bug to work around in the app; it is the platform
 * refusing, correctly, to let any window snoop the keyboard.
 *
 * So the shortcut is registered with the desktop instead, as a GNOME custom
 * keybinding that runs `karen-ctl dictate-toggle`. The compositor owns the key
 * and Karen owns the command. It works today, survives restarts, and shows up
 * in GNOME's own Keyboard settings where the user can see and change it.
 *
 * Everything here is done with `gsettings`, and every write is reversible.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM = `${MEDIA_KEYS}.custom-keybinding`;
/** Our slot. Named so a human reading dconf knows what put it there. */
const PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/karen-dictate/";

export class HotkeyError extends Error {
  override readonly name = "HotkeyError";
}

export interface HotkeyState {
  /** False when this desktop cannot register one at all. */
  supported: boolean;
  installed: boolean;
  binding?: string;
  command?: string;
  reason?: string;
}

async function gsettings(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gsettings", args, { timeout: 10_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new HotkeyError("gsettings is not available on this desktop");
    throw new HotkeyError((e.stderr ?? e.message ?? "").trim() || "gsettings failed");
  }
}

/** dconf list values print as ['a', 'b']; parse without eval. */
export function parseList(value: string): string[] {
  if (!value || value === "@as []" || value === "[]") return [];
  return [...value.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/*
 * There are TWO layers of quoting here and they are easy to conflate.
 *
 *  1. gsettings parses the VALUE it is given as a GVariant. A bare string is
 *     usually accepted, but one that begins with a quote is read as a quoted
 *     GVariant and then trips over its own trailing text.
 *  2. GNOME later parses the stored command with g_shell_parse_argv, which is
 *     where a path containing a space has to be quoted.
 *
 * So the command is shell-quoted by the caller, and then EVERY value is
 * GVariant-quoted here. Getting only one of the two right produces a binding
 * that installs cleanly and silently does nothing.
 */
export function gvariantString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatList(items: string[]): string {
  return `[${items.map(gvariantString).join(", ")}]`;
}

/** gsettings prints strings quoted; undo whichever quote style it used. */
export function unquote(value: string): string {
  const m = /^'(.*)'$/.exec(value) ?? /^"(.*)"$/.exec(value);
  if (!m) return value;
  return m[1]!.replace(/\\(.)/g, "$1");
}

export async function hotkeyState(): Promise<HotkeyState> {
  try {
    const list = parseList(await gsettings(["get", MEDIA_KEYS, "custom-keybindings"]));
    if (!list.includes(PATH)) return { supported: true, installed: false };
    const binding = unquote(await gsettings(["get", `${CUSTOM}:${PATH}`, "binding"]));
    const command = unquote(await gsettings(["get", `${CUSTOM}:${PATH}`, "command"]));
    return { supported: true, installed: Boolean(binding), binding, command };
  } catch (err) {
    return { supported: false, installed: false, reason: (err as Error).message };
  }
}

/**
 * Install or update the binding.
 *
 * Idempotent, and careful with the list: other applications register their own
 * custom keybindings in the same array, so it is read, added to, and written
 * back rather than replaced.
 */
export async function installHotkey(binding: string, command: string): Promise<HotkeyState> {
  if (!binding.trim()) throw new HotkeyError("no key combination given");

  const list = parseList(await gsettings(["get", MEDIA_KEYS, "custom-keybindings"]));
  if (!list.includes(PATH)) {
    await gsettings(["set", MEDIA_KEYS, "custom-keybindings", formatList([...list, PATH])]);
  }
  await gsettings(["set", `${CUSTOM}:${PATH}`, "name", gvariantString("Karen: dictate")]);
  await gsettings(["set", `${CUSTOM}:${PATH}`, "command", gvariantString(command)]);
  await gsettings(["set", `${CUSTOM}:${PATH}`, "binding", gvariantString(binding)]);
  return hotkeyState();
}

/** Remove it completely, leaving anyone else's bindings untouched. */
export async function removeHotkey(): Promise<HotkeyState> {
  const list = parseList(await gsettings(["get", MEDIA_KEYS, "custom-keybindings"]));
  if (list.includes(PATH)) {
    await gsettings([
      "set", MEDIA_KEYS, "custom-keybindings",
      formatList(list.filter((p) => p !== PATH)),
    ]);
  }
  // Clear the values too, so a reinstall does not inherit a stale command.
  await gsettings(["reset-recursively", `${CUSTOM}:${PATH}`]).catch(() => "");
  return hotkeyState();
}

/**
 * Bindings already claimed elsewhere in GNOME.
 *
 * Registering a duplicate is not an error in dconf -- the shortcut simply does
 * nothing, or the other one wins, which is a maddening thing to debug. Worth
 * saying up front.
 */
export async function conflicts(binding: string): Promise<string[]> {
  const found: string[] = [];
  // Scan each schema WHOLE rather than a hand-picked list of keys. A hardcoded
  // list is guaranteed to miss something -- GNOME versions differ, and the
  // shortcut the user actually collided with is always the one not on the list.
  const schemas = [
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.shell.keybindings",
    "org.gnome.mutter.keybindings",
    "org.gnome.mutter.wayland.keybindings",
    MEDIA_KEYS,
  ];
  for (const schema of schemas) {
    let dump: string;
    try {
      dump = await gsettings(["list-recursively", schema]);
    } catch {
      continue; // schema absent on this GNOME version
    }
    for (const line of dump.split("\n")) {
      // "<schema> <key> <value>"
      const match = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, , key, value] = match;
      if (key === "custom-keybindings") continue;
      if (parseList(value!).includes(binding) || unquote(value!) === binding) {
        found.push(`${schema} → ${key}`);
      }
    }
  }

  // Another application's custom binding on the same keys.
  try {
    for (const path of parseList(await gsettings(["get", MEDIA_KEYS, "custom-keybindings"]))) {
      if (path === PATH) continue;
      const b = unquote(await gsettings(["get", `${CUSTOM}:${path}`, "binding"]));
      if (b === binding) {
        const name = unquote(await gsettings(["get", `${CUSTOM}:${path}`, "name"]));
        found.push(`custom keybinding “${name || path}”`);
      }
    }
  } catch {
    /* nothing to add */
  }
  return found;
}
