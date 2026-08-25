import { useEffect, useMemo, useState } from "react";
import type { RunDetail, RunSource, RunSummary } from "../types.ts";

/**
 * The run panel: what a research run actually did, and why you should believe it.
 *
 * Every number and every row here was already on disk after each run — the
 * search log, each screening decision and its reason, each source's sha256 and
 * stored text, the passages that failed the verbatim check, the citation
 * verdicts. None of it was reachable from anywhere in the app, which meant the
 * pipeline recorded its provenance carefully and then showed you a report and
 * asked you to trust it.
 *
 * So the organising idea is the funnel, top to bottom: what was searched, what
 * survived screening, what was read, and what the checks found. The exclusions
 * matter more than the inclusions here — "did I miss something?" is the
 * question an academic reader actually has, and it is answered by reading the
 * reasons papers were thrown out.
 */

type Tab = "funnel" | "searches" | "screening" | "sources" | "checks" | "report";

const TABS: { id: Tab; label: string }[] = [
  { id: "funnel", label: "Overview" },
  { id: "searches", label: "Searches" },
  { id: "screening", label: "Screening" },
  { id: "sources", label: "Sources" },
  { id: "checks", label: "Checks" },
  { id: "report", label: "Report" },
];

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function RunPanel({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<RunDetail | undefined>();
  const [tab, setTab] = useState<Tab>("funnel");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void window.karen
      .researchRuns()
      .then((list) => {
        setRuns(list);
        setSelected((current) => current ?? list[0]?.id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDetail(undefined);
    void window.karen
      .researchRun(selected)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  return (
    <div className="runs-backdrop" onClick={onClose}>
      <div className="runs" onClick={(e) => e.stopPropagation()}>
        <div className="runs-rail">
          <p className="runs-rail-title">Research runs</p>
          {runs.length === 0 ? (
            <p className="runs-empty">No runs yet. A deep research run files itself here.</p>
          ) : null}
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === selected ? "run-row active" : "run-row"}
              onClick={() => {
                setSelected(r.id);
                setTab("funnel");
              }}
            >
              <span className="run-q">{r.question}</span>
              <span className="run-meta">
                {when(r.startedAt) || r.id}
                {r.nextStage ? ` · unfinished at ${r.nextStage}` : ""}
                {r.paused ? " · paused" : ""}
              </span>
            </button>
          ))}
        </div>

        <div className="runs-body">
          <div className="runs-head">
            <div className="runs-tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tab === t.id ? "tab active" : "tab"}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="runs-actions">
              {selected ? (
                <button type="button" onClick={() => void window.karen.researchReveal(selected)}>
                  Open folder
                </button>
              ) : null}
              <button type="button" className="close" onClick={onClose} aria-label="Close">
                ×
              </button>
            </div>
          </div>

          <div className="runs-pane">
            {error ? <p className="run-error">{error}</p> : null}
            {!detail ? (
              <p className="runs-empty">{selected ? "Reading the run…" : "Select a run."}</p>
            ) : (
              <RunTab tab={tab} detail={detail} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunTab({ tab, detail }: { tab: Tab; detail: RunDetail }) {
  if (tab === "funnel") return <Overview detail={detail} />;
  if (tab === "searches") return <Searches detail={detail} />;
  if (tab === "screening") return <Screening detail={detail} />;
  if (tab === "sources") return <Sources detail={detail} />;
  if (tab === "checks") return <Checks detail={detail} />;
  return <Report detail={detail} />;
}

/* ------------------------------------------------------------------ overview */

function Overview({ detail }: { detail: RunDetail }) {
  const c = detail.counts;
  const steps = [
    { label: "found", n: c.found },
    { label: "deduped", n: c.deduped },
    { label: "screened in", n: c.screened },
    { label: "read in full", n: c.read },
    { label: "cited", n: c.cited },
  ];
  const widest = Math.max(1, ...steps.map((s) => s.n));

  return (
    <div className="run-section">
      <h3>{detail.question}</h3>
      <p className="run-sub">
        {when(detail.startedAt)}
        {detail.nextStage ? ` · did not finish — would resume at ${detail.nextStage}` : " · complete"}
      </p>

      {/* PRISMA-lite. Every number is the length of a file the run wrote, so
          none of it is bookkeeping that could disagree with what happened. */}
      <div className="funnel">
        {steps.map((s) => (
          <div className="funnel-row" key={s.label}>
            <span className="funnel-label">{s.label}</span>
            <span className="funnel-bar" style={{ width: `${(s.n / widest) * 100}%` }} />
            <span className="funnel-n">{s.n}</span>
          </div>
        ))}
      </div>

      <h4>What the run reports about itself</h4>
      <pre className="run-summary">{detail.summary}</pre>

      <h4>Stages</h4>
      <ol className="stages">
        {detail.stages.map((s) => (
          <li key={s.stage} className={s.done ? "done" : "pending"}>
            {s.stage}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ searches */

function Searches({ detail }: { detail: RunDetail }) {
  return (
    <div className="run-section">
      <h3>Every query this run issued</h3>
      <p className="run-sub">
        The reproducible search log. A query that failed is kept, because it explains a thin funnel
        better than its absence does.
      </p>
      <div className="table-scroll">
        <table className="run-table">
          <thead>
            <tr>
              <th>Query</th>
              <th className="num">Page</th>
              <th className="num">Results</th>
              <th className="num">New</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {detail.searches.map((s, i) => (
              <tr key={i} className={s.error ? "failed" : ""}>
                <td>
                  {s.query}
                  {s.error ? <span className="pill bad">{s.error}</span> : null}
                </td>
                <td className="num">{s.page ?? 1}</td>
                <td className="num">{s.results}</td>
                <td className="num">{s.newResults ?? ""}</td>
                <td className="dim">{when(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.searches.length === 0 ? <p className="runs-empty">No searches recorded.</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- screening */

function Screening({ detail }: { detail: RunDetail }) {
  const [show, setShow] = useState<"excluded" | "included" | "all">("excluded");
  const rows = useMemo(
    () =>
      detail.screened.filter((d) =>
        show === "all" ? true : show === "included" ? d.include : !d.include,
      ),
    [detail.screened, show],
  );

  return (
    <div className="run-section">
      <h3>What was screened out, and why</h3>
      <p className="run-sub">
        Exclusions are shown first on purpose: “did I miss something?” is answered by reading the
        reasons papers were thrown out, not the reasons they were kept.
      </p>
      <div className="seg">
        {(["excluded", "included", "all"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={show === v ? "active" : ""}
            onClick={() => setShow(v)}
          >
            {v} ({v === "all" ? detail.screened.length : detail.screened.filter((d) => (v === "included" ? d.include : !d.include)).length})
          </button>
        ))}
      </div>
      <ul className="decisions">
        {rows.map((d) => (
          <li key={d.id} className={d.include ? "in" : "out"}>
            <p className="dec-title">
              {d.title ?? `candidate ${d.id}`}
              {d.year ? <span className="dim"> · {d.year}</span> : null}
              {d.venue ? <span className="dim"> · {d.venue}</span> : null}
            </p>
            <p className="dec-reason">
              {d.reason}
              {/* A candidate the model never mentioned was KEPT rather than
                  dropped, and the run has to say which those were. */}
              {d.defaulted ? <span className="pill warn">no decision returned — kept</span> : null}
              {/* Found by following citations rather than by any query, which
                  is exactly the provenance a reader wants to know. */}
              {d.snowballRound !== undefined ? (
                <span className="pill">cited by included papers</span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="runs-empty">Nothing in this group.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- sources */

function Sources({ detail }: { detail: RunDetail }) {
  const [open, setOpen] = useState<number | undefined>();
  const [source, setSource] = useState<RunSource | undefined>();

  useEffect(() => {
    if (open === undefined) return;
    setSource(undefined);
    void window.karen.researchSource(detail.id, open).then(setSource).catch(() => setSource(undefined));
  }, [detail.id, open]);

  return (
    <div className="run-section">
      <h3>What was actually read</h3>
      <p className="run-sub">
        Each source is stored with a hash of the exact text it was cited from, so a citation can be
        checked long after the page changes. Open one to see the passages extraction located in it.
      </p>
      <ul className="sources-list">
        {detail.sources.map((s) => (
          <li key={s.n}>
            <button type="button" className="source-head" onClick={() => setOpen(open === s.n ? undefined : s.n)}>
              <span className="cite-n">[{s.n}]</span>
              <span className="source-title">{s.title || s.url}</span>
              <span className="pill">{s.via}</span>
              {s.via === "abstract" ? <span className="pill warn">abstract only</span> : null}
              {s.note ? <span className="pill warn">open version</span> : null}
            </button>
            <p className="source-meta dim">
              {[s.authors?.slice(0, 3).join(", "), s.year, s.venue, s.doi ? `doi:${s.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="source-meta dim">
              {s.chars.toLocaleString()} chars · sha256 {s.sha256.slice(0, 16)}… · retrieved {when(s.retrievedAt)}
            </p>
            {open === s.n ? <SourceText source={source} /> : null}
          </li>
        ))}
      </ul>
      {detail.sources.length === 0 ? <p className="runs-empty">No sources were read.</p> : null}
    </div>
  );
}

/** The stored text with every located passage marked in place. */
function SourceText({ source }: { source: RunSource | undefined }) {
  if (!source) return <p className="runs-empty">Reading…</p>;

  // Spans arrive sorted and non-overlapping (extraction locates each quote
  // independently, so build defensively anyway and skip anything that would
  // run backwards).
  const parts: { text: string; hit: boolean; claim?: string }[] = [];
  let at = 0;
  for (const span of source.spans) {
    if (span.start < at || span.end > source.text.length) continue;
    if (span.start > at) parts.push({ text: source.text.slice(at, span.start), hit: false });
    parts.push({ text: source.text.slice(span.start, span.end), hit: true, claim: span.claim });
    at = span.end;
  }
  parts.push({ text: source.text.slice(at), hit: false });

  return (
    <div className="source-body">
      <p className="run-sub">
        {source.spans.length} located passage{source.spans.length === 1 ? "" : "s"}
      </p>
      <pre className="source-text">
        {parts.map((p, i) =>
          p.hit ? (
            <mark key={i} title={p.claim}>
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}

/* -------------------------------------------------------------------- checks */

function Checks({ detail }: { detail: RunDetail }) {
  // Flagged first: a clean "supports" needs no attention, and burying the
  // three that failed under forty that passed is how a check stops being read.
  const ordered = useMemo(
    () =>
      [...detail.verification].sort((a, b) => {
        const rank = (v: string) => (v === "supports" ? 1 : 0);
        return rank(a.verdict) - rank(b.verdict) || a.sentenceIndex - b.sentenceIndex;
      }),
    [detail.verification],
  );
  const badQuotes = detail.quoteChecks.filter((q) => !q.verbatim);

  return (
    <div className="run-section">
      <h3>What the checks found</h3>

      <h4>Quotations</h4>
      <p className="run-sub">
        A mechanical check, not a judgement: every quoted span in the finished report either appears
        in the stored source it cites, or it does not.
      </p>
      {detail.quoteChecks.length === 0 ? (
        <p className="runs-empty">The report quotes nothing directly.</p>
      ) : badQuotes.length === 0 ? (
        <p className="ok-line">
          All {detail.quoteChecks.length} quotation{detail.quoteChecks.length === 1 ? "" : "s"}{" "}
          verbatim in the source cited.
        </p>
      ) : (
        <ul className="flags">
          {badQuotes.map((q, i) => (
            <li key={i} className="bad">
              <p className="flag-note">
                {q.citation ? `[${q.citation}] ` : ""}
                {q.reason ?? "not verbatim"}
              </p>
              <p className="flag-sentence">“{q.quote}”</p>
            </li>
          ))}
        </ul>
      )}

      <h4>Cited statements</h4>
      <p className="run-sub">
        Whether a paraphrase represents its source is a judgement, so it is checked and whatever
        fails is shown rather than quietly dropped.
      </p>
      <ul className="flags">
        {ordered.map((c, i) => (
          <li key={i} className={c.verdict === "supports" ? "ok" : "bad"}>
            <p className="flag-note">
              <span className="cite-n">[{c.source}]</span>
              <span className={`pill ${c.verdict === "supports" ? "" : "bad"}`}>{c.verdict}</span>
              {c.note}
            </p>
            <p className="flag-sentence">{c.sentence}</p>
          </li>
        ))}
      </ul>
      {detail.verification.length === 0 ? <p className="runs-empty">No citations were checked.</p> : null}

      {detail.dropped.length > 0 ? (
        <>
          <h4>Passages discarded before the report</h4>
          <p className="run-sub">
            The model produced these but they could not be found verbatim in the source, so they
            never reached synthesis. This is the guarantee working, not a failure.
          </p>
          <ul className="flags">
            {detail.dropped.map((d, i) => (
              <li key={i} className="dropped">
                <p className="flag-note">
                  <span className="cite-n">[{d.source}]</span>
                  {d.reason}
                </p>
                <p className="flag-sentence">“{d.quote}”</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- report */

function Report({ detail }: { detail: RunDetail }) {
  const [view, setView] = useState<"report" | "review" | "bibtex">("report");
  const text =
    view === "report" ? detail.report : view === "review" ? detail.review : detail.bibtex;

  return (
    <div className="run-section">
      <div className="seg">
        <button type="button" className={view === "report" ? "active" : ""} onClick={() => setView("report")}>
          Report
        </button>
        <button type="button" className={view === "review" ? "active" : ""} onClick={() => setView("review")}>
          Critique
        </button>
        <button type="button" className={view === "bibtex" ? "active" : ""} onClick={() => setView("bibtex")}>
          BibTeX
        </button>
      </div>
      {text ? (
        <pre className="run-doc">{text}</pre>
      ) : (
        <p className="runs-empty">
          {view === "bibtex"
            ? "No bibliography — this run finished before exports were added, or read no sources."
            : `The run did not get as far as writing a ${view}.`}
        </p>
      )}
    </div>
  );
}
