/**
 * The shape every search backend answers in, and the provider seam.
 *
 * v1 had exactly one backend -- a SearXNG container on loopback inside the VM --
 * so this shape was defined by SearXNG's JSON and the fetch lived beside it.
 * v2 has no container to require, so the shape stays and the fetch becomes an
 * interface: scholarly queries go straight to OpenAlex/arXiv/Crossref/S2, and
 * general web search is an optional provider that is absent until configured.
 */

import { canonicalUrl } from "./html.ts";

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  /** Which backend produced this hit. Shown in citations so a source is traceable. */
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
}

export interface SearchOptions {
  /** Free-form backend hint, e.g. "science" or "general". */
  categories?: string;
  engines?: string;
  timeRange?: string;
  page?: number;
  signal?: AbortSignal;
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

export function formatHits(hits: SearchHit[], offset = 0): string {
  return hits
    .map((h, i) => {
      const when = h.publishedDate ? ` (${String(h.publishedDate).slice(0, 10)})` : "";
      const via = h.engine ? ` [${h.engine}]` : "";
      return `[${offset + i + 1}] ${h.title}${when}${via}\n    ${h.url}\n    ${(h.content ?? "").trim()}`;
    })
    .join("\n\n");
}
