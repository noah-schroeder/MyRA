import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "./CopyButton.tsx";
import {
  buildSystem, buildUser, requestFor, type ReviewRequest,
} from "../../core/review/prompt.ts";
import { fitsContext, tooLongMessage, type Fit } from "../../core/review/manuscript.ts";
import type { Settings } from "../types.ts";

/**
 * Reviewing a manuscript somebody sent you.
 *
 * The whole page is arranged around one gesture, because the people this is for
 * receive a manuscript as an attachment and have no reason to know where their
 * browser put it: drop the file here. A file chooser sits under the drop zone
 * for anyone who does not drag, which is more people than interface designers
 * tend to assume.
 *
 * Nothing about the file's LOCATION crosses to the main process -- the bytes
 * do. See main/review.ts for why that is the easy path rather than the clever
 * one, and note the second benefit: Karen never records where an unpublished
 * manuscript under review is kept.
 */

const ACCEPT = ".pdf,.docx,.doc,.odt,.rtf,.md,.markdown,.txt";

interface Loaded {
  name: string;
  text: string;
  words: number;
}

export function PeerReview({
  settings,
  onClose,
  onOpenSettings,
  onOpenModels,
}: {
  settings: Settings | undefined;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenModels: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [title, setTitle] = useState("");
  const [studyTypeId, setStudyTypeId] = useState("");
  const [note, setNote] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [needsPandoc, setNeedsPandoc] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [over, setOver] = useState(false);

  const [review, setReview] = useState("");
  /* Citation markers the model produced despite being told not to. Shown, not
     stripped: see the comment in main/review.ts. */
  const [invented, setInvented] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [contextTokens, setContextTokens] = useState<number | undefined>();
  const [showPrompt, setShowPrompt] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const types = settings?.reviewStudyTypes ?? [];

  /*
   * How much the model can hold, re-asked whenever the runtime changes.
   *
   * Asking only on mount was wrong in the ordinary case: somebody drops a
   * manuscript, is told it does not fit, loads a longer-context model from the
   * bar above -- and this page went on refusing against the old number, or
   * worse, went on offering a button that would now overflow. The runtime
   * already announces a load; this listens.
   */
  const askContext = useCallback(() => {
    void window.karen.reviewContext().then((r) => setContextTokens(r.contextTokens));
  }, []);
  useEffect(() => {
    askContext();
    return window.karen.onRuntime(askContext);
  }, [askContext]);

  useEffect(
    () =>
      window.karen.onReviewDelta((d) => {
        /* Only the answer. A model that thinks out loud is doing so about
           somebody else's paper, and its reasoning is not the review. */
        if (d.kind !== "text") return;
        setReview((prev) => (d.reset ? "" : prev + d.text));
      }),
    [],
  );

  const take = useCallback(async (file: File): Promise<void> => {
    setError(undefined);
    setNeedsPandoc(false);
    setReading(true);
    setReview("");
    try {
      const bytes = await file.arrayBuffer();
      const result = await window.karen.reviewExtract(file.name, bytes);
      if (!result.ok) {
        setError(result.error ?? "That file could not be read.");
        setNeedsPandoc(Boolean(result.needsPandoc));
        setLoaded(undefined);
        return;
      }
      setLoaded({ name: file.name, text: result.text ?? "", words: result.words ?? 0 });
      setTitle(result.title ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(false);
    }
  }, []);

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void take(file);
  };

  const request: ReviewRequest | undefined = useMemo(() => {
    if (!loaded) return undefined;
    return requestFor({
      prompt: settings?.reviewPrompt ?? "",
      types,
      studyTypeId,
      note,
      title,
      manuscript: loaded.text,
    });
  }, [loaded, settings?.reviewPrompt, types, studyTypeId, note, title]);

  /* Measured here, in the page, over the same object that will be sent -- so
     the figure in the refusal is the size of the actual request rather than an
     estimate of the manuscript alone. */
  const fit: Fit | undefined = request ? fitsContext(request, contextTokens) : undefined;

  const run = async (): Promise<void> => {
    if (!request) return;
    setError(undefined);
    setReview("");
    setInvented([]);
    setRunning(true);
    const result = await window.karen.reviewRun(request);
    setRunning(false);
    if (!result.ok) setError(result.error ?? "The review failed.");
    else if (result.text) {
      setReview(result.text);
      setInvented(result.invented ?? []);
    }
  };

  const installPandoc = async (): Promise<void> => {
    setInstalling(true);
    const r = await window.karen.installPandoc();
    setInstalling(false);
    if (r.ok) {
      setNeedsPandoc(false);
      setError("pandoc is installed. Drop the file again.");
    } else {
      setError(r.error ?? "The install failed.");
    }
  };

  return (
    <div className="models-page">
      <div className="review">
        <header className="review-head">
          <div>
            <h1>Peer review</h1>
            <p className="review-sub">
              Drop a manuscript in and Karen reads it and writes a review. Nothing is uploaded
              unless the model you have chosen is a hosted one.
            </p>
          </div>
          <div className="review-head-actions">
            <button type="button" className="ghost" onClick={onOpenSettings}>
              Edit the review prompt
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Back to chat
            </button>
          </div>
        </header>

        {/* The drop zone stays on the page after a file is loaded, smaller, so
            reviewing a second manuscript does not mean hunting for the control
            that started the first. */}
        <div
          className={
            over ? "review-drop over" : loaded ? "review-drop review-drop-small" : "review-drop"
          }
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <p className="review-drop-title">
            {reading ? "Reading the manuscript…" : "Drop a manuscript here"}
          </p>
          <p className="review-drop-note">PDF, Word, ODT, RTF or plain text</p>
          <button
            type="button"
            className="ghost"
            onClick={() => fileInput.current?.click()}
            disabled={reading}
          >
            Choose a file
          </button>
          <input
            ref={fileInput}
            className="review-file"
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void take(file);
              /* Cleared, or choosing the same file twice after fixing a missing
                 converter fires no change event and looks like a dead button. */
              e.target.value = "";
            }}
          />
        </div>

        {error ? (
          <div className="review-error">
            <p>{error}</p>
            {needsPandoc ? (
              <button type="button" onClick={() => void installPandoc()} disabled={installing}>
                {installing ? "Installing…" : "Install pandoc"}
              </button>
            ) : null}
          </div>
        ) : null}

        {loaded ? (
          <>
            <div className="review-file-row">
              <span className="review-file-name">{loaded.name}</span>
              <span className="review-file-meta">{loaded.words.toLocaleString()} words</span>
            </div>

            <label className="field">
              <span className="field-label">Manuscript title</span>
              {/* Editable, because it is a guess from the first page and a
                  running head or a submission stamp can win. */}
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="The title as it should appear in the review"
              />
            </label>

            <div className="field">
              <span className="field-label">What kind of paper is this?</span>
              <p className="field-note">
                The questions worth asking differ by design — randomisation matters for an
                experiment and is a category error for an editorial.
              </p>
              <div className="review-types">
                {types.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={t.id === studyTypeId ? "review-type on" : "review-type"}
                    aria-pressed={t.id === studyTypeId}
                    onClick={() => setStudyTypeId((cur) => (cur === t.id ? "" : t.id))}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span className="field-label">Anything else for this review?</span>
              <textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. the journal is methods-heavy, or focus on the statistics"
              />
            </label>

            {fit && !fit.fits ? (
              <div className="review-toolong">
                <p>{tooLongMessage(fit)}</p>
                <button type="button" onClick={onOpenModels}>
                  Open Models
                </button>
              </div>
            ) : null}

            <div className="review-actions">
              <button type="button" className="ghost" onClick={() => setShowPrompt(true)}>
                Preview what is sent
              </button>
              {running ? (
                <button type="button" className="stop" onClick={() => void window.karen.reviewCancel()}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={!fit?.fits}
                  onClick={() => void run()}
                >
                  Review it
                </button>
              )}
            </div>
          </>
        ) : null}

        {review ? (
          <section className="review-out">
            <header className="review-out-head">
              <h2>Review</h2>
              <div className="review-out-actions">
                <CopyButton text={() => review} />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.karen.reviewSave(`${title || "review"}.md`, review)}
                >
                  Save as Markdown
                </button>
              </div>
            </header>
            {invented.length ? (
              <p className="review-invented">
                This review contains {invented.length === 1 ? "a reference" : "references"} Karen
                did not give the model — {invented.slice(0, 6).join(", ")}
                {invented.length > 6 ? ", …" : ""}. Nothing here searched the literature, so
                {invented.length === 1 ? " it is" : " they are"} invented. Delete
                {invented.length === 1 ? " it" : " them"} before sending this to an editor.
              </p>
            ) : null}
            <Markdown text={review} sources={new Map()} />
          </section>
        ) : null}

        {showPrompt && request ? (
          <PromptPreview request={request} onClose={() => setShowPrompt(false)} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Exactly what will be sent, rendered from the object that will be sent.
 *
 * Not a reconstruction: `buildSystem` and `buildUser` are the same two
 * functions the main process calls, over the same request. Showing this sends
 * nothing.
 */
function PromptPreview({ request, onClose }: { request: ReviewRequest; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="What is sent">
      <div className="dialog dialog-wide">
        <h2 className="dialog-title">Exactly what is sent</h2>
        <p className="dialog-message">
          Karen sends these two messages and nothing else. The manuscript is shown in full at
          the end of the second.
        </p>
        <div className="review-preview">
          <p className="project-group-head">System</p>
          <pre>{buildSystem(request)}</pre>
          <p className="project-group-head">User</p>
          <pre>{buildUser(request)}</pre>
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
