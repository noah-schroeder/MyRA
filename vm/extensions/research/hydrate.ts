/**
 * OpenAlex hydration and full-text rescue — only ever reached from a scholarly
 * category, so a general web sweep makes none of these calls.
 *
 * SearXNG flattens every result to {url, title, content, engine}. For a web
 * page that is all there is. For a paper it throws away everything a citation
 * needs: authors, year, venue, DOI, citation count, and the open-access link
 * that turns an abstract into full text.
 *
 * Recovering full text runs in three stages, cheapest first, and each stage
 * only sees the papers the previous one could not resolve:
 *
 *   1. OpenAlex's own OA link          — free, part of the identify request
 *   2. Semantic Scholar, batched       — ONE request for every remaining paper
 *   3. An open sibling record          — one request per paper, so it runs last
 *
 * Unpaywall is deliberately absent: OpenAlex ingests the Unpaywall dataset, and
 * over 124 paywalled works the two never once disagreed. Asking it would double
 * the requests to re-read the same database.
 *
 * Failure at any stage is never fatal. A paper nothing can resolve is still a
 * source worth reading -- it is simply cited from its abstract and landing page.
 */

import { FETCH_CONCURRENCY } from "./config.ts";
import { pooled } from "./fetch.ts";
import {
  abstractFromInverted, authorsOf, oaUrl, openAlexByDoi, openAlexByTitle, openAlexOpenSibling,
  venueOf, type Work,
} from "./openalex.ts";
import { isRepositoryCopy, s2OpenAccessPdfs } from "./semanticscholar.ts";
import type { SearchHit } from "./searxng.ts";

/** A DOI anywhere in a URL: doi.org links, and publisher paths that embed one. */
const DOI_IN_URL = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

export function doiFromUrl(url: string): string | undefined {
  const m = DOI_IN_URL.exec(decodeURIComponent(url));
  if (!m) return undefined;
  // URLs carry query strings, fragments and sentence punctuation that are not
  // part of the identifier.
  const doi = m[1]!.split(/[?#]/)[0]!.replace(/[.,;)\]]+$/, "").replace(/\/(full|pdf|abstract)$/i, "");
  return doi.length > 8 ? doi.toLowerCase() : undefined;
}

/** arXiv ids map onto a DOI, which is the cheaper OpenAlex lookup. */
export function arxivDoiFromUrl(url: string): string | undefined {
  const m = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/i.exec(url);
  return m ? `10.48550/arxiv.${m[1]}` : undefined;
}

export interface Hydrated {
  /** Everything a bibliography entry needs, when OpenAlex knew the work. */
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  citedBy?: number;
  references?: number;
  /**
   * Reconstructed from OpenAlex's inverted index. Screening judges papers on
   * their abstracts, and SearXNG's snippet is a truncated fragment of the page
   * rather than the abstract, so this is what makes screening worth doing.
   */
  abstract?: string;
  /** Full text, when it is openly available. Preferred over the search hit URL. */
  pdfUrl?: string;
  /** Which stage produced pdfUrl, for the run's audit trail. */
  fullTextFrom?: "openalex" | "semantic-scholar" | "open-version";
  /**
   * Set when pdfUrl is an open copy rather than the version of record. The
   * bibliography must say so: reading a preprint and citing it as the published
   * paper is exactly the kind of quiet inaccuracy this pipeline exists to
   * prevent.
   */
  note?: string;
  matchedBy: "doi" | "arxiv" | "title" | "none";
}

const NOT_A_PAPER: Hydrated = { matchedBy: "none" };
const VERSION_CAVEAT = "full text read from an open version of this work, not the version of record";

function fromWork(work: Work, matchedBy: Hydrated["matchedBy"]): Hydrated {
  const authors = authorsOf(work);
  const pdf = oaUrl(work);
  const abstract = abstractFromInverted(work.abstract_inverted_index);
  return {
    ...(abstract ? { abstract } : {}),
    ...(authors.length ? { authors } : {}),
    ...(work.publication_year ? { year: work.publication_year } : {}),
    ...(work.primary_location ? { venue: venueOf(work) } : {}),
    ...(work.doi ? { doi: work.doi } : {}),
    ...(typeof work.cited_by_count === "number" ? { citedBy: work.cited_by_count } : {}),
    ...(work.referenced_works ? { references: work.referenced_works.length } : {}),
    ...(pdf ? { pdfUrl: pdf, fullTextFrom: "openalex" as const } : {}),
    matchedBy,
  };
}

/**
 * Stage 0: identify one search hit as a known work.
 *
 * DOI first because it is exact; title only as a fallback, and openAlexByTitle
 * confirms the title really matches before returning -- attaching one paper's
 * citation count to another paper would be worse than no metadata at all.
 */
export async function identifyHit(
  hit: SearchHit,
  signal?: AbortSignal,
): Promise<{ hydrated: Hydrated; work?: Work }> {
  const doi = doiFromUrl(hit.url) ?? arxivDoiFromUrl(hit.url);
  if (doi) {
    const work = await openAlexByDoi(doi, signal).catch(() => undefined);
    if (work) {
      return { hydrated: fromWork(work, doi.startsWith("10.48550") ? "arxiv" : "doi"), work };
    }
  }
  if (hit.title) {
    const work = await openAlexByTitle(hit.title, signal).catch(() => undefined);
    if (work) return { hydrated: fromWork(work, "title"), work };
  }
  return { hydrated: NOT_A_PAPER };
}

/** Identify and, where needed, hunt down the full text. Preserves input order. */
export async function hydrateHits(
  hits: SearchHit[],
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Hydrated[]> {
  let done = 0;
  const identified = await pooled(hits, FETCH_CONCURRENCY, async (hit) => {
    const result = await identifyHit(hit, signal).catch(
      (): { hydrated: Hydrated; work?: Work } => ({ hydrated: NOT_A_PAPER }),
    );
    onProgress?.(++done, hits.length);
    return result;
  });
  const out = identified.map((r) => r.hydrated);

  /* Stage 2: one batched request covering every paper still without full text. */
  const stillClosed = out
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => !h.pdfUrl && h.doi)
    .map(({ h, i }) => ({ i, doi: h.doi!.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() }));

  if (stillClosed.length) {
    const pdfs = await s2OpenAccessPdfs(stillClosed.map((s) => s.doi), signal);
    for (const { i, doi } of stillClosed) {
      const hit = pdfs.get(doi);
      if (!hit) continue;
      out[i] = {
        ...out[i]!,
        pdfUrl: hit.url,
        fullTextFrom: "semantic-scholar",
        // Only a repository copy carries a version caveat; a publisher-hosted
        // PDF (gold, hybrid, bronze) IS the version of record.
        ...(isRepositoryCopy(hit.status) ? { note: VERSION_CAVEAT } : {}),
      };
    }
  }

  /* Stage 3: per-paper, so it runs last and on the smallest possible set. */
  const remaining = out
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !h.pdfUrl && h.matchedBy !== "none" && identified[i]?.work?.title);

  if (remaining.length) {
    await pooled(remaining, FETCH_CONCURRENCY, async ({ h, i }) => {
      const work = identified[i]!.work!;
      const sibling = await openAlexOpenSibling(work.title!, work.id, signal).catch(() => undefined);
      const pdf = sibling ? oaUrl(sibling) : undefined;
      if (!pdf) return;
      const year =
        sibling?.publication_year && sibling.publication_year !== h.year
          ? ` (${sibling.publication_year})`
          : "";
      out[i] = {
        ...h,
        pdfUrl: pdf,
        fullTextFrom: "open-version",
        note: `full text read from an open version of this work${year}, not the version of record`,
      };
    });
  }

  return out;
}
