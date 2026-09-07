import { useState } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { Reasoning } from "./Reasoning.tsx";
import type { PaperSection as Section } from "../types.ts";

/**
 * One section: the notes that go in, and the prose that comes out.
 *
 * The shape is Braindump5000's, which had been used on real papers before it
 * got here: raw thoughts at the top, the prose below, and the two visible at
 * once so you can see what became of what you said. The draft stays a plain
 * textarea rather than rendered Markdown for the same reason -- it is a draft,
 * the next thing that happens to it is being edited by hand, and a read-only
 * rendering with an Edit button would put a click between the author and their
 * own sentence.
 *
 * Three things it shows that the tool it came from did not:
 *
 *   - **Reasoning, while it happens and never after.** A local model can think
 *     for a minute before the first word of prose, and a card with nothing
 *     moving in it is indistinguishable from one that has hung. It is shown
 *     from the live stream and never written into the draft, which is the
 *     standing rule that reasoning is not part of the record.
 *   - **Invented citations, named.** The prompt forbids them; this reports the
 *     ones that appeared anyway, and removes nothing.
 *   - **Karen's own microphone**, so dictation here is the same dictation as
 *     everywhere else in the app rather than a second recorder with its own
 *     model.
 */
export function PaperSection({
  section,
  index,
  count,
  whole,
  busy,
  blocked,
  stream,
  invented,
  error,
  mic,
  onMic,
  onChange,
  onMove,
  onDelete,
  onDraft,
  onStop,
  onPrompt,
  onBoxFocus,
}: {
  section: Section;
  index: number;
  count: number;
  /** Whole-paper mode: the heading, the reordering and the delete are shown. */
  whole: boolean;
  busy: boolean;
  /** Another section is drafting. One at a time, so this one waits. */
  blocked: boolean;
  stream: { text: string; thinking: string } | undefined;
  invented: string[];
  error: string | undefined;
  mic: "idle" | "recording" | "transcribing";
  onMic: () => void;
  onChange: (patch: Partial<Section>) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onDraft: (mode: "draft" | "refine", instruction: string) => void;
  onStop: () => void;
  onPrompt: () => void;
  /** Which box the cursor is in, so a transcript lands in it. */
  onBoxFocus: (field: "notes" | "draft") => void;
}) {
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");

  /* While a draft is arriving the box shows the stream; the moment it lands the
     saved text takes over. Never both, and never the stream left on screen
     after the request that produced it has failed. */
  const shown = busy ? (stream?.text ?? "") : section.draft;
  const thinking = stream?.thinking ?? "";

  return (
    <section className="paper-section">
      <div className="paper-section-head">
        {whole ? (
          <>
            <div className="paper-order">
              <button
                type="button"
                className="paper-tiny"
                title="Move up"
                aria-label={`Move ${section.name} up`}
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="paper-tiny"
                title="Move down"
                aria-label={`Move ${section.name} down`}
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                ▼
              </button>
            </div>
            <input
              className="paper-section-name"
              value={section.name}
              aria-label="Section heading"
              onChange={(e) => onChange({ name: e.target.value })}
            />
            <button
              type="button"
              className="paper-tiny paper-danger"
              title="Delete this section"
              aria-label={`Delete ${section.name}`}
              onClick={onDelete}
            >
              ✕
            </button>
          </>
        ) : (
          <h2 className="paper-section-lone">Your notes, and the draft they become</h2>
        )}
      </div>

      <label className="paper-label" htmlFor={`notes-${section.id}`}>
        Raw thoughts / notes
      </label>
      <div className="paper-notes-row">
        <textarea
          id={`notes-${section.id}`}
          className="paper-notes"
          rows={whole ? 3 : 6}
          placeholder="Type or dictate your rough thoughts for this section. Half-formed is fine — that is the point."
          value={section.notes}
          onFocus={() => onBoxFocus("notes")}
          onChange={(e) => onChange({ notes: e.target.value })}
        />
        <button
          type="button"
          className={mic === "recording" ? "mic active" : "mic"}
          aria-pressed={mic === "recording"}
          aria-label={mic === "recording" ? "Stop dictation" : "Dictate these notes"}
          title={
            mic === "transcribing"
              ? "Writing down what you said…"
              : mic === "recording"
                ? "Stop dictation"
                : "Dictate — transcribed by the model you chose in the bar above"
          }
          onClick={onMic}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
            <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
          </svg>
        </button>
      </div>

      <div className="paper-actions">
        {busy ? (
          <button type="button" className="ghost paper-btn" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary paper-btn"
            disabled={blocked || !section.notes.trim()}
            title={
              section.notes.trim()
                ? undefined
                : "Write or dictate some notes first — this turns your thoughts into prose, it does not invent them."
            }
            onClick={() => onDraft("draft", "")}
          >
            {section.draft.trim() ? "Draft again" : "Draft this section"}
          </button>
        )}
        <button
          type="button"
          className="ghost paper-btn"
          disabled={busy || blocked || !section.draft.trim()}
          onClick={() => setRefining((v) => !v)}
        >
          Refine
        </button>
        <button type="button" className="ghost paper-btn" onClick={onPrompt}>
          ✎ Prompt{section.guidance.trim() ? " ●" : ""}
        </button>
        <CopyButton className="ghost paper-btn" label="⧉ Copy" text={() => section.draft} />
      </div>

      {thinking ? <Reasoning text={thinking} streaming={busy} /> : null}

      <label className="paper-label" htmlFor={`draft-${section.id}`}>
        Draft prose
      </label>
      <textarea
        id={`draft-${section.id}`}
        className="paper-draft"
        rows={8}
        readOnly={busy}
        placeholder="The prose will appear here, and stays yours to edit."
        value={shown}
        onFocus={() => onBoxFocus("draft")}
        onChange={(e) => onChange({ draft: e.target.value })}
      />

      {error ? (
        <p className="paper-error" role="alert">
          {error}
        </p>
      ) : null}

      {invented.length ? (
        /* Named, not removed. Deleting the marker would leave the sentence it
           supported reading as the author's own established fact, which is the
           more dangerous of the two states. */
        <p className="paper-invented" role="status">
          This draft contains {invented.length === 1 ? "a reference" : "references"} the model made
          up — nothing here searched the literature. Check or remove:{" "}
          <span className="paper-invented-list">{invented.slice(0, 4).join(", ")}</span>
          {invented.length > 4 ? ", …" : ""}
        </p>
      ) : null}

      {refining ? (
        <div className="paper-refine">
          <input
            className="paper-refine-box"
            value={instruction}
            autoFocus
            placeholder="How should this be revised? e.g. “make it more concise”, “emphasise the gap”"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              onDraft("refine", instruction);
            }}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button
            type="button"
            className="primary paper-btn"
            disabled={busy || blocked}
            onClick={() => onDraft("refine", instruction)}
          >
            Refine
          </button>
        </div>
      ) : null}
    </section>
  );
}
