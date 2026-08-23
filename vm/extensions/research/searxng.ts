/**
 * SearXNG: one local instance, every engine the user configured.
 *
 * Runs inside the VM, never on the host. Search queries reaching the upstream
 * engines is the one network egress this project accepts by design.
 */

import { FETCH_TIMEOUT_MS, SEARXNG_URL } from "./config.ts";
import { canonicalUrl } from "./html.ts";

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
}

export interface SearxngOptions {
  categories?: string;
  engines?: string;
  timeRange?: string;
  page?: number;
  signal?: AbortSignal;
}

export async function searxng(query: string, opts: SearxngOptions = {}): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, format: "json", language: "en" });
  if (opts.categories) params.set("categories", opts.categories);
  if (opts.engines) params.set("engines", opts.engines);
  if (opts.timeRange) params.set("time_range", opts.timeRange);
  if (opts.page && opts.page > 1) params.set("pageno", String(opts.page));

  let res: Response;
  try {
    res = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    // By far the most likely cause, and the least obvious from the raw error.
    throw new Error(
      `Could not reach SearXNG at ${SEARXNG_URL} (${(err as Error).message}). ` +
        `Start it with: ./scripts/install-searxng.sh`,
    );
  }
  if (res.status === 403) {
    throw new Error(
      "SearXNG returned 403 for a JSON request. Its settings.yml needs " +
        '`search: formats: [html, json]` — the container is running HTML-only.',
    );
  }
  if (!res.ok) throw new Error(`SearXNG returned ${res.status} ${res.statusText}`);

  return ((await res.json()) as { results?: SearchHit[] }).results ?? [];
}

/** Collapse duplicates across engines, keeping first-seen order. */
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
