/**
 * Stable citation numbers for a conversation.
 *
 * web_search used to number its results 1..n on every call, so "[1]" meant a
 * different page in each search of the same conversation. That is fine for a
 * model reading one result set and answering immediately, and useless the
 * moment a citation has to survive into the transcript as a link: the reader
 * clicking [1] has no way to know which search it came from.
 *
 * So numbers are assigned here, once per URL, and reused for the rest of the
 * session. A page found again in a later search keeps the number it already
 * had. That makes [n] unambiguous for the whole conversation, which is what
 * lets the GUI resolve every marker to a real source.
 *
 * Scope is the pi process, which is one session; session_start clears it.
 */

import { canonicalUrl } from "./html.ts";
import type { SearchHit } from "./searxng.ts";

export interface RegisteredSource {
  n: number;
  url: string;
  title: string;
  engine?: string;
  publishedDate?: string;
  /** The search snippet, shown in the GUI's hover card. */
  snippet?: string;
}

const byUrl = new Map<string, RegisteredSource>();
let next = 1;

/** Clears the table. Called on session_start, and by tests. */
export function resetRegistry(): void {
  byUrl.clear();
  next = 1;
}

/**
 * Assign numbers to these hits, reusing any this session has already seen.
 *
 * Returned in the order given, so the caller can format them as a result list.
 */
export function registerHits(hits: SearchHit[]): RegisteredSource[] {
  const out: RegisteredSource[] = [];
  for (const hit of hits) {
    const url = hit.url ?? "";
    if (!url) continue;
    const key = canonicalUrl(url) || url;
    const existing = byUrl.get(key);
    if (existing) {
      out.push(existing);
      continue;
    }
    const source: RegisteredSource = {
      n: next++,
      url,
      title: hit.title || url,
      ...(hit.engine ? { engine: hit.engine } : {}),
      ...(hit.publishedDate ? { publishedDate: String(hit.publishedDate).slice(0, 10) } : {}),
      ...(hit.content?.trim() ? { snippet: hit.content.trim().slice(0, 400) } : {}),
    };
    byUrl.set(key, source);
    out.push(source);
  }
  return out;
}

/** Everything numbered so far, lowest first. */
export function registeredSources(): RegisteredSource[] {
  return [...byUrl.values()].sort((a, b) => a.n - b.n);
}

/** Format a numbered result list using the assigned numbers, not 1..n. */
export function formatRegistered(sources: RegisteredSource[]): string {
  return sources
    .map((s) => {
      const when = s.publishedDate ? ` (${s.publishedDate})` : "";
      const via = s.engine ? ` [${s.engine}]` : "";
      return `[${s.n}] ${s.title}${when}${via}\n    ${s.url}\n    ${s.snippet ?? ""}`;
    })
    .join("\n\n");
}
