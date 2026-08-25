/**
 * Academic search as a thing YOU do, not something the model does for you.
 *
 * `web_search` already queries these APIs, but its answer is prose formatted
 * for a model to read and it costs a full conversation turn to ask. Wanting to
 * look something up is not the same as wanting to talk to a language model
 * about it — and for a straight lookup the model is pure overhead: slower,
 * dearer, and capable of paraphrasing a title.
 *
 * So this returns STRUCTURE, not text, and no model is involved at any point.
 * What comes back is what OpenAlex and arXiv actually said, which is why the
 * results can carry citation counts and open-access links that Google Scholar
 * will not hand you.
 */

import { arxivSearch } from "./arxiv.ts";
import { collapseDuplicates, type Dedupable } from "./dedupe.ts";
import {
  abstractFromInverted, authorsOf, oaUrl, openAlexSearch, venueOf, type Work,
} from "./openalex.ts";

export interface AcademicResult {
  /** Stable within one result set, for React keys and selection. */
  id: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** Times cited, per OpenAlex. Absent for arXiv-only records. */
  citedBy?: number;
  doi?: string;
  abstract?: string;
  /** The landing page: a DOI resolver where there is one. */
  url: string;
  /** A directly readable full text, when the record names one. */
  pdfUrl?: string;
  /** Which backend produced it, so a result is traceable. */
  engine: string;
}

export type SortBy = "relevance" | "citations" | "newest";

export interface LookupOptions {
  page?: number;
  sort?: SortBy;
  signal?: AbortSignal;
}

/** How many each backend returns per page. */
const PER_PAGE = 25;

function fromOpenAlex(w: Work): Omit<AcademicResult, "id"> | undefined {
  if (!w.title) return undefined;
  const doi = w.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const url = doi ? `https://doi.org/${doi}` : (oaUrl(w) ?? w.id);
  if (!url) return undefined;
  const abstract = abstractFromInverted(w.abstract_inverted_index);
  const venue = venueOf(w);
  const pdf = oaUrl(w);
  return {
    title: w.title,
    authors: authorsOf(w),
    ...(w.publication_year ? { year: w.publication_year } : {}),
    ...(venue && venue !== "(venue unknown)" ? { venue } : {}),
    ...(typeof w.cited_by_count === "number" ? { citedBy: w.cited_by_count } : {}),
    ...(doi ? { doi } : {}),
    ...(abstract ? { abstract } : {}),
    url,
    ...(pdf ? { pdfUrl: pdf } : {}),
    engine: "openalex",
  };
}

/**
 * Sort a result set that has already been fetched.
 *
 * Deliberately client-side. Both backends return relevance order, and asking
 * them to sort differently changes WHICH results come back, not just their
 * order — so "sort by citations" would silently become a different search and
 * the paper you were looking at would vanish. Reordering what is in front of
 * you is what the control appears to promise, so it is what it does.
 */
export function sortResults(results: AcademicResult[], sort: SortBy): AcademicResult[] {
  if (sort === "relevance") return results;
  const copy = [...results];
  if (sort === "citations") {
    copy.sort((a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1) || a.id - b.id);
  } else {
    copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.id - b.id);
  }
  return copy;
}

/**
 * Search both backends and merge.
 *
 * One backend failing is not a failed search — arXiv rate-limits and OpenAlex
 * meters its free tier — but the caller is told which, because a quietly
 * halved result set looks like a thin literature rather than a thin search.
 */
export async function academicLookup(
  query: string,
  opts: LookupOptions = {},
): Promise<{ results: AcademicResult[]; failures: string[] }> {
  const page = Math.max(1, opts.page ?? 1);
  const trimmed = query.trim();
  if (!trimmed) return { results: [], failures: [] };

  const settled = await Promise.allSettled([
    openAlexSearch(trimmed, PER_PAGE, opts.signal, page).then((works) =>
      works.map(fromOpenAlex).filter((r): r is Omit<AcademicResult, "id"> => r !== undefined),
    ),
    arxivSearch(trimmed, PER_PAGE, opts.signal, page).then((papers) =>
      papers.map((p) => ({
        title: p.title,
        authors: p.authors,
        ...(p.published ? { year: Number(p.published.slice(0, 4)) || undefined } : {}),
        venue: "arXiv",
        ...(p.summary ? { abstract: p.summary } : {}),
        url: p.id || p.pdf,
        ...(p.pdf ? { pdfUrl: p.pdf } : {}),
        engine: "arxiv",
      })) as Omit<AcademicResult, "id">[],
    ),
  ]);

  const merged: Omit<AcademicResult, "id">[] = [];
  const failures: string[] = [];
  const names = ["OpenAlex", "arXiv"];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") merged.push(...r.value);
    else failures.push(`${names[i]}: ${(r.reason as Error)?.message ?? "failed"}`);
  });

  // The same paper reaches us from both backends constantly; collapsing here
  // is the difference between a usable list and one with visible duplicates.
  const numbered = merged.map((r, i) => ({ ...r, id: i + 1 }));
  const { rows } = collapseDuplicates(numbered as (Dedupable & AcademicResult)[]);
  const results = (rows as AcademicResult[]).map((r, i) => ({ ...r, id: i + 1 }));

  return { results: sortResults(results, opts.sort ?? "relevance"), failures };
}
