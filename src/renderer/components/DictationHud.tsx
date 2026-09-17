import type { DictationState } from "../types.ts";
import { prettyCombo } from "../../core/hotkeys.ts";
import { litSegments, SEGMENTS, segmentClass } from "./meterBars.ts";

/**
 * The input level, as a row of bars.
 *
 * Segments rather than one continuous bar, deliberately: a filling bar reads as
 * progress towards something, and dictation has no end to make progress
 * towards. A row of bars reads as a level -- the thing it actually is.
 */
function Meter({ level, clipping }: { level: number; clipping?: boolean }) {
  const lit = litSegments(level);
  return (
    <span
      className="hud-meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={segmentClass(i, lit, clipping)} />
      ))}
    </span>
  );
}

/**
 * What dictation looks like while it is happening.
 *
 * Recording with no visible sign of it is the failure that matters here: a
 * hotkey that latched without the user noticing means a live microphone they
 * did not intend. So this is deliberately conspicuous — fixed, high contrast,
 * and it names the key that stops it -- once one is configured in Settings
 * → Audio; nothing is shown otherwise, since there is nothing to press.
 *
 * The meter answers the second question, which the timer cannot: a clock counts
 * up just as happily when the microphone is muted, and without a level the
 * first sign that nothing was heard is an empty transcript.
 */
export function DictationHud({
  state,
  hotkey,
  hold,
  onStop,
  onCancel,
}: {
  state: DictationState;
  hotkey?: string;
  /** Whether `hotkey` is held-to-talk rather than a start/stop toggle. */
  hold?: boolean;
  onStop: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "idle" && !state.error) return null;

  const seconds = Math.floor(state.elapsedMs / 1000);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  if (state.error) {
    return (
      <div className="hud hud-error" role="status">
        <span className="hud-label">Dictation failed</span>
        <span className="hud-detail">{state.error}</span>
      </div>
    );
  }

  if (state.phase === "transcribing") {
    return (
      <div className="hud" role="status">
        <span className="spin" />
        <span className="hud-label">Transcribing…</span>
      </div>
    );
  }

  return (
    <div className={`hud hud-recording${state.silent ? " hud-silent" : ""}`} role="status">
      <span className="hud-dot" aria-hidden="true" />
      <span className="hud-label">Recording</span>
      <span className="hud-clock">{clock}</span>
      <Meter level={state.level} {...(state.clipping ? { clipping: true } : {})} />
      {state.silent ? (
        // Said now, while it can still be fixed, rather than at the transcript.
        <span className="hud-warn">No sound — check the microphone</span>
      ) : null}
      <span className="hud-actions">
        <button className="btn btn-sm" onClick={onStop}>
          {hotkey ? (hold ? `Release ${prettyCombo(hotkey)}` : `Stop · ${prettyCombo(hotkey)}`) : "Stop"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Discard
        </button>
      </span>
    </div>
  );
}
