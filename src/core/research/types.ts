/**
 * The shape every search backend answers in, and the provider seam.
 *
 * v1 had exactly one backend -- a SearXNG container on loopback inside the VM --
 * so this shape was defined by SearXNG's JSON and the fetch lived beside it.
 * v2 has no container to require, so the shape stays and the fetch becomes an
 * interface: scholarly queries go straight to OpenAlex and arXiv, and
 * general web search is an optional provider that is absent until configured.
 */

import { canonicalUrl } from "./html.ts";
import type { Work } from "./openalex.ts";

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  /** Which backend produced this hit. Shown in citations so a source is traceable. */
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
  /**
   * The provider's own record, when it has one richer than this hit.
   *
   * A SearchHit is flat because that is all a general web backend can offer,
   * and for a long time flat was all there was: v1 routed every query through
   * SearXNG, which discards everything but url/title/snippet. So the pipeline
   * identified each hit all over again by DOI, to recover metadata the search
   * had already been given and thrown away.
   *
   * Calling the scholarly APIs directly, that loss is now self-inflicted, so
   * the record rides along. Providers that genuinely have nothing more to give
   * simply leave it undefined and hydration works exactly as before.
   */
  work?: Work;
}

export interface SearchOptions {
  /** Free-form backend hint, e.g. "science" or "general". */
  categories?: string;
  engines?: string;
  timeRange?: string;
  page?: number;
  signal?: AbortSignal;
  /**
   * Query these backends instead of the registered ones.
   *
   * The registry is module-level, which is right -- there is one set of
   * backends and it is known at compile time -- but it leaves the merge and
   * failure-reporting logic untestable without hitting the network, and that
   * logic is precisely the part that was wrong. This is the seam.
   */
  providers?: SearchProvider[];
}

export interface SearchProvider {
  /** Stable id, surfaced in settings and in the citation trail. */
  readonly id: string;
  /** Human-readable, for the settings page. */
  readonly label: string;
  /** True when this provider indexes scholarly literature. */
  readonly scholarly: boolean;
  /** True when the backend can filter by publication date. */
  readonly timeRange: boolean;
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

/**
 * Raised when a search is attempted with no provider able to serve it.
 *
 * Distinct from an empty result on purpose: "nothing matched" and "there is no
 * web search configured" look identical in a report otherwise, and in v1 an
 * unreachable backend silently produced eight empty answers and no error.
 */
export class NoProviderError extends Error {
  override readonly name = "NoProviderError";
}

/** Collapse duplicates across providers, keeping first-seen order. */
export function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (!h?.url) continue;
    const key = canonicalUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function formatHits(hits: SearchHit[], numbers?: number[]): string {
  /* The numbers come from the ledger, not from this list's own order. They
     used to be `i + 1`, which restarted at one on every search and made the
     second search silently reassign the first one's markers. */
  return hits
    .map((h, i) => {
      const when = h.publishedDate ? ` (${String(h.publishedDate).slice(0, 10)})` : "";
      const via = h.engine ? ` [${h.engine}]` : "";
      const n = numbers?.[i] ?? i + 1;
      return `[${n}] ${h.title}${when}${via}\n    ${h.url}\n    ${(h.content ?? "").trim()}`;
    })
    .join("\n\n");
}
