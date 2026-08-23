import { useState } from "react";
import type { MeetingState } from "../types.ts";

const STAGES: Record<string, string> = {
  transcribing: "Transcribing the recording",
  assembling: "Assembling the transcript",
  extracting: "Reading what was said",
  verifying: "Checking quotes against the transcript",
  writing: "Writing the notes",
  filing: "Filing to your vault",
  done: "Done",
};

/**
 * Recording a meeting, and what happens afterwards.
 *
 * Three states worth designing for, not one: recording (which must be
 * unmistakable, because a live microphone the user forgot about is the failure
 * that matters), processing (which runs for minutes and must say what it is
 * doing, or it reads as a hang), and finished (which must say what was written
 * and what was not trusted).
 */
export function MeetingPanel({ state }: { state: MeetingState }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (state.phase === "recording") {
    const seconds = Math.floor((state.elapsedMs ?? 0) / 1000);
    const clock = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(
      Math.floor((seconds % 3600) / 60),
    ).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return (
      <div className={`meet meet-live${state.error ? " meet-warned" : ""}`}>
        <span className="hud-dot" aria-hidden="true" />
        <div className="meet-body">
          <div className="meet-title">{state.title || "Meeting"}</div>
          <div className="meet-sub">Recording · {clock}</div>
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => window.karen.meetingStop())}>
          End &amp; write notes
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => window.karen.meetingDiscard())}>
          Discard
        </button>
        {error ? <span className="meet-error">{error}</span> : null}
        {/* Said while it can still be fixed, rather than an hour from now. */}
        {state.error ? <span className="meet-error">{state.error}</span> : null}
      </div>
    );
  }

  if (state.phase === "processing") {
    const fraction = state.progress?.fraction ?? 0;
    return (
      <div className="meet">
        <span className="spin" />
        <div className="meet-body">
          <div className="meet-title">{state.title || "Meeting"}</div>
          <div className="meet-sub">
            {STAGES[state.progress?.stage ?? "transcribing"]}
            {state.progress?.detail ? ` — ${state.progress.detail}` : ""}
          </div>
          {/* A real fraction, not a spinner pretending to know: the stages are
              known in advance and the bar only moves when one completes. */}
          <div className="meet-bar" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
            <div className="meet-bar-fill" style={{ width: `${Math.max(3, fraction * 100)}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "done" && state.result) {
    const { result } = state;
    return (
      <div className="meet meet-done">
        <div className="meet-body">
          <div className="meet-title">Notes filed</div>
          <div className="meet-sub">
            <code>{result.reportPath}</code>
          </div>
          <div className="meet-tags">
            <span className="meet-tag">
              {result.actions} action item{result.actions === 1 ? "" : "s"} in the review queue
            </span>
            {result.unverified > 0 ? (
              // Said plainly rather than buried: these are the items that may
              // have been invented, and the note marks them as such.
              <span className="meet-tag meet-tag-warn">
                {result.unverified} unverified — check before acting
              </span>
            ) : null}
            {result.audioDeleted ? <span className="meet-tag">audio deleted</span> : null}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void window.karen.meetingDismiss()}>
          Dismiss
        </button>
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="meet meet-failed">
        <div className="meet-body">
          <div className="meet-title">The notes could not be written</div>
          {/* The recording survives, so this is recoverable; the message says
              where it is rather than leaving the user to guess. */}
          <div className="meet-sub">{state.error}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void window.karen.meetingDismiss()}>
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="meet">
      <input
        className="input meet-input"
        placeholder="What is this meeting?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) void run(() => window.karen.meetingStart(title.trim()));
        }}
      />
      <button
        className="btn btn-sm"
        disabled={busy || !title.trim()}
        onClick={() => run(() => window.karen.meetingStart(title.trim()))}
      >
        Record meeting
      </button>
      {error ? <span className="meet-error">{error}</span> : null}
    </div>
  );
}
