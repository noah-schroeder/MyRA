/**
 * arXiv's Atom API. Free, keyless, and asks for one request every 3 seconds.
 */

import { FETCH_TIMEOUT_MS } from "./config.ts";
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
      search_query: `all:"${query.replace(/"/g, "")}"`,
      start: String(Math.max(0, page - 1) * max),
      max_results: String(max),
      sortBy: "relevance",
    });
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`arXiv returned ${res.status} ${res.statusText}`);
  return parseArxivEntries(await res.text());
}
