import assert from "node:assert/strict";
import test from "node:test";

import {
  captureCombo, comboFromChord, likelyTaken, mainKey, matches,
  modifiersOf, normalizeCombo, prettyCombo, type KeyChord,
} from "../src/core/hotkeys.ts";

function chord(partial: Partial<KeyChord> & { code: string }): KeyChord {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial };
}

test("modifier order is fixed regardless of which flags are set", () => {
  assert.equal(comboFromChord(chord({ code: "KeyD", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+D");
  // Flags set in the opposite order still produce the same string.
  assert.equal(comboFromChord(chord({ code: "KeyD", shiftKey: true, ctrlKey: true })), "Ctrl+Shift+D");
});

test("a bare modifier press is not a combo", () => {
  assert.equal(comboFromChord(chord({ code: "ShiftLeft", shiftKey: true })), undefined);
  assert.equal(comboFromChord(chord({ code: "ControlRight", ctrlKey: true })), undefined);
});

test("capture refuses a bare letter but accepts a bare function key", () => {
  const bareLetter = captureCombo(chord({ code: "KeyD" }));
  assert.equal(bareLetter.ok, false);
  if (!bareLetter.ok) assert.ok(bareLetter.reason.length > 0);

  const bareF9 = captureCombo(chord({ code: "F9" }));
  assert.deepEqual(bareF9, { ok: true, combo: "F9" });

  const modified = captureCombo(chord({ code: "KeyD", ctrlKey: true, shiftKey: true }));
  assert.deepEqual(modified, { ok: true, combo: "Ctrl+Shift+D" });
});

test("capture reports a modifier-only press as not-yet-a-failure", () => {
  const result = captureCombo(chord({ code: "ShiftLeft", shiftKey: true }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "");
});

test("matches is exact on modifiers", () => {
  assert.equal(matches("Ctrl+Shift+D", chord({ code: "KeyD", ctrlKey: true, shiftKey: true })), true);
  // Alt also held is a different chord, not a superset match.
  assert.equal(matches("Ctrl+Shift+D", chord({ code: "KeyD", ctrlKey: true, shiftKey: true, altKey: true })), false);
  assert.equal(matches("", chord({ code: "KeyD", ctrlKey: true })), false);
});

test("the combo names the physical key, not the shifted character", () => {
  // Digit1 is "1" whether or not Shift is held -- .key would report "!" with
  // Shift down, which would make a combo recorded without Shift never match.
  assert.equal(comboFromChord(chord({ code: "Digit1" })), "1");
  assert.equal(comboFromChord(chord({ code: "Digit1", shiftKey: true })), "Shift+1");
});

test("normalizeCombo drops the v1 GNOME format and garbage input", () => {
  assert.equal(normalizeCombo("<Super>d"), "");
  assert.equal(normalizeCombo(42), "");
  assert.equal(normalizeCombo(""), "");
  assert.equal(normalizeCombo(undefined), "");
});

test("normalizeCombo re-canonicalises case and order", () => {
  assert.equal(normalizeCombo("ctrl+shift+d"), "Ctrl+Shift+D");
  assert.equal(normalizeCombo("shift+ctrl+d"), "Ctrl+Shift+D");
  assert.equal(normalizeCombo("F9"), "F9");
});

test("mainKey and modifiersOf round-trip a combo", () => {
  assert.equal(mainKey("Ctrl+Shift+D"), "D");
  assert.deepEqual(modifiersOf("Ctrl+Shift+D"), ["Ctrl", "Shift"]);
  assert.equal(mainKey("F9"), "F9");
  assert.deepEqual(modifiersOf("F9"), []);
});

test("prettyCombo is a display string, not a stored one", () => {
  assert.equal(prettyCombo("Ctrl+Shift+D"), "Ctrl + Shift + D");
});

test("likelyTaken warns on common combos and stays quiet otherwise", () => {
  assert.ok(likelyTaken("Ctrl+W"));
  assert.equal(likelyTaken("Ctrl+Shift+D"), undefined);
});
