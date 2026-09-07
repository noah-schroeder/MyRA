import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { PaperPrompt } from "./PaperPrompt.tsx";
import { PaperSection } from "./PaperSection.tsx";
import { assemble, moveSection, newSection, withoutSection } from "../../core/papers/paper.ts";
import { requestFor } from "../../core/papers/prompt.ts";
import { FORMATS } from "../../core/documents/formats.ts";
import type { DictationState, Paper, PaperKind, PaperSection as Section, PaperSummary } from "../types.ts";

/**
 * The paper drafter: raw thoughts in, first-draft prose out.
 *
 * Ported from Braindump5000, a tool the user had already built and used on real
 * papers. What it does is narrow and worth stating plainly, because the narrowness
 * is the feature: you give it a sample of your own academic writing and some
 * half-formed notes, and it writes the notes up in your voice. It does not
 * research, it does not cite, and it invents nothing -- see
 * [prompt.ts](../../core/papers/prompt.ts), where that is enforced rather than
 * requested.
 *
 * **One record, two presentations.** A whole paper and a single section differ
 * only in how many sections there are and how much chrome is shown. Two
 * components would be two save paths, and the second one would be the one
 * nobody remembered to fix.
 *
 * **Nothing to configure.** No endpoint, no key, no model list. It writes with
 * whatever model the bar at the top names, resolved the way chat resolves it,
 * which is what stops this from becoming a second copy of the app's model
 * plumbing.
 */

/* The formats worth offering, in the order a person wants them. Built from the
   app's own table so a format added there cannot go missing here. */
const EXPORTS = ["docx", "odt", "rtf", "html", "md", "txt", "pdf"] as const;

/** How long after the last keystroke the paper is written to disk. */
const SAVE_DELAY_MS = 700;

export function PaperDrafter({
  onClose,
  dictation,
  sink,
}: {
  onClose: () => void;
  dictation: {
    state: DictationState;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
  /**
   * Where a transcript should land while this page is open.
   *
   * A second `useDictation` here would subscribe to the same channel and every
   * transcript would arrive twice, so the app keeps one and this page borrows
   * it -- the same way the composer and the literature search box share it.
   */
  sink: { current: ((text: string) => void) | undefined };
}) {
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [paper, setPaper] = useState<Paper | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [stream, setStream] = useState<{ sectionId: string; text: string; thinking: string } | undefined>();
  const [invented, setInvented] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ scope: "paper" | "section"; sectionId?: string } | undefined>();
  const [format, setFormat] = useState<string>("docx");
  const [exported, setExported] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [micSection, setMicSection] = useState<string | undefined>();

  /** The box a transcript belongs in: the last one the cursor was in. */
  const box = useRef<{ sectionId: string; field: "notes" | "draft" } | undefined>(undefined);
  /** What is already on disk, so typing nothing writes nothing. */
  const stored = useRef<string>("");

  const refresh = useCallback(async () => {
    const result = await window.karen.paperList();
    setPapers(result.papers ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  /* ---------------------------------------------------------------- saving */

  useEffect(() => {
    if (!paper) return;
    const body = JSON.stringify(paper);
    if (body === stored.current) return;
    setSaving(true);
    const timer = setTimeout(() => {
      stored.current = body;
      void window.karen.paperSave(paper).then((r) => {
        setSaving(false);
        if (!r.ok) setError(r.error ?? "That paper could not be saved.");
      });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [paper]);

  const edit = useCallback((patch: Partial<Paper>): void => {
    setPaper((p) => (p ? { ...p, ...patch } : p));
  }, []);

  const editSection = useCallback((id: string, patch: Partial<Section>): void => {
    setPaper((p) =>
      p ? { ...p, sections: p.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : p,
    );
  }, []);

  /* ------------------------------------------------------------ dictation */

  useEffect(() => {
    sink.current = (text: string): void => {
      const target = box.current;
      if (!target) return;
      /* Appended, never replacing: dictation adds to what you were already
         writing, and overwriting a half-typed paragraph is a bad way to find
         that out. The composer follows the same rule. */
      setPaper((p) =>
        p
          ? {
              ...p,
              sections: p.sections.map((s) =>
                s.id === target.sectionId
                  ? { ...s, [target.field]: joined(s[target.field], text) }
                  : s,
              ),
            }
          : p,
      );
    };
    return () => {
      sink.current = undefined;
    };
  }, [sink]);

  /* The recording belongs to whichever card started it, and stops being that
     card's the moment the microphone is idle again. */
  useEffect(() => {
    if (dictation.state.phase === "idle") setMicSection(undefined);
  }, [dictation.state.phase]);

  const mic = (sectionId: string): void => {
    if (dictation.state.phase === "recording") {
      void dictation.stop();
      return;
    }
    box.current = { sectionId, field: "notes" };
    setMicSection(sectionId);
    void dictation.start();
  };

  /* ------------------------------------------------------------- drafting */

  useEffect(
    () =>
      window.karen.onPaperDelta((d) => {
        setStream((s) => {
          if (!s || s.sectionId !== d.sectionId) return s;
          /* A retried attempt starts the section again. Without this the second
             attempt appends to the half-draft the first one left and the author
             watches their section written twice. */
          if (d.reset) return { ...s, text: "", thinking: "" };
          return d.kind === "thinking"
            ? { ...s, thinking: s.thinking + d.text }
            : { ...s, text: s.text + d.text };
        });
      }),
    [],
  );

  const draft = async (sectionId: string, mode: "draft" | "refine", instruction: string): Promise<void> => {
    if (!paper || busy) return;
    setFailed((f) => ({ ...f, [sectionId]: "" }));
    setInvented((v) => ({ ...v, [sectionId]: [] }));
    setStream({ sectionId, text: "", thinking: "" });
    setBusy(sectionId);
    const result = await window.karen.paperDraft(sectionId, requestFor(paper, sectionId, { mode, instruction }));
    setBusy(undefined);
    setStream(undefined);
    if (!result.ok || !result.text) {
      setFailed((f) => ({ ...f, [sectionId]: result.error ?? "The draft failed." }));
      return;
    }
    editSection(sectionId, { draft: result.text });
    setInvented((v) => ({ ...v, [sectionId]: result.invented ?? [] }));
  };

  /* --------------------------------------------------------------- papers */

  const open = async (id: string): Promise<void> => {
    const result = await window.karen.paperOpen(id);
    if (!result.ok || !result.paper) {
      setError(result.error ?? "That paper could not be opened.");
      return;
    }
    stored.current = JSON.stringify(result.paper);
    setPaper(result.paper);
    setInvented({});
    setFailed({});
    setExported(undefined);
    setError(undefined);
  };

  const create = async (kind: PaperKind): Promise<void> => {
    const result = await window.karen.paperCreate(kind, kind === "paper" ? "Untitled paper" : "Untitled section");
    if (!result.paper) return;
    stored.current = JSON.stringify(result.paper);
    setPaper(result.paper);
    setExported(undefined);
  };

  const close = (): void => {
    setPaper(undefined);
    setConfirming(false);
    setExported(undefined);
    void refresh();
  };

  const remove = async (): Promise<void> => {
    if (!paper) return;
    const result = await window.karen.paperDelete(paper.id);
    setPapers(result.papers ?? []);
    setPaper(undefined);
    setConfirming(false);
  };

  const exportAs = async (): Promise<void> => {
    if (!paper) return;
    setExported(undefined);
    setError(undefined);
    /* Written first, so the file on disk is the one being converted rather than
       whatever the last autosave happened to catch. */
    await window.karen.paperSave(paper);
    stored.current = JSON.stringify(paper);
    const result = await window.karen.paperExport(paper.id, format);
    if (!result.ok || !result.path) {
      setError(result.error ?? "That export failed.");
      return;
    }
    setExported(result.path);
  };

  /* ----------------------------------------------------------------- draw */

  if (!paper) {
    return (
      <section className="hub papers">
        <header className="hub-head">
          <div className="hub-title">
            <h1>Paper drafter</h1>
            <p>
              Give it a sample of your own writing and some rough notes, and it writes them up in
              your voice. It does not search and it never cites — those come later.
            </p>
          </div>
          <button type="button" className="hub-back" onClick={onClose}>
            Back to chat
          </button>
        </header>

        <div className="papers-body">
          <p className="paper-lead">What are you working on?</p>
          <div className="paper-choose">
            <button type="button" className="paper-choice" onClick={() => void create("paper")}>
              <span className="paper-choice-name">A whole paper</span>
              <span className="paper-choice-note">
                Sections you can name, reorder and draft one at a time — the outline is yours to
                change, and each section is written on its own.
              </span>
            </button>
            <button type="button" className="paper-choice" onClick={() => void create("section")}>
              <span className="paper-choice-name">One section</span>
              <span className="paper-choice-note">
                A writing sample and one box. For a methods section, an abstract, a paragraph you
                have been putting off.
              </span>
            </button>
          </div>

          <h2 className="paper-list-head">Your papers</h2>
          {papers.length === 0 ? (
            <p className="paper-empty">
              Nothing yet. Whatever you start is saved on this machine as you type.
            </p>
          ) : (
            <ul className="paper-list">
              {papers.map((p) => (
                <li key={p.id}>
                  <button type="button" className="paper-row" onClick={() => void open(p.id)}>
                    <span className="paper-row-title">{p.title}</span>
                    <span className="paper-row-sub">
                      {p.kind === "section"
                        ? "One section"
                        : `${p.sections} section${p.sections === 1 ? "" : "s"}`}
                      {" · "}
                      {p.drafted} drafted
                      {p.updatedAt ? ` · ${when(p.updatedAt)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error ? (
            <p className="paper-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  const whole = paper.kind === "paper";

  return (
    <section className="hub papers">
      <header className="hub-head">
        <div className="hub-title">
          <button type="button" className="paper-back" onClick={close}>
            ‹ All papers
          </button>
          <input
            className="paper-title"
            value={paper.title}
            aria-label="Title"
            placeholder={whole ? "Paper title" : "What is this section?"}
            onChange={(e) => edit({ title: e.target.value })}
          />
        </div>
        <div className="paper-head-tools">
          <span className="paper-saved">{saving ? "Saving…" : "Saved"}</span>
          {whole ? (
            <button type="button" className="ghost paper-btn" onClick={() => setEditing({ scope: "paper" })}>
              ✎ Paper prompt{paper.instructions.trim() ? " ●" : ""}
            </button>
          ) : null}
          <CopyButton className="ghost paper-btn" label="⧉ Copy full draft" text={() => assemble(paper)} />
          <select
            className="paper-format"
            value={format}
            aria-label="Export format"
            onChange={(e) => setFormat(e.target.value)}
          >
            {EXPORTS.map((ext) => (
              <option key={ext} value={ext}>
                {FORMATS[ext]?.label ?? ext}
              </option>
            ))}
          </select>
          <button type="button" className="ghost paper-btn" onClick={() => void exportAs()}>
            ⬇ Export
          </button>
          <button type="button" className="ghost paper-btn paper-danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      </header>

      <div className="papers-body">
        {confirming ? (
          <div className="paper-confirm" role="alertdialog">
            <p>
              Delete “{paper.title}”? Its notes and every draft in it go with it, and nothing here
              has been exported unless you exported it.
            </p>
            <div className="paper-confirm-actions">
              <button type="button" className="ghost paper-btn" onClick={() => setConfirming(false)}>
                Keep it
              </button>
              <button type="button" className="paper-btn paper-delete" onClick={() => void remove()}>
                Delete this paper
              </button>
            </div>
          </div>
        ) : null}

        {exported ? (
          <p className="paper-exported" role="status">
            Written to <span className="paper-path">{exported}</span>
            <button
              type="button"
              className="ghost paper-btn"
              onClick={() => void window.karen.paperReveal(exported)}
            >
              Show in folder
            </button>
          </p>
        ) : null}
        {error ? (
          <p className="paper-error" role="alert">
            {error}
          </p>
        ) : null}

        <details className="paper-sample" open={!paper.writingSample.trim()}>
          <summary>
            Writing sample <span className="paper-sample-hint">— your voice{paper.writingSample.trim() ? " ●" : ", optional"}</span>
          </summary>
          <p className="paper-help">
            Paste a paragraph or two of your own academic prose. Every section is written to match
            its rhythm, vocabulary and level of formality. Leave it empty and you get a clear,
            formal voice that is nobody's in particular.
          </p>
          <textarea
            className="paper-sample-box"
            rows={6}
            value={paper.writingSample}
            placeholder="Paste a sample of your own writing here…"
            onChange={(e) => edit({ writingSample: e.target.value })}
          />
        </details>

        {paper.sections.map((section, index) => (
          <PaperSection
            key={section.id}
            section={section}
            index={index}
            count={paper.sections.length}
            whole={whole}
            busy={busy === section.id}
            blocked={busy !== undefined && busy !== section.id}
            stream={stream?.sectionId === section.id ? stream : undefined}
            invented={invented[section.id] ?? []}
            error={failed[section.id] || undefined}
            mic={
              micSection === section.id && dictation.state.phase !== "idle"
                ? dictation.state.phase === "recording"
                  ? "recording"
                  : "transcribing"
                : "idle"
            }
            onMic={() => mic(section.id)}
            onChange={(patch) => editSection(section.id, patch)}
            onMove={(delta) => edit({ sections: moveSection(paper.sections, index, delta) })}
            onDelete={() => edit({ sections: withoutSection(paper.sections, section.id) })}
            onDraft={(mode, instruction) => void draft(section.id, mode, instruction)}
            onStop={() => void window.karen.paperCancel()}
            onPrompt={() => setEditing({ scope: "section", sectionId: section.id })}
            onBoxFocus={(field) => {
              box.current = { sectionId: section.id, field };
            }}
          />
        ))}

        {whole ? (
          <button
            type="button"
            className="ghost paper-add"
            onClick={() => edit({ sections: [...paper.sections, newSection("New section")] })}
          >
            + Add section
          </button>
        ) : null}
      </div>

      {editing ? (
        <PaperPrompt
          scope={editing.scope}
          value={
            editing.scope === "paper"
              ? paper.instructions
              : (paper.sections.find((s) => s.id === editing.sectionId)?.guidance ?? "")
          }
          placeholder={
            editing.scope === "paper"
              ? "e.g. “This is a grant proposal — write persuasively.” · “Use British spelling.” · “Audience: non-specialists.”"
              : "e.g. “be concise and technical”, “open with the broad problem”, “use past tense”"
          }
          requestFor={(value) => {
            const id = editing.sectionId ?? paper.sections[0]!.id;
            const live: Paper =
              editing.scope === "paper"
                ? { ...paper, instructions: value }
                : { ...paper, sections: paper.sections.map((s) => (s.id === id ? { ...s, guidance: value } : s)) };
            return requestFor(live, id, { mode: "draft" });
          }}
          onChange={(value) => {
            if (editing.scope === "paper") edit({ instructions: value });
            else if (editing.sectionId) editSection(editing.sectionId, { guidance: value });
          }}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

/** Join a transcript onto what is already in the box, with one space. */
function joined(existing: string, added: string): string {
  return existing.trim() ? `${existing.replace(/\s+$/, "")} ${added}` : added;
}

/** A date somebody reads, not one they parse. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
