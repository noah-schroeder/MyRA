import { useState } from "react";
import { databaseById } from "../../core/research/databases.ts";
import type { LookupState } from "../useLookup.ts";
import type { SortBy } from "../types.ts";

/**
 * What a lookup returns, in the place a conversation would have been.
 *
 * This was a modal over the thread, which framed reading the literature as an
 * interruption to be dismissed. It is not: it is one of the three things you
 * can do with the box at the bottom of the window, so it gets the same room the
 * other two get.
 *
 * What earns this its place next to Scholar is the metadata we already have and
 * Scholar will not give you: a citation count, and an open-access link resolved
 * for you so the readable copy is one click rather than a hunt. And nothing
 * here is logged, ranked by an advertiser, or personalised.
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

export function LookupResults({
  state,
  onSort,
  onPage,
}: {
  state: LookupState;
  onSort: (sort: SortBy) => void;
  onPage: (page: number) => void;
}) {
  const [open, setOpen] = useState<number | undefined>();
  const { query, results, failures, busy, error, sort, page } = state;

  return (
    <section className="lookup" aria-label="Literature search">
      {query ? (
        <div className="search-bar">
          <div className="seg">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.hint}
                className={sort === s.id ? "active" : ""}
                onClick={() => onSort(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="search-count">
            {busy ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
          </span>
        </div>
      ) : null}

      <div className={query ? "search-results" : "search-results empty"}>
        {error ? <p className="run-error">{error}</p> : null}
        {/* A halved result set looks like a thin literature rather than a thin
            search, so say which backend was missing. */}
        {failures.map((f) => (
          <p key={f} className="search-warn">
            {f}
          </p>
        ))}

        {!query && !busy ? (
          <div className="search-intro">
            <h2>Search the literature yourself</h2>
            <p>
              Queried directly, whichever databases are chosen above — no model, nothing logged,
              nothing ranked by an advertiser.
            </p>
            <p className="dim">
              Results carry citation counts and, where one exists, a link to the open-access full
              text. Everything opens in your own browser. Type below and press Enter.
            </p>
          </div>
        ) : null}

        {query && !busy && results.length === 0 && !error ? (
          <p className="runs-empty">
            Nothing matched “{query}”. Scholarly databases match on title, abstract and keywords,
            so fewer and more specific words usually work better than a sentence.
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
                {/* Which database this came from -- worth naming once a search
                    can merge four of them, the way the citation trail already
                    names an `engine` on every source. */}
                <span className="result-source">{databaseById(r.engine)?.label ?? r.engine}</span>
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
            <button type="button" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>
              Previous
            </button>
            <span className="dim">page {page}</span>
            <button type="button" disabled={busy} onClick={() => onPage(page + 1)}>
              Next
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
