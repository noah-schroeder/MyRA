/**
 * Where search results come from, now that there is no container.
 *
 * v1 routed every query -- scholarly and general alike -- through a SearXNG
 * instance the user had to install and run. That was the single heaviest
 * prerequisite in the project, and for academic work it was also the weakest
 * link: SearXNG flattens every result to {url,title,content,engine}, throwing
 * away the citation graph and the OA PDF links that deep research runs on.
 *
 * So scholarly search now goes straight to the APIs. Two of the four --
 * OpenAlex and arXiv -- are keyless and need no container; PubMed and CORE
 * need a key the user supplies themselves (see keys.ts), so `resolveProviders`
 * below is what turns "these four are chosen" into "these of them are
 * actually usable right now". General web search remains an optional provider
 * that is simply absent until the user configures one.
 */

import { arxivSearch } from "./arxiv.ts";
import { coreSearch, type CoreRecord } from "./coreApi.ts";
import { DATABASES, DEFAULT_DATABASES, databaseById } from "./databases.ts";
import { hasDatabaseKey } from "./keys.ts";
import {
  abstractFromInverted, authorsOf, oaUrl, openAlexSearch, venueOf, type Work,
} from "./openalex.ts";
import { pubmedSearch, type PubmedRecord } from "./pubmed.ts";
import {
  NoProviderError,
  dedupe,
  type SearchHit,
  type SearchOptions,
  type SearchProvider,
} from "./types.ts";

/*
 * Results requested per provider, per page.
 *
 * Was 10, which put a ceiling of ~140 candidates on a seven-query run -- thin
 * for anything review-grade. An OpenAlex request costs the same 10 credits at
 * any page size up to 200, so a larger page is free recall; arXiv has no such
 * meter. 50 keeps a single page's abstracts inside a sane response size while
 * roughly quintupling what a sweep sees.
 */
const PER_PROVIDER = 50;

/**
 * Which category names mean "scholarly literature".
 *
 * v1 answered this by fetching SearXNG's /config and inspecting its engine
 * table, with a five-minute cache -- necessary because the answer depended on
 * what the user had enabled in a container. Calling the scholarly APIs
 * directly, the answer is known at compile time.
 */
const SCHOLARLY_CATEGORIES = new Set([
  "science",
  "scientific publications",
  "scholar",
  "scholarly",
  "academic",
]);

export function isScholarlyCategory(category: string | undefined): boolean {
  if (!category) return false;
  return category
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .some((c) => SCHOLARLY_CATEGORIES.has(c));
}

/**
 * The DOI landing page is preferred over the open-access PDF, which looks
 * backwards until you follow what happens next.
 *
 * A SearchHit is flat -- {url, title, content} -- so the URL is the only thing
 * downstream can identify the work by. Putting the oa_url there reads as
 * helpful (it is the full text, after all) and destroys the identity: an OA URL
 * is usually a PMC, Europe PMC, repository or publisher-PII link with no DOI in
 * it, so hydration cannot recover the DOI, falls back to a fuzzy title match,
 * and on a miss files the paper as NOT_A_PAPER -- no citation count, no venue,
 * no abstract, and no full text either.
 *
 * Nothing is lost by preferring the DOI: hydration reads oa_url off the work it
 * identifies, and the pipeline fetches `pdfUrl ?? url`, so the open copy is
 * still what gets read.
 */
export function workToHit(w: Work): SearchHit | undefined {
  const url =
    (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : undefined) ??
    oaUrl(w) ??
    w.id;
  if (!url || !w.title) return undefined;
  const authors = authorsOf(w);
  const byline = authors.length ? `${authors.slice(0, 3).join(", ")}${authors.length > 3 ? " et al." : ""}. ` : "";
  const venue = venueOf(w);
  const abstract = abstractFromInverted(w.abstract_inverted_index);
  return {
    url,
    title: w.title,
    content: `${byline}${venue ? `${venue}. ` : ""}${abstract}`.trim(),
    engine: "openalex",
    publishedDate: w.publication_year ? `${w.publication_year}-01-01` : null,
    // Carried, not discarded: hydration would otherwise re-fetch this exact
    // record by DOI, using the same select= clause that produced it.
    work: w,
  };
}

export const openAlexProvider: SearchProvider = {
  id: "openalex",
  /* Taken from the shared table, so the name on screen is the name of the
     thing that was actually queried. */
  label: databaseById("openalex")!.label,
  scholarly: true,
  timeRange: true,
  async search(query, opts = {}) {
    const works = await openAlexSearch(query, PER_PROVIDER, opts.signal, opts.page ?? 1);
    return works.map(workToHit).filter((h): h is SearchHit => h !== undefined);
  },
};

export const arxivProvider: SearchProvider = {
  id: "arxiv",
  label: databaseById("arxiv")!.label,
  scholarly: true,
  // The Atom API sorts by date but does not filter by it.
  timeRange: false,
  async search(query, opts = {}) {
    const papers = await arxivSearch(query, PER_PROVIDER, opts.signal, opts.page ?? 1);
    return papers.map((p) => ({
      url: p.pdf || p.id,
      title: p.title,
      content: `${p.authors.slice(0, 3).join(", ")}. ${p.summary}`.trim(),
      engine: "arxiv",
      publishedDate: p.published || null,
    }));
  },
};

/**
 * PubMed's URL preference is DOI first, same reasoning as `workToHit`: a
 * SearchHit is flat, so its URL is the only thing hydration can identify the
 * work by, and a non-DOI URL sends it to a fuzzy title match that can miss.
 */
export function pubmedToHit(r: PubmedRecord): SearchHit | undefined {
  const url = r.doi
    ? `https://doi.org/${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
    : r.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
      : undefined;
  if (!url || !r.title) return undefined;
  const authors = r.authors;
  const byline = authors.length
    ? `${authors.slice(0, 3).join(", ")}${authors.length > 3 ? " et al." : ""}. `
    : "";
  return {
    url,
    title: r.title,
    content: `${byline}${r.venue ? `${r.venue}. ` : ""}${r.abstract}`.trim(),
    engine: "pubmed",
    publishedDate: r.year ? `${r.year}-01-01` : null,
  };
}

export const pubmedProvider: SearchProvider = {
  id: "pubmed",
  label: databaseById("pubmed")!.label,
  scholarly: true,
  timeRange: true,
  async search(query, opts = {}) {
    const records = await pubmedSearch(query, PER_PROVIDER, opts.signal, opts.page ?? 1);
    return records.map(pubmedToHit).filter((h): h is SearchHit => h !== undefined);
  },
};

/**
 * CORE's URL preference: DOI, then its own readable copy, then its landing
 * page -- `downloadUrl` is CORE's whole value here (an open-access full text
 * OpenAlex often only knows the existence of), so it is worth preferring over
 * a bare id when there is no DOI to identify the work by.
 */
export function coreToHit(r: CoreRecord): SearchHit | undefined {
  const url = r.doi
    ? `https://doi.org/${r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`
    : r.downloadUrl || (r.id ? `https://core.ac.uk/works/${r.id}` : undefined);
  if (!url || !r.title) return undefined;
  const authors = r.authors;
  const byline = authors.length
    ? `${authors.slice(0, 3).join(", ")}${authors.length > 3 ? " et al." : ""}. `
    : "";
  return {
    url,
    title: r.title,
    content: `${byline}${r.publisher ? `${r.publisher}. ` : ""}${r.abstract}`.trim(),
    engine: "core",
    publishedDate: r.year ? `${r.year}-01-01` : null,
  };
}

export const coreProvider: SearchProvider = {
  id: "core",
  label: databaseById("core")!.label,
  scholarly: true,
  timeRange: false,
  async search(query, opts = {}) {
    const records = await coreSearch(query, PER_PROVIDER, opts.signal, opts.page ?? 1);
    return records.map(coreToHit).filter((h): h is SearchHit => h !== undefined);
  },
};

/*
 * The providers this build ships.
 *
 * OpenAlex and arXiv are keyless public APIs. PubMed and CORE need a key the
 * user supplies (see keys.ts); they are registered here unconditionally --
 * `resolveProviders` below is what filters by whether a key actually exists,
 * so this Map stays "everything the build knows how to query" rather than
 * "everything queryable right now". There was briefly a registerProvider()
 * for a general-web extension point; an extension point with no extension is
 * just unused API, and adding a line to this list is the same amount of work.
 */
const registry = new Map<string, SearchProvider>([
  [openAlexProvider.id, openAlexProvider],
  [arxivProvider.id, arxivProvider],
  [pubmedProvider.id, pubmedProvider],
  [coreProvider.id, coreProvider],
]);



export function providers(): SearchProvider[] {
  return [...registry.values()];
}

/** Providers able to serve this category, scholarly or otherwise. */
export function providersFor(category: string | undefined): SearchProvider[] {
  const scholarly = isScholarlyCategory(category);
  return providers().filter((p) => p.scholarly === scholarly);
}

/**
 * Which of the chosen database ids can actually be searched right now, and
 * which had to be dropped for want of a key.
 *
 * Dropped rather than refused, and named rather than counted: a database the
 * user ticked and then lost the key for must say so, for the same reason
 * `search()` returns its failures instead of quietly halving the sweep. An
 * empty `chosen` means the keyless defaults, so a research.json or a plan
 * written before this feature existed behaves exactly as it always has.
 */
export async function resolveProviders(
  chosen: readonly string[],
): Promise<{ providers: SearchProvider[]; unavailable: string[] }> {
  const ids = chosen.length ? chosen : DEFAULT_DATABASES;
  const resolved: SearchProvider[] = [];
  const unavailable: string[] = [];
  for (const id of ids) {
    const info = DATABASES.find((d) => d.id === id);
    const provider = registry.get(id);
    if (!info || !provider) continue; // unknown id: ignored, not thrown on
    if (info.secret && !(await hasDatabaseKey(info.secret))) {
      unavailable.push(info.label);
      continue;
    }
    resolved.push(provider);
  }
  return { providers: resolved, unavailable };
}

/**
 * Whether a time filter can be honoured for this category.
 *
 * In v1 this was the difference between results and silence: SearXNG dropped
 * every engine lacking time-range support, so a `time_range` on a scholarly
 * query returned ZERO results with no error -- eight queries, eight empty
 * answers, and nothing to indicate why. Here an unsupported filter is simply
 * not sent, so the failure cannot recur, but the caller still wants to know
 * whether the user's choice will be applied.
 *
 * An empty selection reports true rather than false: nothing has been ruled
 * out yet, and answering false there would discard the user's filter before a
 * provider had even been chosen.
 */
export function supportsTimeRange(category: string | undefined): boolean {
  const chosen = providersFor(category);
  if (chosen.length === 0) return true;
  return chosen.some((p) => p.timeRange);
}

/**
 * Fan out to every provider for the category and merge.
 *
 * One provider failing does not fail the search -- arXiv rate-limits, OpenAlex
 * exhausts its daily credits -- but every provider failing does. Returning an
 * empty array there would be indistinguishable from "nothing matched", which
 * is the exact failure that made v1's scholarly searches look broken.
 */
/**
 * Query every provider for a category and merge what comes back.
 *
 * Returns the failures alongside the hits rather than discarding them. One
 * backend failing is not a failed search -- arXiv rate-limits hard and has
 * outages, OpenAlex meters its free tier -- but a quietly halved result set
 * reads as a thin literature rather than a thin search, and the person
 * reading it has no way to tell the difference. `academicLookup` has always
 * reported this; the agent's own search did not, so a Quick search during an
 * arXiv outage returned OpenAlex-only results and said nothing at all.
 */
export async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; failures: string[] }> {
  const chosen = opts.providers ?? providersFor(opts.categories);
  if (chosen.length === 0) {
    /* An explicit provider list -- even an empty one -- means the caller
       already resolved which of its chosen databases are usable (see
       `resolveProviders`) and has its own accounting for why none survived,
       e.g. "PubMed skipped — no API key is stored for it". Throwing a generic
       NoProviderError here would discard that specific reason: the caller's
       message never gets built because this function never returns. Only
       throw when nothing was ever chosen -- there is no configured backend
       for the category at all. */
    if (opts.providers) return { hits: [], failures: [] };
    throw new NoProviderError(
      isScholarlyCategory(opts.categories)
        ? "No scholarly search provider is available."
        : "No web search provider is configured. Scholarly search works without one; " +
          "general web search needs a backend set in Settings → Research.",
    );
  }

  const settled = await Promise.allSettled(chosen.map((p) => p.search(query, opts)));
  const hits: SearchHit[] = [];
  const failures: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") hits.push(...r.value);
    else failures.push(`${chosen[i]!.label}: ${reasonOf(r.reason)}`);
  });

  if (hits.length === 0 && failures.length === chosen.length) {
    throw new NoProviderError(`Every search provider failed — ${failures.join("; ")}`);
  }
  return { hits: dedupe(hits), failures };
}

/**
 * Why a provider failed, in words rather than in a stack.
 *
 * `AbortSignal.timeout` rejects with a bare `TimeoutError` whose message is
 * "The operation was aborted due to timeout", which tells a reader nothing
 * about which service was slow or what it means for their results.
 */
function reasonOf(reason: unknown): string {
  const err = reason as Error | undefined;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "did not respond in time";
  return err?.message ?? "failed";
}

/**
 * The hits alone, for callers that have nowhere to put a warning.
 *
 * Kept deliberately small and deliberately named: swallowing a partial failure
 * should be something a caller opts into on one visible line, not the default
 * every caller gets for free.
 */
export async function searchHits(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  return (await search(query, opts)).hits;
}
