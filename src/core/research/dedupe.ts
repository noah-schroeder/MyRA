/**
 * Collapsing the same paper found twice.
 *
 * Discovery deduplicates by canonical URL, which is the only thing a flat
 * search hit offers. That is not enough here, and with the providers this build
 * ships it fails on essentially every run:
 *
 *   - arXiv returns `arxiv.org/pdf/2101.00001`, OpenAlex returns
 *     `doi.org/10.48550/arxiv.2101.00001` — the same preprint, two URLs.
 *   - A preprint and its published version are separate records with different
 *     DOIs, and both routinely surface for the same query.
 *
 * Left alone, one paper becomes two candidates, two sources, and two numbers in
 * the bibliography — which is not merely untidy. A reader counting sources
 * counts wrong, and a claim supported by one study looks corroborated by two.
 *
 * Two passes, in decreasing order of certainty:
 *
 *   1. **By DOI.** Exact, so it can never merge two different papers.
 *   2. **By normalised title.** Not exact, so it is deliberately strict —
 *      full-string equality after normalisation, never a prefix or fuzzy match.
 *      This is what links a preprint to its published version.
 */

import { canonicalUrl } from "./html.ts";
import { arxivDoiFromUrl, doiFromUrl } from "./hydrate.ts";

/** The minimum a row needs for collapsing. Deliberately structural, not the
 *  pipeline's candidate type, so this is testable without a run. */
export interface Dedupable {
  id: number;
  url: string;
  title?: string;
  doi?: string;
  year?: number;
  venue?: string;
  citedBy?: number;
  abstract?: string;
  pdfUrl?: string;
  note?: string;
}

export function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim().toLowerCase();
}

/** Is this DOI a preprint server's rather than a publisher's? */
export function isPreprintDoi(doi: string | undefined): boolean {
  if (!doi) return false;
  const d = normalizeDoi(doi);
  // arXiv, bioRxiv/medRxiv, Research Square, SSRN, OSF, Zenodo.
  return /^10\.48550\/|^10\.1101\/|^10\.21203\/|^10\.2139\/|^10\.31219\/|^10\.31234\/|^10\.5281\//.test(d);
}

/**
 * The identity of a row: its DOI when one is known, otherwise its URL.
 *
 * The DOI is read from the record when hydration supplied one and recovered
 * from the URL otherwise, so an arXiv PDF link and the OpenAlex record of the
 * same preprint produce the same key.
 */
export function identityKey(row: Dedupable): string {
  const doi = row.doi ?? doiFromUrl(row.url) ?? arxivDoiFromUrl(row.url);
  return doi ? `doi:${normalizeDoi(doi)}` : `url:${canonicalUrl(row.url)}`;
}

/** Punctuation, case and spacing vary between databases; nothing else may. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How complete a record is, for deciding which copy of a paper to keep.
 *
 * A published record with a venue and a citation count is a better citation
 * than the preprint of the same work, even when the preprint is the copy whose
 * full text is readable — so the metadata is taken from one and the PDF from
 * the other.
 */
function completeness(row: Dedupable): number {
  let score = 0;
  if (row.venue && row.venue !== "(venue unknown)") score += 4;
  if (row.doi && !isPreprintDoi(row.doi)) score += 3;
  if (row.year) score += 1;
  if (row.citedBy !== undefined) score += 1;
  if (row.abstract) score += 1;
  return score;
}

const VERSION_NOTE =
  "full text read from an open version of this work, not the version of record";

/**
 * Merge `extra` into `keep`, taking each field from whichever row has it.
 *
 * Nothing is invented and nothing is chosen arbitrarily: the kept row is the
 * more complete one, and it only ever gains fields it was missing.
 */
function merge(keep: Dedupable, extra: Dedupable): Dedupable {
  const merged: Dedupable = { ...keep };
  if (!merged.abstract && extra.abstract) merged.abstract = extra.abstract;
  if (!merged.year && extra.year) merged.year = extra.year;
  if (!merged.venue && extra.venue) merged.venue = extra.venue;
  if (merged.citedBy === undefined && extra.citedBy !== undefined) merged.citedBy = extra.citedBy;
  if (!merged.doi && extra.doi) merged.doi = extra.doi;

  if (!merged.pdfUrl && extra.pdfUrl) {
    merged.pdfUrl = extra.pdfUrl;
    // The full text now comes from a DIFFERENT record than the citation does.
    // Reading the preprint and citing the published paper without saying so is
    // exactly the quiet inaccuracy this pipeline exists to prevent.
    if (isPreprintDoi(extra.doi) && !isPreprintDoi(merged.doi)) {
      merged.note = merged.note ?? VERSION_NOTE;
    }
  }
  return merged;
}

export interface Collapsed {
  rows: Dedupable[];
  /** What was merged into what, for the run's audit trail. */
  merged: { kept: number; dropped: number; by: "doi" | "title"; title?: string }[];
}

/**
 * Collapse duplicates, keeping the first-seen order of what survives.
 *
 * Order matters downstream: candidate ids and the screening shortlist both
 * depend on it, so a collapse must not reshuffle the list.
 */
export function collapseDuplicates(rows: Dedupable[]): Collapsed {
  const merged: Collapsed["merged"] = [];

  /* ---- pass 1: exact, by DOI (or URL when there is no DOI) ---- */
  const byIdentity = new Map<string, Dedupable>();
  const order: string[] = [];
  for (const row of rows) {
    const key = identityKey(row);
    const seen = byIdentity.get(key);
    if (!seen) {
      byIdentity.set(key, row);
      order.push(key);
      continue;
    }
    const [keep, extra] = completeness(seen) >= completeness(row) ? [seen, row] : [row, seen];
    byIdentity.set(key, merge(keep, extra));
    merged.push({ kept: keep.id, dropped: extra.id, by: "doi" });
  }

  /* ---- pass 2: strict title equality, which links preprint to published ---- */
  const byTitle = new Map<string, string>();
  const dropped = new Set<string>();
  for (const key of order) {
    const row = byIdentity.get(key)!;
    const title = row.title ? normalizeTitle(row.title) : "";
    // Short titles collide by accident ("Introduction", "Erratum"), and a
    // wrong merge here destroys a real source rather than tidying a list.
    if (title.length < 20) continue;

    const firstKey = byTitle.get(title);
    if (firstKey === undefined) {
      byTitle.set(title, key);
      continue;
    }
    const first = byIdentity.get(firstKey)!;
    const [keepKey, keep, extra] =
      completeness(first) >= completeness(row)
        ? ([firstKey, first, row] as const)
        : ([key, row, first] as const);
    byIdentity.set(keepKey, merge(keep, extra));
    byTitle.set(title, keepKey);
    dropped.add(keepKey === key ? firstKey : key);
    merged.push({ kept: keep.id, dropped: extra.id, by: "title", title: row.title ?? "" });
  }

  return {
    rows: order.filter((k) => !dropped.has(k)).map((k) => byIdentity.get(k)!),
    merged,
  };
}
