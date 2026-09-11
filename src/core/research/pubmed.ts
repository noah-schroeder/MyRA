/**
 * NCBI's E-utilities, for PubMed: biomedicine, nursing, public health and
 * clinical trials, which OpenAlex and arXiv do not specialise in.
 *
 * Two requests per search, not one. ESearch returns only PMIDs; ESummary
 * carries no abstract at all, and an abstract is not optional here --
 * `screen.ts` judges every candidate on its abstract, so a record without one
 * is scored blind and then dropped for having nothing to extract from. EFetch
 * with `rettype=abstract` is the call that actually carries one, and it comes
 * back as XML: `retmode=json` exists for ESearch and ESummary but NOT for
 * EFetch on PubMed, so this file has the same hand-rolled-regex parse arXiv's
 * Atom feed already needed, for the same reason -- one XML document, parsed
 * once, with no XML dependency added to the project for it.
 */

import { FETCH_TIMEOUT_MS, OPENALEX_MAILTO, SEARCH_TIMEOUT_MS } from "./config.ts";
import { decodeEntities } from "./html.ts";
import { databaseKey } from "./keys.ts";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export interface PubmedRecord {
  pmid: string;
  title: string;
  abstract: string;
  authors: string[];
  venue: string;
  year?: number;
  doi?: string;
  pmcid?: string;
}

/*
 * NCBI's documented ceiling with a key is 10 requests/second; without one it
 * is 3. This provider is offered only once a key is present (see
 * databases.ts), so 4/second leaves real headroom under the higher ceiling
 * rather than aiming at it -- a deep run fires two requests per query across
 * several queries and pages, and the ceiling is a limit, not a target.
 */
let nextAllowedAt = 0;
async function throttle(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAllowedAt = Date.now() + 250;
}

async function commonParams(): Promise<URLSearchParams> {
  const q = new URLSearchParams({ db: "pubmed", tool: "karen" });
  if (OPENALEX_MAILTO) q.set("email", OPENALEX_MAILTO);
  const key = await databaseKey("ncbiKey");
  if (key) q.set("api_key", key);
  return q;
}

/** One `<tag>...</tag>` or `<tag attr="...">...</tag>`, first match only. */
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

/**
 * Parse PubMed's `efetch` XML into records. Split out from the fetch so it can
 * be tested against a fixture with no network.
 */
export function parsePubmedArticles(xml: string): PubmedRecord[] {
  return (xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) ?? []).map((entry) => {
    const pmid = tag(entry, "PMID");
    const title = tag(entry, "ArticleTitle");

    // A structured abstract splits into several <AbstractText> sections
    // (Background, Methods, Results, Conclusions); joining all of them is
    // the difference between a usable summary and the Background paragraph
    // alone, which is what taking only the first would leave the screener.
    const abstract = [...entry.matchAll(/<AbstractText\b[^>]*>([\s\S]*?)<\/AbstractText>/gi)]
      .map((m) => decodeEntities(m[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");

    // Boundary-guarded like tag() above: `[^>]*` alone matches `<AuthorList>`
    // as if it were an opening `<Author>` tag, since "List>" satisfies "any
    // non->" characters just as well as a real attribute list would.
    const authors = [...entry.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/gi)]
      .map((m) => {
        const last = tag(m[1]!, "LastName");
        const fore = tag(m[1]!, "ForeName");
        const collective = tag(m[1]!, "CollectiveName");
        return [fore, last].filter(Boolean).join(" ") || collective;
      })
      .filter(Boolean);

    const journalBlock = entry.match(/<Journal>[\s\S]*?<\/Journal>/)?.[0] ?? "";
    const venue = tag(journalBlock, "Title");
    const yearText = tag(journalBlock, "Year") || tag(entry, "Year");
    const year = yearText ? Number(yearText.slice(0, 4)) : undefined;

    const idList = entry.match(/<ArticleIdList>[\s\S]*?<\/ArticleIdList>/)?.[0] ?? "";
    const doiMatch = idList.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/i);
    const pmcMatch = idList.match(/<ArticleId IdType="pmc">([\s\S]*?)<\/ArticleId>/i);

    return {
      pmid,
      title,
      abstract,
      authors,
      venue,
      ...(year && Number.isFinite(year) ? { year } : {}),
      ...(doiMatch ? { doi: decodeEntities(doiMatch[1]!).trim() } : {}),
      ...(pmcMatch ? { pmcid: decodeEntities(pmcMatch[1]!).trim() } : {}),
    };
  }).filter((r) => r.pmid && r.title);
}

/** `page` is 1-based, matching the other providers. */
export async function pubmedSearch(
  query: string,
  perPage: number,
  signal?: AbortSignal,
  page = 1,
): Promise<PubmedRecord[]> {
  await throttle();
  const esearch = await commonParams();
  esearch.set("term", query);
  esearch.set("retmax", String(perPage));
  esearch.set("retstart", String(Math.max(0, page - 1) * perPage));
  esearch.set("retmode", "json");
  esearch.set("sort", "relevance");

  const searchRes = await fetch(`${BASE}/esearch.fcgi?${esearch}`, {
    signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (searchRes.status === 429) {
    throw new Error("PubMed's rate limit was hit. Wait a moment before searching again.");
  }
  if (!searchRes.ok) throw new Error(`PubMed returned ${searchRes.status} ${searchRes.statusText}`);
  const ids = ((await searchRes.json()) as { esearchresult?: { idlist?: string[] } }).esearchresult
    ?.idlist ?? [];
  if (ids.length === 0) return [];

  await throttle();
  const efetch = await commonParams();
  efetch.set("id", ids.join(","));
  efetch.set("retmode", "xml");
  efetch.set("rettype", "abstract");

  const fetchRes = await fetch(`${BASE}/efetch.fcgi?${efetch}`, {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!fetchRes.ok) throw new Error(`PubMed returned ${fetchRes.status} ${fetchRes.statusText}`);
  return parsePubmedArticles(await fetchRes.text());
}
