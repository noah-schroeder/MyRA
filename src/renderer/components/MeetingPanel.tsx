import { useEffect, useRef, useState } from "react";
import type { MeetingState, Settings } from "../types.ts";
import { MeetingCapture, CaptureError } from "../capture.ts";
import { litSegments, segmentClass } from "./meterBars.ts";

/**
 * Recording a meeting.
 *
 * The capture lives here because device access is a Web API; the files and the
 * transcription live in the main process. So this component owns a
 * MeetingCapture and forwards its chunks, and everything after "stop" is
 * something it only watches.
 */
export function MeetingPanel({ settings }: { settings: Settings }) {
  const [state, setState] = useState<MeetingState>({ phase: "idle" });
  const [title, setTitle] = useState("");
  const [warning, setWarning] = useState<string | undefined>();
  const [levels, setLevels] = useState<Record<string, number>>({});
  const capture = useRef<MeetingCapture | undefined>(undefined);

  useEffect(() => window.karen.onMeeting(setState), []);
  useEffect(() => {
    void window.karen.meetingState().then(setState);
  }, []);

  // Levels are polled rather than pushed: at 10 Hz an IPC message per reading
  // per track is a lot of traffic for a meter, and a dropped frame is invisible.
  useEffect(() => {
    if (state.phase !== "recording") return;
    const timer = setInterval(() => {
      void window.karen.meetingLevels().then(setLevels);
    }, 100);
    return () => clearInterval(timer);
  }, [state.phase]);

  const start = async (): Promise<void> => {
    setWarning(undefined);
    const session = new MeetingCapture();
    try {
      const tracks = await session.start({
        ...(settings.dictationSource ? { micDeviceId: settings.dictationSource } : {}),
        systemAudio: settings.meetingCaptureSystemAudio,
        onChunk: (trackId, pcm) => void window.karen.meetingAudio(trackId, pcm),
        onWarning: setWarning,
      });
      capture.current = session;
      await window.karen.meetingStart(title.trim() || "Meeting", tracks);
    } catch (err) {
      await session.stop();
      setWarning(
        err instanceof CaptureError ? err.message : `Could not start: ${(err as Error).message}`,
      );
    }
  };

  const stop = async (): Promise<void> => {
    await capture.current?.stop();
    capture.current = undefined;
    await window.karen.meetingStop();
  };

  const discard = async (): Promise<void> => {
    await capture.current?.stop();
    capture.current = undefined;
    await window.karen.meetingDiscard();
    setTitle("");
  };

  return (
    <section className="meeting" aria-label="Meeting">
      {state.phase === "idle" || state.phase === "done" || state.phase === "failed" ? (
        <div className="meeting-start">
          <input
            className="meeting-title"
            placeholder="What is this meeting?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
            }}
          />
          <button type="button" className="primary" onClick={() => void start()}>
            Record
          </button>
        </div>
      ) : null}

      {state.phase === "recording" ? (
        <div className="meeting-live">
          <div className="meeting-live-head">
            <span className="recording-dot" aria-hidden="true" />
            <strong>{state.title}</strong>
            <span className="meeting-elapsed">{clock(state.elapsedMs ?? 0)}</span>
          </div>

          {(state.tracks ?? []).map((id) => (
            <Meter key={id} label={id === "me" ? "You" : "Everyone else"} level={levels[id] ?? 0} />
          ))}

          <div className="meeting-actions">
            <button type="button" className="primary" onClick={() => void stop()}>
              Stop and write it up
            </button>
            <button type="button" className="ghost" onClick={() => void discard()}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === "processing" ? (
        <div className="meeting-progress">
          <p>{state.progress?.stage ?? "working"}…</p>
          {state.progress?.detail ? <p className="detail">{state.progress.detail}</p> : null}
          <div className="bar">
            <div className="fill" style={{ width: `${Math.round((state.progress?.fraction ?? 0) * 100)}%` }} />
          </div>
        </div>
      ) : null}

      {state.phase === "done" && state.reportPath ? (
        <p className="meeting-done">
          Written to <code>{state.reportPath}</code>
        </p>
      ) : null}

      {state.phase === "failed" && state.error ? (
        <p className="meeting-failed" role="alert">
          {state.error}
        </p>
      ) : null}

      {warning ? (
        <p className="meeting-warning" role="status">
          {warning}
        </p>
      ) : null}
    </section>
  );
}

function Meter({ label, level }: { label: string; level: number }) {
  const lit = litSegments(level);
  return (
    <div className="level-row">
      <span className="level-label">{label}</span>
      <div className="level" role="meter" aria-label={`${label} input level`} aria-valuenow={Math.round(level * 100)}>
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className={segmentClass(i, lit)} />
        ))}
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
