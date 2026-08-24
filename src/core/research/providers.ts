/**
 * Where search results come from, now that there is no container.
 *
 * v1 routed every query -- scholarly and general alike -- through a SearXNG
 * instance the user had to install and run. That was the single heaviest
 * prerequisite in the project, and for academic work it was also the weakest
 * link: SearXNG flattens every result to {url,title,content,engine}, throwing
 * away the citation graph and the OA PDF links that deep research runs on.
 *
 * So scholarly search now goes straight to the APIs, which are keyless, need no
 * container, and return the structure intact. General web search becomes an
 * optional provider that is simply absent until the user configures one.
 */

import { arxivSearch } from "./arxiv.ts";
import {
  abstractFromInverted, authorsOf, oaUrl, openAlexSearch, venueOf, type Work,
} from "./openalex.ts";
import {
  NoProviderError,
  dedupe,
  type SearchHit,
  type SearchOptions,
  type SearchProvider,
} from "./types.ts";

const PER_PROVIDER = 10;

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
function workToHit(w: Work): SearchHit | undefined {
  const url =
    (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//, "")}` : undefined) ??
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
  label: "OpenAlex",
  scholarly: true,
  timeRange: true,
  async search(query, opts = {}) {
    const works = await openAlexSearch(query, PER_PROVIDER, opts.signal);
    return works.map(workToHit).filter((h): h is SearchHit => h !== undefined);
  },
};

export const arxivProvider: SearchProvider = {
  id: "arxiv",
  label: "arXiv",
  scholarly: true,
  // The Atom API sorts by date but does not filter by it.
  timeRange: false,
  async search(query, opts = {}) {
    const papers = await arxivSearch(query, PER_PROVIDER, opts.signal);
    return papers.map((p) => ({
      url: p.pdf || p.id,
      title: p.title,
      content: `${p.authors.slice(0, 3).join(", ")}. ${p.summary}`.trim(),
      engine: "arxiv",
      publishedDate: p.published || null,
    }));
  },
};

const registry = new Map<string, SearchProvider>([
  [openAlexProvider.id, openAlexProvider],
  [arxivProvider.id, arxivProvider],
]);

/**
 * Adds a provider, or replaces one by id.
 *
 * This is how a general-web backend arrives: the settings page constructs one
 * from whatever the user configured and registers it. Nothing is registered by
 * default, so an unconfigured install simply has no web search rather than a
 * broken one.
 */
export function registerProvider(provider: SearchProvider): void {
  registry.set(provider.id, provider);
}

export function unregisterProvider(id: string): void {
  registry.delete(id);
}

export function providers(): SearchProvider[] {
  return [...registry.values()];
}

/** Providers able to serve this category, scholarly or otherwise. */
export function providersFor(category: string | undefined): SearchProvider[] {
  const scholarly = isScholarlyCategory(category);
  return providers().filter((p) => p.scholarly === scholarly);
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
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const chosen = providersFor(opts.categories);
  if (chosen.length === 0) {
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
    else failures.push(`${chosen[i]!.id}: ${(r.reason as Error)?.message ?? "failed"}`);
  });

  if (hits.length === 0 && failures.length === chosen.length) {
    throw new NoProviderError(`Every search provider failed — ${failures.join("; ")}`);
  }
  return dedupe(hits);
}
