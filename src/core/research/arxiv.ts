/**
 * arXiv's Atom API. Free, keyless, and asks for one request every 3 seconds.
 */

import { SEARCH_TIMEOUT_MS } from "./config.ts";
import { decodeEntities } from "./html.ts";

export interface Preprint {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  pdf: string;
}

/** arXiv asks for one request every 3 seconds. Honour it process-wide. */
let nextAllowedAt = 0;
async function throttle(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAllowedAt = Date.now() + 3_000;
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]!).replace(/\s+/g, " ").trim() : "";
}

/** Parse arXiv's Atom feed. Split out from the fetch so it can be tested. */
export function parseArxivEntries(xml: string): Preprint[] {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []).map((entry) => {
    // arXiv writes href BEFORE title, so do not assume an attribute order:
    // match the whole <link> element that is the pdf, then pull href out of it.
    const pdfLink = entry.match(/<link\b[^>]*\btitle="pdf"[^>]*\/?>/i);
    const pdf = pdfLink ? pdfLink[0].match(/href="([^"]+)"/i) : null;
    return {
      id: tag(entry, "id"),
      title: tag(entry, "title"),
      summary: tag(entry, "summary"),
      authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((m) =>
        decodeEntities(m[1]!).trim(),
      ),
      published: tag(entry, "published").slice(0, 10),
      pdf: pdf ? pdf[1]! : "",
    };
  });
}

/*
 * Words that constrain nothing but can still exclude something.
 *
 * The terms below are ANDed, so every one of them has to appear somewhere in a
 * paper. A stopword that arXiv's index happens not to hold for a given record
 * then removes an otherwise perfect match, which is a strange way to lose a
 * paper.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "into", "is", "it", "of", "on", "or", "the", "to", "via", "with", "what",
  "which", "that", "this", "using", "use", "between", "their", "its",
]);

/** More than this and the ANDs start excluding papers rather than focusing. */
const MAX_TERMS = 12;

/**
 * Turn a natural-language query into something arXiv's parser answers well.
 *
 * This was `all:"the whole query"`, which is an **exact phrase search**, and it
 * quietly cost most of arXiv's usefulness. Measured against the live API:
 *
 *   all:"transformer attention mechanism"            ->        74 results
 *   all:transformer attention mechanism              ->   484,889 results
 *   all:transformer AND all:attention AND all:...    ->     6,587 results
 *
 *   all:"qualitative coding inter-rater reliability" ->         0 results
 *
 * Zero. A four-word question -- which is what an academic query looks like --
 * returned nothing at all, so arXiv contributed nothing to a merged search and
 * the results looked like OpenAlex on its own. The bare form is too broad to
 * be meaningful; ANDing the terms keeps the same top hits as the bare form
 * while cutting the field by two orders of magnitude.
 */
export function arxivQuery(query: string): string {
  const terms = query
    .toLowerCase()
    // arXiv's parser has its own syntax; these characters break the query.
    .replace(/["'()\[\]{}:^~?*\\]/g, " ")
    .split(/[\s,;/]+/)
    .map((t) => t.replace(/^[-+.]+|[-+.]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, MAX_TERMS);

  // Nothing survived the filter -- a query of pure stopwords, or punctuation.
  if (terms.length === 0) return `all:${query.trim().replace(/["\\]/g, "") || "*"}`;
  return terms.map((t) => `all:${t}`).join(" AND ");
}

/** `page` is 1-based; arXiv pages by result offset rather than page number. */
export async function arxivSearch(
  query: string,
  max: number,
  signal?: AbortSignal,
  page = 1,
): Promise<Preprint[]> {
  await throttle();
  const url =
    "http://export.arxiv.org/api/query?" +
    new URLSearchParams({
      search_query: arxivQuery(query),
      start: String(Math.max(0, page - 1) * max),
      max_results: String(max),
      sortBy: "relevance",
    });
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`arXiv returned ${res.status} ${res.statusText}`);
  return parseArxivEntries(await res.text());
}
