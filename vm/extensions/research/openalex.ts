/**
 * OpenAlex: free, keyless, and the source of the metadata screening needs.
 *
 * Its role here is HYDRATION rather than discovery. SearXNG finds candidates
 * across the user's configured engines, but only ~65% arrive with a usable
 * abstract, and none arrive with citation counts or open-access links. OpenAlex
 * fills exactly that gap.
 */

import { FETCH_TIMEOUT_MS, OPENALEX_MAILTO } from "./config.ts";

const SELECT = [
  "id", "doi", "title", "publication_year", "cited_by_count", "authorships",
  "primary_location", "open_access", "abstract_inverted_index", "referenced_works",
].join(",");

export interface Work {
  id?: string;
  doi?: string;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: {
    source?: { display_name?: string } | null;
    /** Present when OpenAlex has not matched the venue to a source record. */
    raw_source_name?: string;
    pdf_url?: string;
  };
  open_access?: { oa_url?: string; is_oa?: boolean };
  abstract_inverted_index?: Record<string, number[]>;
  referenced_works?: string[];
}

/**
 * OpenAlex ships abstracts as a position index, not prose:
 *   {"Deep": [0], "learning": [1,7], ...}
 * Anything that shows the raw structure to a model wastes its context.
 */
export function abstractFromInverted(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  return words.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The venue, from whichever field OpenAlex actually populated.
 *
 * `source` is null for a great many conference papers even though
 * `raw_source_name` carries the proceedings title, so reading only the former
 * reports "venue unknown" for work that plainly has one.
 */
export function venueOf(w: Work): string {
  return (
    w.primary_location?.source?.display_name ??
    w.primary_location?.raw_source_name ??
    "(venue unknown)"
  );
}

export function authorsOf(w: Work): string[] {
  return (w.authorships ?? []).map((a) => a.author?.display_name).filter((n): n is string => !!n);
}

/** The best available open-access full text link, if any. */
export function oaUrl(w: Work): string | undefined {
  return w.open_access?.oa_url ?? w.primary_location?.pdf_url;
}

/* ------------------------------------------------------------------ *
 * Credit budget                                                       *
 * ------------------------------------------------------------------ *
 *
 * OpenAlex meters its free tier: 1000 credits ($0.10) a day, reset at
 * midnight UTC. The prices are wildly uneven, and that shapes this whole file:
 *
 *   GET /works/doi:10.x/y   fetch one work by identifier ....  0 credits
 *   GET /works?filter=doi:  the same thing, as a query ......  1 credit
 *   GET /works?search=...   a real search ................... 10 credits
 *
 * So identifying a paper we already have a DOI for is free and unmetered,
 * while a title search costs a tenth of the daily allowance. Everything below
 * prefers the free form, and the metered calls check the budget first rather
 * than discovering it is gone by getting a 429 mid-run.
 */

/** Cost of one `search=` request, and so the minimum worth having in hand. */
const SEARCH_COST = 10;
let creditsLeft: number | undefined;

/** Credits remaining today, as last reported. Undefined until a call is made. */
export function openAlexCredits(): number | undefined {
  return creditsLeft;
}

/** Tests only. */
export function resetOpenAlexCredits(value?: number): void {
  creditsLeft = value;
}

/** Every response carries the running balance, so read it rather than guess. */
function recordBudget(res: Response): void {
  const raw = res.headers.get("x-ratelimit-remaining");
  if (raw === null) return;
  const n = Number(raw);
  if (Number.isFinite(n)) creditsLeft = n;
}

/** Can we afford a metered search? Unknown budget counts as yes -- find out by trying. */
function canAffordSearch(): boolean {
  return creditsLeft === undefined || creditsLeft >= SEARCH_COST;
}

function url(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ ...params, select: SELECT });
  if (OPENALEX_MAILTO) q.set("mailto", OPENALEX_MAILTO);
  return `https://api.openalex.org/${path}?${q}`;
}

export async function openAlexSearch(
  query: string,
  perPage: number,
  signal?: AbortSignal,
): Promise<Work[]> {
  const res = await fetch(url("works", { search: query, per_page: String(perPage) }), {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  recordBudget(res);
  if (res.status === 429) {
    throw new Error(
      "OpenAlex daily free credits are exhausted (they reset at midnight UTC). " +
        "Searching costs 10 credits of the 1000 free per day; identifying a paper by DOI is free.",
    );
  }
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status} ${res.statusText}`);
  return ((await res.json()) as { results?: Work[] }).results ?? [];
}

/**
 * An openly available version of a work that is itself paywalled.
 *
 * Publishers and preprint servers register SEPARATE records for the same
 * paper: the version of record sits behind a paywall while the author's arXiv
 * or conference copy is open, under a different DOI. Unpaywall does not link
 * these -- it answers per DOI -- so OpenAlex marks the published record closed
 * and stops there, even though a readable copy is one query away.
 *
 * Requires an exact normalised title match: a near-match here would attach a
 * different paper's full text to this citation, which is far worse than having
 * no full text at all.
 */
export async function openAlexOpenSibling(
  title: string,
  excludeId: string | undefined,
  signal?: AbortSignal,
): Promise<Work | undefined> {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 240);
  if (clean.length < 12 || !canAffordSearch()) return undefined;
  const res = await fetch(
    url("works", { search: clean, per_page: "3", filter: "open_access.is_oa:true" }),
    { signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  recordBudget(res);
  if (!res.ok) return undefined;
  const strict = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const wanted = strict(clean);
  for (const cand of ((await res.json()) as { results?: Work[] }).results ?? []) {
    if (!cand.title || cand.id === excludeId) continue;
    if (strict(cand.title) === wanted && oaUrl(cand)) return cand;
  }
  return undefined;
}

export function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim().toLowerCase();
}

/**
 * Hydrate a bare search hit into a full record, by DOI.
 *
 * Uses the single-entity form `/works/doi:10.x/y`, which OpenAlex serves for
 * ZERO credits -- the `?filter=doi:` query returns the identical record and
 * costs one. At the scale this pipeline runs, that difference is the whole
 * difference between metered and unmetered.
 */
export async function openAlexByDoi(doi: string, signal?: AbortSignal): Promise<Work | undefined> {
  const q = new URLSearchParams({ select: SELECT });
  if (OPENALEX_MAILTO) q.set("mailto", OPENALEX_MAILTO);
  const res = await fetch(`https://api.openalex.org/works/doi:${normalizeDoi(doi)}?${q}`, {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  recordBudget(res);
  if (!res.ok) return undefined;
  return (await res.json()) as Work;
}

/** Hydrate by title, for the many hits that carry no DOI. */
export async function openAlexByTitle(title: string, signal?: AbortSignal): Promise<Work | undefined> {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 240);
  if (clean.length < 12 || !canAffordSearch()) return undefined;
  const res = await fetch(url("works", { search: clean, per_page: "1" }), {
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  recordBudget(res);
  if (!res.ok) return undefined;
  const first = ((await res.json()) as { results?: Work[] }).results?.[0];
  if (!first?.title) return undefined;
  // Search matches loosely, so confirm the title really is the same work before
  // attaching its citation count and abstract to somebody else's paper.
  return titlesMatch(first.title, clean) ? first : undefined;
}

/** Loose title equality: punctuation and case vary between databases. */
export function titlesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const [x, y] = [norm(a), norm(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  // One database routinely truncates or appends a subtitle.
  return x.startsWith(y.slice(0, 60)) || y.startsWith(x.slice(0, 60));
}

export function formatWork(w: Work, n: number, includeAbstract: boolean): string {
  const authors = authorsOf(w);
  const shown = authors.slice(0, 4).join(", ") + (authors.length > 4 ? ", et al." : "");
  const lines = [
    `[${n}] ${w.title ?? "(untitled)"}`,
    `    ${shown || "(authors unknown)"} — ${w.publication_year ?? "n.d."}`,
    `    ${venueOf(w)}  ·  cited by ${w.cited_by_count ?? 0}` +
      `  ·  ${w.referenced_works?.length ?? 0} references`,
  ];
  if (w.doi) lines.push(`    doi: ${w.doi}`);
  const pdf = oaUrl(w);
  lines.push(pdf ? `    open access pdf: ${pdf}` : `    open access: none found`);
  if (includeAbstract) {
    const abstract = abstractFromInverted(w.abstract_inverted_index);
    if (abstract) lines.push(`    abstract: ${abstract}`);
  }
  return lines.join("\n");
}
