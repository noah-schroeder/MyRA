import { useCallback, useEffect, useRef, useState } from "react";
import type { AcademicResult, SortBy } from "../types.ts";

/**
 * Academic search you drive yourself.
 *
 * The same APIs the research pipeline uses, without a model in the loop —
 * because wanting to look something up is not the same as wanting to talk to a
 * language model about it, and for a straight lookup the model is pure
 * overhead: slower, dearer, and able to paraphrase a title.
 *
 * What earns this its place next to Scholar is the metadata we already have and
 * Scholar will not give you: a citation count, and an **open-access link
 * resolved for you** so the readable copy is one click rather than a hunt. And
 * nothing here is logged, ranked by an advertiser, or personalised.
 *
 * Links open in your own browser, never in a window of ours. Rendering an
 * arbitrary page inside the app would put untrusted web content next to your
 * vault and undo the sandbox the rest of the app is built on.
 */

const SORTS: { id: SortBy; label: string; hint: string }[] = [
  { id: "relevance", label: "Relevance", hint: "The order the databases returned" },
  { id: "citations", label: "Most cited", hint: "Reorders these results; does not re-search" },
  { id: "newest", label: "Newest", hint: "Reorders these results; does not re-search" },
];

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sort, setSort] = useState<SortBy>("relevance");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<AcademicResult[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<number | undefined>();
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => box.current?.focus(), []);

  const run = useCallback(
    async (q: string, nextPage: number, nextSort: SortBy) => {
      if (!q.trim()) return;
      setBusy(true);
      setError(undefined);
      setOpen(undefined);
      try {
        const found = await window.karen.academicSearch(q, { page: nextPage, sort: nextSort });
        setResults(found.results);
        setFailures(found.failures);
      } catch (e) {
        setError((e as Error).message);
        setResults([]);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const submit = (): void => {
    const q = query.trim();
    if (!q) return;
    setSubmitted(q);
    setPage(1);
    void run(q, 1, sort);
  };

  const changeSort = (next: SortBy): void => {
    setSort(next);
    // Sorting is a reorder of what is already here, so it must not re-search:
    // a different query would make the paper you were reading disappear.
    if (submitted) void run(submitted, page, next);
  };

  const goToPage = (next: number): void => {
    setPage(next);
    void run(submitted, next, sort);
  };

  return (
    <div className="runs-backdrop" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <input
            ref={box}
            className="search-box"
            type="search"
            placeholder="Search OpenAlex and arXiv…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label="Search the literature"
          />
          <button type="button" className="search-go" onClick={submit} disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {submitted ? (
          <div className="search-bar">
            <div className="seg">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.hint}
                  className={sort === s.id ? "active" : ""}
                  onClick={() => changeSort(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="search-count">
              {busy ? "" : `${results.length} result${results.length === 1 ? "" : "s"}`}
            </span>
          </div>
        ) : null}

        <div className="search-results">
          {error ? <p className="run-error">{error}</p> : null}
          {/* A halved result set looks like a thin literature rather than a
              thin search, so say which backend was missing. */}
          {failures.map((f) => (
            <p key={f} className="search-warn">
              {f}
            </p>
          ))}

          {!submitted && !busy ? (
            <div className="search-intro">
              <p>Search the literature directly — no model, nothing logged.</p>
              <p className="dim">
                Results carry citation counts and, where one exists, a link to the open-access
                full text. Everything opens in your own browser.
              </p>
            </div>
          ) : null}

          {submitted && !busy && results.length === 0 && !error ? (
            <p className="runs-empty">
              Nothing matched “{submitted}”. Scholarly databases match on title, abstract and
              keywords, so fewer and more specific words usually work better than a sentence.
            </p>
          ) : null}

          <ul className="results">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="result-title"
                  onClick={() => setOpen(open === r.id ? undefined : r.id)}
                  aria-expanded={open === r.id}
                >
                  {r.title}
                </button>
                <p className="result-meta">
                  {[
                    r.authors.length
                      ? r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? ", et al." : "")
                      : "",
                    r.year,
                    r.venue,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="result-links">
                  {r.citedBy !== undefined ? (
                    <span className="pill">cited by {r.citedBy.toLocaleString()}</span>
                  ) : null}
                  {r.pdfUrl ? <span className="pill open">open access</span> : null}
                  <button type="button" onClick={() => void window.karen.openExternal(r.url)}>
                    {r.doi ? "Publisher page" : "Open"}
                  </button>
                  {r.pdfUrl ? (
                    <button type="button" onClick={() => void window.karen.openExternal(r.pdfUrl!)}>
                      Read full text
                    </button>
                  ) : null}
                  {r.doi ? <span className="result-doi">doi:{r.doi}</span> : null}
                </p>
                {open === r.id ? (
                  <p className="result-abstract">
                    {r.abstract?.trim() ? r.abstract : "This record carries no abstract."}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {results.length > 0 ? (
            <div className="search-pager">
              <button type="button" disabled={page <= 1 || busy} onClick={() => goToPage(page - 1)}>
                Previous
              </button>
              <span className="dim">page {page}</span>
              <button type="button" disabled={busy} onClick={() => goToPage(page + 1)}>
                Next
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
