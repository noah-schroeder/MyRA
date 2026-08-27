import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MeetingState, MeetingSummary, Settings, WhisperSnapshot,
} from "../types.ts";
import { MeetingCapture, CaptureError } from "../capture.ts";
import { litSegments, segmentClass } from "./meterBars.ts";
import { Markdown } from "./Markdown.tsx";
import { WhisperSetup } from "./WhisperSetup.tsx";

/**
 * Meetings: recording one, and everything that happens to it afterwards.
 *
 * This was a panel that appeared above the conversation, and it could only ever
 * show you the meeting you were in the middle of. What it could not show was
 * every meeting you had already held -- which is most of them, and the only
 * place the notes and transcripts existed. They were written into a vault and
 * then never mentioned again.
 *
 * The other thing the panel got wrong was doing everything at once. Pressing
 * stop began transcription, which began note-taking, and a failure anywhere in
 * that chain read as "the meeting is gone" even though the audio was on disk
 * the whole time. The three stages are separate here, and each one says whether
 * it has been done:
 *
 *   Record  →  Transcribe  →  Take notes
 *
 * Transcription costs minutes and note-taking costs seconds, so the expensive
 * one is never repeated to redo the cheap one. That is what makes it reasonable
 * to write the notes again with a different steer, which is the point of the
 * per-meeting instructions below.
 */

type Tab = "record" | "past" | "setup";

/**
 * Drop the YAML front matter before showing a note.
 *
 * It is there for Obsidian, which reads it and hides it. Markdown renderers do
 * not, so the note opened here began with five lines of `title:` and `tags:`
 * before the first sentence. Only a block at the very start counts, and only
 * one -- a `---` further down is a horizontal rule and belongs in the text.
 */
function withoutFrontMatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length).trimStart() : text;
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function length(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export function MeetingsPage({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("record");
  const [state, setState] = useState<MeetingState>({ phase: "idle" });
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [whisper, setWhisper] = useState<WhisperSnapshot | undefined>();
  const [title, setTitle] = useState("");
  const [warning, setWarning] = useState<string | undefined>();
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | undefined>();
  const capture = useRef<MeetingCapture | undefined>(undefined);

  const refresh = useCallback(async () => {
    setMeetings(await window.karen.meetingList());
  }, []);

  useEffect(() => {
    const offState = window.karen.onMeeting(setState);
    const offList = window.karen.onMeetings((list) => setMeetings(list));
    const offWhisper = window.karen.onWhisper(setWhisper);
    void window.karen.meetingState().then(setState);
    void window.karen.whisperState().then(setWhisper);
    void refresh();
    return () => {
      offState();
      offList();
      offWhisper();
    };
  }, [refresh]);

  /* Re-read the folder when the list is opened.
   *
   * The main process pushes a new list after every stage it runs, so this is
   * not about Karen's own writes -- it is about everything else: a meeting
   * deleted in a file manager, a folder synced from another machine, or a
   * recording made before this window was opened. The directory is the record,
   * so the page has to re-read it rather than trust a cache. */
  useEffect(() => {
    if (tab === "past") void refresh();
  }, [tab, refresh]);

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

    /*
     * Ask macOS before asking for a microphone.
     *
     * On macOS a denied microphone does not raise: getUserMedia resolves, the
     * track exists, and it carries silence for the whole meeting. Every other
     * platform answers "granted" and this costs one IPC round trip.
     */
    const access = await window.karen.mediaAccess();
    if (access.microphone === "not-determined") {
      await window.karen.requestMicrophone();
    } else if (access.microphone === "denied" || access.microphone === "restricted") {
      setWarning(
        "Karen does not have permission to use the microphone. Open System Settings → " +
          "Privacy & Security → Microphone, switch Karen on, and try again.",
      );
      return;
    }
    if (settings.meetingCaptureSystemAudio && access.screen === "denied") {
      setWarning(
        "Screen Recording permission is off, so only your own side will be recorded. " +
          "System Settings → Privacy & Security → Screen Recording.",
      );
    }

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
    setTitle("");
    // Straight to the list: the meeting you just held is the one you want to
    // act on, and it is now the first row.
    setTab("past");
  };

  const discard = async (): Promise<void> => {
    await capture.current?.stop();
    capture.current = undefined;
    await window.karen.meetingDiscard();
    setTitle("");
  };

  const busy = state.phase === "processing";
  const ready = Boolean(whisper?.config.modelFile) || Boolean(settings.transcription.baseUrl.trim());

  return (
    <section className="meetings">
      <header className="hub-head">
        <div className="hub-title">
          <h1>Meetings</h1>
          <p>Record, transcribe, and write it up — all on this machine.</p>
        </div>
        <div className="hub-stats">
          <Stat label="Recorded" value={String(meetings.length)} />
          <Stat
            label="Transcription"
            value={whisper?.config.modelFile ? whisper.config.modelFile.replace(/^ggml-|\.bin$/g, "") : ready ? "your endpoint" : "not set up"}
            dim={!ready}
          />
        </div>
        <button type="button" className="hub-back" onClick={onClose}>
          Back to chat
        </button>
      </header>

      <div className="hub-controls">
        <div className="seg">
          <button type="button" className={tab === "record" ? "active" : ""} onClick={() => setTab("record")}>
            Record
          </button>
          <button type="button" className={tab === "past" ? "active" : ""} onClick={() => setTab("past")}>
            Past meetings{meetings.length ? ` (${meetings.length})` : ""}
          </button>
          <button type="button" className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>
            Transcription
          </button>
        </div>
      </div>

      {warning ? (
        <p className="hub-alert note" role="status">
          {warning}
        </p>
      ) : null}

      {tab === "record" ? (
        <div className="meetings-body">
          <Recorder
            state={state}
            levels={levels}
            title={title}
            ready={ready}
            onTitle={setTitle}
            onStart={() => void start()}
            onStop={() => void stop()}
            onDiscard={() => void discard()}
            onSetUp={() => setTab("setup")}
          />
        </div>
      ) : tab === "setup" ? (
        <div className="meetings-body">
          <WhisperSetup snapshot={whisper} settings={settings} />
        </div>
      ) : (
        <div className="meetings-body">
          {meetings.length === 0 ? (
            <p className="runs-empty">
              No meetings yet. Record one and it will appear here with its audio, transcript and
              notes — all in a folder you can open.
            </p>
          ) : null}

          <ul className="meet-list">
            {meetings.map((m) => (
              <MeetingRow
                key={m.dir}
                meeting={m}
                busy={busy && state.workingOn === m.dir}
                progress={busy && state.workingOn === m.dir ? state.progress : undefined}
                expanded={open === m.dir}
                onToggle={() => setOpen(open === m.dir ? undefined : m.dir)}
                onChanged={refresh}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* The same chip the model hub uses, and deliberately so: these two pages answer
   the same question — what is set up on this machine — and answering it in two
   different shapes would make them look like two different apps. */
function Stat({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className={dim ? "hub-stat dim" : "hub-stat"}>
      <span className="hub-stat-value">{value}</span>
      <span className="hub-stat-label">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------- recording -- */

function Recorder({
  state, levels, title, ready, onTitle, onStart, onStop, onDiscard, onSetUp,
}: {
  state: MeetingState;
  levels: Record<string, number>;
  title: string;
  ready: boolean;
  onTitle: (t: string) => void;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onSetUp: () => void;
}) {
  if (state.phase === "recording") {
    return (
      <div className="meeting-live">
        <div className="meeting-live-head">
          <span className="recording-dot" aria-hidden="true" />
          <strong>{state.title}</strong>
          <span className="meeting-elapsed">{clock(state.elapsedMs ?? 0)}</span>
        </div>

        {(state.tracks ?? []).map((id) => (
          <Level key={id} label={id === "me" ? "You" : "Everyone else"} level={levels[id] ?? 0} />
        ))}

        <div className="meeting-actions">
          {/* "Stop" and nothing else. It used to say "stop and write it up",
              which was accurate and wrong: it committed you to minutes of work
              at the moment you were trying to leave a call. */}
          <button type="button" className="primary" onClick={onStop}>
            Stop recording
          </button>
          <button type="button" className="ghost" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="meeting-start-card">
      <h2>Start a recording</h2>
      <p className="dim">
        Karen records two tracks — your microphone and what your speakers are playing — so the
        write-up has both halves of the conversation. Nothing is sent anywhere while you record.
      </p>
      <div className="meeting-start">
        <input
          className="meeting-title"
          placeholder="What is this meeting?"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStart();
          }}
        />
        <button type="button" className="primary" onClick={onStart}>
          Record
        </button>
      </div>
      {/* Recording is still allowed without one: the audio keeps, and a
          transcription model can be downloaded afterwards. Saying so beats
          refusing, and beats letting someone find out an hour later. */}
      {!ready ? (
        <p className="meeting-warning">
          No transcription model is set up yet, so a recording cannot be written up.
          You can still record — the audio is kept — but{" "}
          <button type="button" className="linkish" onClick={onSetUp}>
            set one up
          </button>{" "}
          before you need the notes.
        </p>
      ) : null}
    </div>
  );
}

function Level({ label, level }: { label: string; level: number }) {
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

/* ----------------------------------------------------------- past meetings - */

function MeetingRow({
  meeting, busy, progress, expanded, onToggle, onChanged,
}: {
  meeting: MeetingSummary;
  busy: boolean;
  progress: MeetingState["progress"];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<"notes" | "transcript" | "prompt">("notes");
  const [text, setText] = useState<string | undefined>();
  const [prompt, setPrompt] = useState(meeting.state.instructions ?? "");
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!expanded || view === "prompt") return;
    setText(undefined);
    void window.karen.meetingRead(meeting.dir, view).then(setText);
  }, [expanded, view, meeting.dir, meeting.transcribed, meeting.noted]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    await fn();
    onChanged();
  };

  const savePrompt = async (): Promise<void> => {
    await window.karen.meetingInstructions(meeting.dir, prompt);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    onChanged();
  };

  return (
    <li className={`meet-row${busy ? " working" : ""}`}>
      <div className="meet-head">
        <button type="button" className="meet-open" onClick={onToggle} aria-expanded={expanded}>
          <span className="meet-title">{meeting.title}</span>
          <span className="meet-meta">
            {when(meeting.startedAt)} · {length(meeting.seconds)}
            {meeting.hasAudio ? ` · ${bytes(meeting.audioBytes)} audio` : " · audio deleted"}
          </span>
        </button>

        <span className="meet-stages" aria-label="What has been done">
          <Stage done label="Recorded" />
          <Stage done={meeting.transcribed} label="Transcribed" />
          <Stage done={meeting.noted} label="Notes" />
        </span>
      </div>

      {busy ? (
        <div className="meeting-progress">
          <p>{progress?.stage ?? "working"}…</p>
          {progress?.detail ? <p className="detail">{progress.detail}</p> : null}
          <div className="bar">
            <span style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
          </div>
          <button type="button" onClick={() => void window.karen.meetingCancel()}>
            Cancel
          </button>
        </div>
      ) : null}

      {meeting.state.error && !busy ? (
        <p className="meet-error" role="alert">
          {meeting.state.error}
        </p>
      ) : null}

      <div className="meet-actions">
        {/* Each step on its own, and the pair as one button. Transcription is
            the expensive half, so it is never repeated to redo the notes. */}
        <button
          type="button"
          disabled={busy || !meeting.hasAudio}
          onClick={() => void act(() => window.karen.meetingTranscribe(meeting.dir))}
          title={meeting.hasAudio ? "" : "The audio for this meeting has been deleted."}
        >
          {meeting.transcribed ? "Transcribe again" : "Transcribe"}
        </button>
        <button
          type="button"
          disabled={busy || !meeting.transcribed}
          onClick={() => void act(() => window.karen.meetingNotes(meeting.dir))}
          title={meeting.transcribed ? "" : "Transcribe it first."}
        >
          {meeting.noted ? "Take notes again" : "Take notes"}
        </button>
        {!meeting.transcribed || !meeting.noted ? (
          <button
            type="button"
            className="primary-sm"
            disabled={busy || !meeting.hasAudio}
            onClick={() => void act(() => window.karen.meetingRun(meeting.dir))}
          >
            Transcribe and take notes
          </button>
        ) : null}
        <span className="meet-spacer" />
        <button type="button" onClick={() => void window.karen.meetingReveal(meeting.dir)}>
          Open folder
        </button>
        {confirming ? (
          <>
            <span className="dim">Delete the recording and everything with it?</span>
            <button
              type="button"
              className="danger"
              onClick={() => void act(() => window.karen.meetingDelete(meeting.dir))}
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>

      {expanded ? (
        <div className="meet-body">
          <div className="seg">
            {(["notes", "transcript", "prompt"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? "active" : ""}
                onClick={() => setView(v)}
              >
                {v === "prompt" ? "Note instructions" : v === "notes" ? "Notes" : "Transcript"}
              </button>
            ))}
          </div>

          {view === "prompt" ? (
            <div className="meet-prompt">
              <p className="dim">
                What to tell the model about <em>this</em> meeting, before it writes the notes.
                Leave it empty to use the default from Settings.
              </p>
              <textarea
                value={prompt}
                rows={5}
                placeholder={
                  "e.g. This is a supervision meeting — keep the methodological objections in full, " +
                  "and list anything I agreed to read."
                }
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="meet-prompt-foot">
                <button type="button" onClick={() => void savePrompt()}>
                  Save
                </button>
                {meeting.noted ? (
                  <button
                    type="button"
                    className="primary-sm"
                    disabled={busy}
                    onClick={async () => {
                      await savePrompt();
                      await act(() => window.karen.meetingNotes(meeting.dir));
                    }}
                  >
                    Save and rewrite the notes
                  </button>
                ) : null}
                {saved ? <span className="dim">Saved.</span> : null}
              </div>
            </div>
          ) : text === undefined ? (
            <p className="dim">
              {view === "notes"
                ? meeting.noted
                  ? "Loading…"
                  : "No notes yet."
                : meeting.transcribed
                  ? "Loading…"
                  : "Not transcribed yet."}
            </p>
          ) : (
            <div className="meet-text">
              <Markdown text={withoutFrontMatter(text)} sources={new Map()} />
            </div>
          )}

          {view === "notes" && meeting.state.filedNotePath ? (
            <p className="dim meet-filed">
              Filed at <code>{meeting.state.filedNotePath}</code>{" "}
              <button
                type="button"
                className="linkish"
                onClick={() => void window.karen.meetingReveal(meeting.state.filedNotePath!)}
              >
                show it
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Stage({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={done ? "meet-stage done" : "meet-stage"} title={done ? `${label}: done` : `${label}: not yet`}>
      {label}
    </span>
  );
}
