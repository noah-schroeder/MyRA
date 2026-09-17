/**
 * In-app keyboard shortcuts for dictation and speech-to-speech.
 *
 * Renderer-only, on purpose: Electron's `globalShortcut` does not work on
 * GNOME Wayland (see src/main/dictation.ts), which is why v1's GNOME
 * `gsettings` keybinding was abandoned rather than ported. These shortcuts
 * fire only while the MyRA window is focused, and this module owns the one
 * thing that has to be right for that to work: the combo a keypress is
 * turned into, and the combo stored in Settings, are always the same string.
 *
 * No imports: core must never import electron, and this file must not name a
 * DOM type either, so `src/renderer` can pass a real KeyboardEvent and
 * `src/core/config.ts` can parse a string from disk without either side
 * pulling in the other's types.
 */

/** The handful of KeyboardEvent fields the format actually needs. */
export interface KeyChord {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}

export interface HotkeySettings {
  /** Canonical combo, e.g. "Ctrl+Shift+D". Empty means no shortcut is set. */
  dictation: string;
  dictationMode: "toggle" | "hold";
  /** Canonical combo for speech-to-speech. Always a toggle -- see hold-to-talk
   *  note on `dictationMode`; hands-free has no recording for a hold to bound. */
  handsFree: string;
}

export const DEFAULT_HOTKEYS: HotkeySettings = {
  dictation: "",
  dictationMode: "toggle",
  handsFree: "",
};

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

/* `code` names for the punctuation keys, mapped to the glyph on a US keyboard.
   `.key` is not used anywhere in this module -- it is layout- and
   shift-dependent, so a combo recorded without Shift would not match the same
   physical key pressed with it. */
const CODE_LABELS: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Backquote: "`", Space: "Space",
};

function labelForCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_LABELS[code] ?? code;
}

/** Fixed order, so one chord has exactly one spelling. */
function modifierPrefix(c: KeyChord): string[] {
  const mods: string[] = [];
  if (c.ctrlKey) mods.push("Ctrl");
  if (c.altKey) mods.push("Alt");
  if (c.shiftKey) mods.push("Shift");
  if (c.metaKey) mods.push("Super");
  return mods;
}

/** The canonical combo for a chord, or `undefined` if the key itself is a
 *  bare modifier -- pressing Shift alone is not a shortcut. */
export function comboFromChord(c: KeyChord): string | undefined {
  if (MODIFIER_CODES.has(c.code)) return undefined;
  return [...modifierPrefix(c), labelForCode(c.code)].join("+");
}

const FUNCTION_KEY = /^F(1[0-9]?|2[0-4]?|[1-9])$/;

/**
 * The stricter check used only while recording a new shortcut.
 *
 * A bare letter would fire on every keystroke while typing, so capture
 * refuses one unless the key itself has no ordinary meaning as text (an
 * F-key). Modifier-only presses are not a failure -- they are the user
 * getting their fingers into position -- so they are reported separately
 * from an actual rejection.
 */
export function captureCombo(c: KeyChord): { ok: true; combo: string } | { ok: false; reason: string } {
  if (MODIFIER_CODES.has(c.code)) return { ok: false, reason: "" };
  const combo = comboFromChord(c);
  if (!combo) return { ok: false, reason: "" };
  const hasModifier = c.ctrlKey || c.altKey || c.shiftKey || c.metaKey;
  const key = labelForCode(c.code);
  if (!hasModifier && !FUNCTION_KEY.test(key)) {
    return { ok: false, reason: "Add a modifier key (Ctrl, Alt, Shift, or Super) so this doesn't fire while typing." };
  }
  return { ok: true, combo };
}

/** Exact match on modifiers: "Ctrl+Shift+D" does not fire with Alt also held. */
export function matches(combo: string, c: KeyChord): boolean {
  return combo !== "" && comboFromChord(c) === combo;
}

const MODIFIER_TOKENS = new Set(["Ctrl", "Alt", "Shift", "Super"]);
const PUNCTUATION_KEYS = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/** A key token is either plain alphanumerics (letters, digits, "F9", "Space",
 *  "ArrowUp", ...) or one of the single punctuation glyphs this module emits.
 *  Anything else -- notably the v1 GNOME format's "<Super>d" -- is not a
 *  token this module could have produced, so it is not a combo. */
function isValidKeyToken(k: string): boolean {
  return /^[A-Za-z0-9]+$/.test(k) || (k.length === 1 && PUNCTUATION_KEYS.has(k));
}

/** The non-modifier key in a combo, e.g. "D" for "Ctrl+Shift+D". */
export function mainKey(combo: string): string {
  const parts = combo.split("+");
  return parts[parts.length - 1] ?? "";
}

/** The modifier tokens in a combo, e.g. ["Ctrl", "Shift"] for "Ctrl+Shift+D". */
export function modifiersOf(combo: string): string[] {
  return combo.split("+").filter((p) => MODIFIER_TOKENS.has(p));
}

/**
 * Re-canonicalises a stored value, or returns "" for anything that isn't one
 * of ours -- including the v1 GNOME `gsettings` format ("<Super>d"), which is
 * a keybinding this build has no way to honour.
 */
export function normalizeCombo(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const mods = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") mods.add("Ctrl");
    else if (lower === "alt") mods.add("Alt");
    else if (lower === "shift") mods.add("Shift");
    else if (lower === "super" || lower === "meta" || lower === "cmd") mods.add("Super");
    else if (key === undefined) key = part;
    else return ""; // more than one non-modifier token is not a combo
  }
  if (key === undefined || !isValidKeyToken(key)) return "";
  const label = key.length === 1 ? key.toUpperCase() : key;
  const order = ["Ctrl", "Alt", "Shift", "Super"].filter((m) => mods.has(m));
  return [...order, label].join("+");
}

/** "Ctrl + Shift + D", for display. */
export function prettyCombo(combo: string): string {
  return combo.split("+").join(" + ");
}

/* Combos the window manager, the browser shell, or Chromium's own devtools
   binding is likely to consume before this app ever sees the keydown. This
   is advisory only -- it warns in the Settings UI and stores the combo
   anyway, because blocking it would fail on desktops where it isn't taken. */
const LIKELY_TAKEN = new Set([
  "Ctrl+W", "Ctrl+Q", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+Shift+I", "Ctrl+Shift+J",
  "Ctrl+N", "Ctrl+T", "F5", "F11", "F12", "Alt+F4",
  "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z",
]);

export function likelyTaken(combo: string): string | undefined {
  return LIKELY_TAKEN.has(combo)
    ? "This combination is commonly used by the desktop or the browser shell, and MyRA may never see it."
    : undefined;
}

/** The hotkeys block, rebuilt field by field -- same discipline as parseAudio. */
export function parseHotkeys(raw: unknown): HotkeySettings {
  const base = DEFAULT_HOTKEYS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base };
  const row = raw as Record<string, unknown>;
  const mode = row["dictationMode"] === "hold" ? "hold" : "toggle";
  return {
    dictation: normalizeCombo(row["dictation"]),
    dictationMode: mode,
    handsFree: normalizeCombo(row["handsFree"]),
  };
}
