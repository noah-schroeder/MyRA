/**
 * The document-wide listener for the dictation and speech-to-speech
 * shortcuts. It owns the mechanism only -- matching a keypress against a
 * combo, and the hold/release bookkeeping -- never the policy of whether an
 * action is allowed right now. That stays in App.tsx, in the same callbacks
 * the mic buttons already call, so the button and the hotkey are provably
 * the same code path rather than two copies that can drift apart.
 */

import { useEffect, useRef } from "react";
import { comboFromChord, mainKey, matches, modifiersOf } from "../core/hotkeys.ts";

export interface HotkeyBinding {
  /** "" disables this binding. */
  combo: string;
  /** Press starts, release stops. Omitted (or false) means a plain toggle. */
  hold?: boolean;
  onPress: () => void;
  onRelease?: () => void;
}

interface HeldBinding {
  mainKey: string;
  modifiers: string[];
  onRelease?: (() => void) | undefined;
}

export function useHotkeys(bindings: HotkeyBinding[], enabled: boolean): void {
  /* Read fresh on every keystroke without tearing the listener down and
     rebuilding it: `bindings` is a new array every render (the callbacks it
     carries close over the latest state), and re-attaching document
     listeners on every render would drop a `keyup` mid-hold the same way
     useHandsFree's own comment describes for its two collaborators. */
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const held = useRef<HeldBinding | undefined>(undefined);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!enabledRef.current || e.repeat || e.isComposing) return;
      const combo = comboFromChord(e);
      if (!combo) return;
      const binding = bindingsRef.current.find((b) => matches(b.combo, e));
      if (!binding) return;
      e.preventDefault();
      if (binding.hold) {
        held.current = { mainKey: mainKey(combo), modifiers: modifiersOf(combo), onRelease: binding.onRelease };
      }
      binding.onPress();
    }

    /*
     * Released on the first sign the chord comes apart, not on the exact
     * combo going up. If the user lifts Shift before D in "Ctrl+Shift+D", a
     * keyup matched against the whole chord would never fire and the
     * recording would latch open. Ending a hold a beat early is a nuisance;
     * failing to end one is the live-microphone failure DictationHud's own
     * doc comment is written about.
     */
    function onKeyUp(e: KeyboardEvent): void {
      const h = held.current;
      if (!h) return;
      const label = comboFromChord({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: e.code });
      const releasedMain = label === h.mainKey;
      const releasedModifier =
        (e.code.startsWith("Control") && h.modifiers.includes("Ctrl")) ||
        (e.code.startsWith("Alt") && h.modifiers.includes("Alt")) ||
        (e.code.startsWith("Shift") && h.modifiers.includes("Shift")) ||
        (e.code.startsWith("Meta") && h.modifiers.includes("Super"));
      if (!releasedMain && !releasedModifier) return;
      held.current = undefined;
      h.onRelease?.();
    }

    /* The keyup never arrives if focus leaves mid-hold -- Super pops a
       desktop overview, Alt-Tab switches windows -- so a held recording is
       also released on blur. dictation.ts's own 10-minute cap is the
       backstop this fix is for; this is meant to make that cap moot. */
    function onBlur(): void {
      const h = held.current;
      if (!h) return;
      held.current = undefined;
      h.onRelease?.();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
