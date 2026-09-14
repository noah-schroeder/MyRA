import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Reasoning } from "./Reasoning.tsx";
import {
  buildSystem, buildUser, requestsFor, studyTypeById, type ReviewRequest,
} from "../../core/review/prompt.ts";
import { fitsContext, tooLongMessage, type Fit } from "../../core/review/manuscript.ts";
import type { JobSnapshot, ReviewSummary, Settings } from "../types.ts";

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
 * one, and note the second benefit: MyRA never records where an unpublished
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
  openId,
  onClose,
  onOpenSettings,
  onOpenModels,
}: {
  settings: Settings | undefined;
  /** A saved review to show, from the rail or from a project. */
  openId?: string | undefined;
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
  /**
   * The run, as main reports it, rather than as this page remembers it.
   *
   * All of this used to be component state -- which reviewer, the text arriving,
   * the reasoning, whether anything was running at all -- and the window
   * unmounts this page the moment you look at a conversation. So leaving the tab
   * mid-panel threw away a report the run then carried on writing into nothing.
   * Main owns the job and the record; this reads them, and the snapshot below is
   * what makes coming back mid-reviewer show that reviewer.
   */
  const [job, setJob] = useState<JobSnapshot | null>(null);
  /** Reviews already on disk, newest first. */
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  /** Which saved review is on screen, so it can be re-read as it grows. */
  const [openedId, setOpenedId] = useState<string | undefined>();
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
    void window.myra.reviewContext().then((r) => setContextTokens(r.contextTokens));
  }, []);
  useEffect(() => {
    askContext();
    return window.myra.onRuntime(askContext);
  }, [askContext]);

  const refreshList = useCallback(async () => {
    const result = await window.myra.reviewList();
    setReviews(result.reviews ?? []);
  }, []);

  /**
   * Put a saved review on screen.
   *
   * `fields` is false when the record is being re-read because a reviewer just
   * finished: the report grows, and the title and note boxes must not be
   * rewritten underneath somebody who is typing in them.
   */
  const showReview = useCallback(async (id: string, fields = true): Promise<void> => {
    const result = await window.myra.reviewOpen(id);
    if (!result.ok || !result.review) {
      if (fields) setError(result.error ?? "That review could not be read.");
      return;
    }
    const record = result.review;
    setOpenedId(record.id);
    setReview(record.assembled);
    setInvented(record.invented);
    if (fields) {
      setTitle(record.title);
      setStudyTypeId(record.studyTypeId);
      setNote(record.note);
      setError(record.status === "failed" ? record.error : undefined);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  /* Asked once on mount and then pushed. The question is the half that matters:
     a page mounted four minutes into the second reviewer draws that reviewer,
     rather than sitting empty until the third begins. */
  useEffect(() => {
    void window.myra.workState().then((snapshot) => {
      setJob(snapshot);
      if (snapshot?.kind === "review") void showReview(snapshot.id);
    });
    return window.myra.onWork(setJob);
  }, [showReview]);

  /* Main saves after every reviewer, so the report on screen catches up one
     reviewer at a time rather than all at once at the end. */
  useEffect(
    () =>
      window.myra.onReviews((rows) => {
        setReviews(rows);
        if (openedId) void showReview(openedId, false);
      }),
    [openedId, showReview],
  );

  /* Opening one from the rail or from a project. */
  useEffect(() => {
    if (openId) void showReview(openId);
  }, [openId, showReview]);

  const take = useCallback(async (file: File): Promise<void> => {
    setError(undefined);
    setNeedsPandoc(false);
    setReading(true);
    setReview("");
    try {
      const bytes = await file.arrayBuffer();
      const result = await window.myra.reviewExtract(file.name, bytes);
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

  const requests: ReviewRequest[] = useMemo(() => {
    if (!loaded) return [];
    return requestsFor({
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
  const fit: Fit | undefined = requests.length ? fitsContext(requests, contextTokens) : undefined;
  const panel = studyTypeById(types, studyTypeId)?.reviewers ?? [];

  /** This page's own run, if the long job in flight is a review. */
  const mine = job?.kind === "review" ? job : undefined;
  const running = Boolean(mine);
  /* Something long is running that is not a review -- a paper section. Said
     rather than discovered by pressing the button. */
  const elsewhere = job !== null && !mine;

  const run = async (): Promise<void> => {
    if (!requests.length || job) return;
    setError(undefined);
    setReview("");
    setInvented([]);
    setOpenedId(undefined);
    const result = await window.myra.reviewRun(requests, {
      title,
      fileName: loaded?.name ?? "",
      studyTypeId,
    });
    await refreshList();
    if (result.id) setOpenedId(result.id);
    if (!result.ok) setError(result.error ?? "The review failed.");
    else if (result.text) {
      setReview(result.text);
      setInvented(result.invented ?? []);
      if (result.stopped) setError("Stopped. What the reviewers finished is kept below.");
    }
  };

  const remove = async (id: string): Promise<void> => {
    await window.myra.reviewDelete(id);
    if (openedId === id) {
      setOpenedId(undefined);
      setReview("");
      setInvented([]);
    }
    await refreshList();
  };

  const installPandoc = async (): Promise<void> => {
    setInstalling(true);
    const r = await window.myra.installPandoc();
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
              Drop a manuscript in and MyRA reads it and writes a review. Nothing is uploaded
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

        <div className="lem-callout">
          <p className="lem-callout-title">Use this on your own work.</p>
          <p className="lem-callout-body">
            This is intended solely for reviewing your own work. Don't use it to peer review
            other people's papers unless they've given you explicit permission.
          </p>
        </div>

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

        {/* What is already on disk. It sits above the manuscript form because
            "the one I ran this morning" is the more common reason to open this
            page than "here is a new manuscript". */}
        {reviews.length ? (
          <section className="review-saved">
            <p className="field-label">Your reviews</p>
            <ul className="review-list">
              {reviews.map((r) => (
                <li key={r.id} className={r.id === openedId ? "on" : ""}>
                  <button type="button" className="review-list-open" onClick={() => void showReview(r.id)}>
                    <span className="review-list-title">{r.title}</span>
                    <span className="review-list-meta">
                      {r.studyLabel ? `${r.studyLabel} · ` : ""}
                      {r.done} of {r.total} {r.total === 1 ? "reviewer" : "reviewers"}
                      {r.status === "stopped" ? " · stopped" : ""}
                      {r.status === "failed" ? " · failed" : ""}
                      {r.words ? ` · ${r.words.toLocaleString()} words` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="review-list-del"
                    title="Delete this review"
                    onClick={() => void remove(r.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {/* Said plainly, because the absence is deliberate and would
                otherwise be discovered by someone expecting to re-run one. */}
            <p className="field-note">
              MyRA keeps the report and never the manuscript — it is not yours to store. To
              review one of these again, drop the file in again.
            </p>
          </section>
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

            {/* Who will be writing, before anything is sent. Three reports of
                up to 2,000 words takes real time, and the panel is the thing
                that explains what that time is buying. */}
            {panel.length ? (
              <div className="review-panel">
                <p className="field-label">This will produce {panel.length} reports</p>
                <ul>
                  {panel.map((r, i) => (
                    <li key={r.id} className={mine && mine.step > i ? "done" : ""}>
                      {r.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

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
                <button
                  type="button"
                  className="stop"
                  onClick={() => void window.myra.reviewCancel(mine?.id)}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={!fit?.fits || elsewhere}
                  title={elsewhere ? "MyRA is drafting a section. This can start when that finishes." : undefined}
                  onClick={() => void run()}
                >
                  Review it
                </button>
              )}
            </div>
          </>
        ) : null}

        {mine ? (
          <section className="review-live">
            <p className="review-live-head">
              Writing {mine.step + 1} of {mine.steps} · {mine.label}
            </p>
            {/* Collapsed, with a live tail in its header until the report
                starts. `streaming` is tied to the report rather than to the
                run: once prose is arriving the thinking is finished, and the
                block settles into a word count instead of a moving tail
                competing with the text below it. */}
            {mine.thinking ? <Reasoning text={mine.thinking} streaming={!mine.text} /> : null}
            {/* The text as it arrives, so a long report is visibly progressing
                rather than a spinner with nothing behind it. */}
            {mine.text ? <pre className="review-live-text">{mine.text.slice(-1400)}</pre> : null}
          </section>
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
                  onClick={() => void window.myra.reviewSave(`${title || "review"}.md`, review)}
                >
                  Save as Markdown
                </button>
              </div>
            </header>
            {invented.length ? (
              <p className="review-invented">
                This review contains {invented.length === 1 ? "a reference" : "references"} MyRA
                did not give the model — {invented.slice(0, 6).join(", ")}
                {invented.length > 6 ? ", …" : ""}. Nothing here searched the literature, so
                {invented.length === 1 ? " it is" : " they are"} invented. Delete
                {invented.length === 1 ? " it" : " them"} before you rely on this review.
              </p>
            ) : null}
            <Markdown text={review} sources={new Map()} />
          </section>
        ) : null}

        {showPrompt && requests.length ? (
          <PromptPreview requests={requests} onClose={() => setShowPrompt(false)} />
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
function PromptPreview({
  requests,
  onClose,
}: {
  requests: ReviewRequest[];
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const request = requests[at] ?? requests[0]!;
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
          One request per reviewer, each carrying the whole manuscript. MyRA sends these two
          messages and nothing else; the manuscript is shown in full at the end of the second.
        </p>
        <div className="review-types">
          {requests.map((r, i) => (
            <button
              key={r.reviewerLabel}
              type="button"
              className={i === at ? "review-type on" : "review-type"}
              onClick={() => setAt(i)}
            >
              {r.reviewerLabel}
            </button>
          ))}
        </div>
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
