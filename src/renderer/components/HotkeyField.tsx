import { useEffect, useState } from "react";
import { captureCombo, likelyTaken, prettyCombo, type KeyChord } from "../../core/hotkeys.ts";

/**
 * "Press a button, then press some keys" -- a button rather than a text
 * input, because a text box invites typing and then has to fight it off.
 *
 * The capture listener is on `window`, in the capture phase, so it sees the
 * next keydown before anything else in the app does -- including the
 * document-level hotkey listener in App.tsx. Without that, setting a
 * shortcut here would also fire the app action the very moment it is bound.
 */
export function HotkeyField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (combo: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!capturing) return;
    function onKeyDown(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setCapturing(false);
        setProblem(undefined);
        return;
      }
      const chord: KeyChord = {
        ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, code: e.code,
      };
      const result = captureCombo(chord);
      if (result.ok) {
        onChange(result.combo);
        setCapturing(false);
        setProblem(undefined);
      } else if (result.reason) {
        // A real rejection (a bare letter): say why, and keep listening.
        setProblem(result.reason);
      }
      // A bare modifier press (empty reason) is the user's fingers still
      // getting into position, not a failure -- nothing is said.
    }
    function onBlur(): void {
      setCapturing(false);
      setProblem(undefined);
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [capturing, onChange]);

  const conflict = capturing ? undefined : likelyTaken(value);

  return (
    <label>
      {label}
      <span className="hotkey-row">
        <button
          type="button"
          className={capturing ? "btn btn-sm hotkey-value capturing" : "btn btn-sm hotkey-value"}
          aria-pressed={capturing}
          onClick={() => {
            setProblem(undefined);
            setCapturing(true);
          }}
        >
          {capturing ? "Press the keys…" : value ? prettyCombo(value) : "Not set"}
        </button>
        {/* Beside the chord button and matching it, rather than underlined text
            next to a control: they are the two things you can do to a shortcut,
            and only one of them looked like a control. */}
        {value && !capturing ? (
          <button type="button" className="btn btn-sm" onClick={() => onChange("")}>
            Clear
          </button>
        ) : null}
      </span>
      <p className="hint" aria-live="polite">
        {problem ?? conflict ?? hint ?? ""}
      </p>
    </label>
  );
}
