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
 * What comes back is what the chosen databases actually said, which is why
 * the results can carry citation counts and open-access links that Google
 * Scholar will not hand you.
 *
 * This is a SECOND, parallel fan-out to `providers.ts` -- deliberately, not
 * an oversight. `SearchHit` is flat; `AcademicResult` carries the structure
 * (citation counts, abstracts, PDF links) the results table renders, and
 * forcing that through `SearchProvider` would lose it. What it shares with
 * `providers.ts` is the one list of database ids: `resolveProviders`'
 * key-availability check has an identical shape here (`hasDatabaseKey`), so
 * the two cannot drift into naming different databases as available.
 */

import { arxivSearch } from "./arxiv.ts";
import { readResearchConfig } from "./config.ts";
import { coreSearch, type CoreRecord } from "./coreApi.ts";
import { DATABASES, DEFAULT_DATABASES, type DatabaseId } from "./databases.ts";
import { collapseDuplicates, type Dedupable } from "./dedupe.ts";
import { hasDatabaseKey } from "./keys.ts";
import {
  abstractFromInverted, authorsOf, oaUrl, openAlexSearch, venueOf, type Work,
} from "./openalex.ts";
import { pubmedSearch, type PubmedRecord } from "./pubmed.ts";

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
  /** Which databases to query, by id. Defaults to `research.json`'s choice. */
  databases?: string[];
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

function fromPubmed(r: PubmedRecord): Omit<AcademicResult, "id"> | undefined {
  if (!r.title) return undefined;
  const url = r.doi
    ? `https://doi.org/${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
    : r.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
      : undefined;
  if (!url) return undefined;
  return {
    title: r.title,
    authors: r.authors,
    ...(r.year ? { year: r.year } : {}),
    ...(r.venue ? { venue: r.venue } : {}),
    ...(r.doi ? { doi: r.doi } : {}),
    ...(r.abstract ? { abstract: r.abstract } : {}),
    url,
    engine: "pubmed",
  };
}

function fromCore(r: CoreRecord): Omit<AcademicResult, "id"> | undefined {
  if (!r.title) return undefined;
  const url = r.doi
    ? `https://doi.org/${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
    : r.downloadUrl || (r.id ? `https://core.ac.uk/works/${r.id}` : undefined);
  if (!url) return undefined;
  return {
    title: r.title,
    authors: r.authors,
    ...(r.year ? { year: r.year } : {}),
    // CORE's nearest thing to a venue is its publisher -- the same field
    // coreToHit in providers.ts folds into its byline, so a paper found only
    // through CORE carries the same metadata whichever entry point found it.
    ...(r.publisher ? { venue: r.publisher } : {}),
    ...(r.doi ? { doi: r.doi } : {}),
    ...(r.abstract ? { abstract: r.abstract } : {}),
    url,
    ...(r.downloadUrl ? { pdfUrl: r.downloadUrl } : {}),
    engine: "core",
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

/** One backend's contribution: its label (for failure messages) and its task. */
interface Task {
  label: string;
  run: () => Promise<Omit<AcademicResult, "id">[]>;
}

function tasksFor(
  ids: readonly DatabaseId[],
  query: string,
  page: number,
  signal: AbortSignal | undefined,
): Task[] {
  const tasks: Task[] = [];
  for (const id of ids) {
    if (id === "openalex") {
      tasks.push({
        label: "OpenAlex",
        run: () =>
          openAlexSearch(query, PER_PAGE, signal, page).then((works) =>
            works.map(fromOpenAlex).filter((r): r is Omit<AcademicResult, "id"> => r !== undefined),
          ),
      });
    } else if (id === "arxiv") {
      tasks.push({
        label: "arXiv",
        run: () =>
          arxivSearch(query, PER_PAGE, signal, page).then((papers) =>
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
      });
    } else if (id === "pubmed") {
      tasks.push({
        label: "PubMed",
        run: () =>
          pubmedSearch(query, PER_PAGE, signal, page).then((records) =>
            records.map(fromPubmed).filter((r): r is Omit<AcademicResult, "id"> => r !== undefined),
          ),
      });
    } else if (id === "core") {
      tasks.push({
        label: "CORE",
        run: () =>
          coreSearch(query, PER_PAGE, signal, page).then((records) =>
            records.map(fromCore).filter((r): r is Omit<AcademicResult, "id"> => r !== undefined),
          ),
      });
    }
  }
  return tasks;
}

/**
 * Which of the chosen ids are actually usable right now -- keyless databases
 * always are; a keyed one needs its key present. Named separately from
 * `providers.ts`'s `resolveProviders` because this file returns richer
 * per-backend tasks rather than `SearchProvider`s, but the availability rule
 * is the identical `hasDatabaseKey` check, so the two answer the same
 * question the same way.
 */
async function usableIds(chosen: readonly string[]): Promise<{ ids: DatabaseId[]; unavailable: string[] }> {
  const wanted = chosen.length ? chosen : DEFAULT_DATABASES;
  const ids: DatabaseId[] = [];
  const unavailable: string[] = [];
  for (const raw of wanted) {
    const info = DATABASES.find((d) => d.id === raw);
    if (!info) continue;
    if (info.secret && !(await hasDatabaseKey(info.secret))) {
      unavailable.push(info.label);
      continue;
    }
    ids.push(info.id);
  }
  return { ids, unavailable };
}

/**
 * Search the chosen databases and merge.
 *
 * One backend failing is not a failed search — arXiv rate-limits, OpenAlex
 * meters its free tier, CORE's free tier is tighter still — but the caller is
 * told which, because a quietly halved result set looks like a thin
 * literature rather than a thin search. A database dropped for want of a key
 * is reported the same way, under the same `failures` list, rather than
 * silently searching fewer sources than the picker showed as chosen.
 */
export async function academicLookup(
  query: string,
  opts: LookupOptions = {},
): Promise<{ results: AcademicResult[]; failures: string[] }> {
  const page = Math.max(1, opts.page ?? 1);
  const trimmed = query.trim();
  if (!trimmed) return { results: [], failures: [] };

  const chosen = opts.databases ?? readResearchConfig().databases ?? [];
  const { ids, unavailable } = await usableIds(chosen);
  const tasks = tasksFor(ids, trimmed, page, opts.signal);

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const merged: Omit<AcademicResult, "id">[] = [];
  const failures: string[] = unavailable.map((label) => `${label}: no API key is stored for it`);
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") merged.push(...r.value);
    else failures.push(`${tasks[i]!.label}: ${(r.reason as Error)?.message ?? "failed"}`);
  });

  // The same paper reaches us from several backends constantly; collapsing
  // here is the difference between a usable list and one with visible
  // duplicates.
  const numbered = merged.map((r, i) => ({ ...r, id: i + 1 }));
  const { rows } = collapseDuplicates(numbered as (Dedupable & AcademicResult)[]);
  const results = (rows as AcademicResult[]).map((r, i) => ({ ...r, id: i + 1 }));

  return { results: sortResults(results, opts.sort ?? "relevance"), failures };
}
