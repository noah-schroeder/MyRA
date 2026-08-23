/**
 * The citation table, and the guarantees built on it.
 *
 * THE CENTRAL RULE: the model never writes citation metadata. It may emit
 * "[n]" markers and nothing else. Every author, title, year, DOI and URL in the
 * finished report is rendered from records captured at retrieval time. That is
 * what makes a fabricated reference structurally impossible rather than merely
 * unlikely -- there is no path by which model output becomes bibliography text.
 *
 * What this file can prove:
 *   - every [n] resolves to a real retrieved source
 *   - every direct quote appears verbatim in the stored text
 * What it cannot prove, and does not pretend to:
 *   - that a paraphrase faithfully represents its source (semantic; checked
 *     separately by the verification stage, and only ever reduced)
 */

import { createHash } from "node:crypto";

export interface SourceRecord {
  /** The citation number the model is allowed to use. Stable within a run. */
  n: number;
  url: string;
  title: string;
  /** Everything below is optional: web pages have no DOI, papers have no engine. */
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  engine?: string;
  /** Exactly what was read, so a citation cannot drift from its source. */
  sha256: string;
  retrievedAt: string;
  chars: number;
  /** How the text was obtained, so "abstract only" is never mistaken for full text. */
  via: "html" | "pdf" | "abstract" | "text";
  /**
   * A caveat about WHAT was read, carried into the bibliography.
   *
   * Set when the text came from an open version of a paywalled work: the
   * citation is to the paper, but the words that were read are the preprint's.
   */
  note?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function makeSourceRecord(
  n: number,
  text: string,
  fields: Omit<SourceRecord, "n" | "sha256" | "retrievedAt" | "chars">,
): SourceRecord {
  return {
    n,
    ...fields,
    sha256: hashText(text),
    retrievedAt: new Date().toISOString(),
    chars: text.length,
  };
}

/* ------------------------------------------------------------------ *
 * Citation markers                                                    *
 * ------------------------------------------------------------------ */

/**
 * The largest plausible citation number.
 *
 * Anything at or above this is a year, not a reference: drafts routinely
 * contain "[1990-2020]", and reading that as thirty-one citations would invent
 * dangling markers out of ordinary prose.
 */
const MAX_CITATION = 999;
/** A citation range wider than this is a page span, not a list of sources. */
const MAX_RANGE_SPAN = 30;

/** Every [n] in a draft, in order of appearance. Handles [1], [1,2] and [1-3]. */
export function extractCitations(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
    for (const part of m[1]!.split(",")) {
      const range = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (to >= from && to - from <= MAX_RANGE_SPAN && from >= 1 && to <= MAX_CITATION) {
          for (let i = from; i <= to; i++) found.push(i);
        }
        continue;
      }
      const one = Number(part.trim());
      if (Number.isInteger(one) && one >= 1 && one <= MAX_CITATION) found.push(one);
    }
  }
  return found;
}

export interface CitationAudit {
  ok: boolean;
  /** Markers with no matching source. A hard error: the run must not ship. */
  dangling: number[];
  /** Sources that were retrieved but never cited. Informational only. */
  uncited: number[];
  cited: number[];
}

/**
 * Check every marker against the table.
 *
 * A dangling marker is fatal by design. Silently dropping it would produce a
 * report that reads as sourced while pointing at nothing -- the exact failure
 * this whole design exists to make impossible.
 */
export function auditCitations(draft: string, sources: SourceRecord[]): CitationAudit {
  const known = new Set(sources.map((s) => s.n));
  const used = new Set(extractCitations(draft));
  const dangling = [...used].filter((n) => !known.has(n)).sort((a, b) => a - b);
  const uncited = [...known].filter((n) => !used.has(n)).sort((a, b) => a - b);
  return { ok: dangling.length === 0, dangling, uncited, cited: [...used].sort((a, b) => a - b) };
}

/* ------------------------------------------------------------------ *
 * Quotes                                                              *
 * ------------------------------------------------------------------ */

export interface QuoteCheck {
  quote: string;
  citation: number | undefined;
  verbatim: boolean;
  reason?: string;
}

/**
 * Whitespace-insensitive containment.
 *
 * Extracted PDF text carries line breaks and column padding that no model would
 * reproduce, so an exact byte match would reject correct quotes. Collapsing runs
 * of whitespace is the smallest normalisation that keeps the check meaningful:
 * every character still has to be there, in order.
 */
export function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(haystack).includes(norm(needle));
}

/**
 * Locate a quote in the source text and return its ORIGINAL offsets.
 *
 * Matching has to ignore whitespace -- pdftotext breaks lines mid-sentence and
 * a model quoting a paper will not reproduce those breaks -- but the offsets
 * must point into the stored file, or "check this claim" cannot open the right
 * place. So normalise with a position map rather than on a copy, and translate
 * the match back.
 */
export function findVerbatim(
  haystack: string,
  needle: string,
): { start: number; end: number } | undefined {
  const map: number[] = [];
  let flat = "";
  let pendingSpace = false;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (/\s/.test(ch)) {
      pendingSpace = flat.length > 0;
      continue;
    }
    if (pendingSpace) {
      flat += " ";
      map.push(i);
      pendingSpace = false;
    }
    flat += ch.toLowerCase();
    map.push(i);
  }
  const target = needle.replace(/\s+/g, " ").trim().toLowerCase();
  if (!target) return undefined;
  const at = flat.indexOf(target);
  if (at === -1) return undefined;
  const start = map[at];
  const last = map[at + target.length - 1];
  if (start === undefined || last === undefined) return undefined;
  return { start, end: last + 1 };
}

/** Quoted spans of at least `minWords`, with the citation that follows them. */
export function extractQuotes(draft: string, minWords = 4): { quote: string; citation?: number }[] {
  const out: { quote: string; citation?: number }[] = [];
  for (const m of draft.matchAll(/[“"]([^”"]{12,600})[”"]\s*(?:\[(\d+))?/g)) {
    const quote = m[1]!.trim();
    if (quote.split(/\s+/).length < minWords) continue;
    out.push(m[2] ? { quote, citation: Number(m[2]) } : { quote });
  }
  return out;
}

/**
 * Verify every quoted span against the text actually retrieved.
 *
 * This is a real guarantee rather than a probabilistic one: a quote either
 * appears in the stored source or it does not.
 */
export function verifyQuotes(
  draft: string,
  sources: SourceRecord[],
  texts: Map<number, string>,
): QuoteCheck[] {
  return extractQuotes(draft).map(({ quote, citation }) => {
    if (citation === undefined) {
      return { quote, citation, verbatim: false, reason: "quote carries no [n] citation" };
    }
    if (!sources.some((s) => s.n === citation)) {
      return { quote, citation, verbatim: false, reason: `[${citation}] is not a known source` };
    }
    const text = texts.get(citation);
    if (text === undefined) {
      return { quote, citation, verbatim: false, reason: `no stored text for [${citation}]` };
    }
    return containsVerbatim(text, quote)
      ? { quote, citation, verbatim: true }
      : { quote, citation, verbatim: false, reason: "not found verbatim in the cited source" };
  });
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */

/** Render the bibliography from the TABLE. Never from model output. */
export function renderBibliography(sources: SourceRecord[], only?: number[]): string {
  const wanted = only ? new Set(only) : undefined;
  return sources
    .filter((s) => !wanted || wanted.has(s.n))
    .sort((a, b) => a.n - b.n)
    .map((s) => {
      const bits: string[] = [];
      if (s.authors?.length) {
        bits.push(s.authors.slice(0, 3).join(", ") + (s.authors.length > 3 ? ", et al." : ""));
      }
      if (s.year) bits.push(String(s.year));
      bits.push(s.title || "(untitled)");
      if (s.venue) bits.push(s.venue);
      if (s.doi) bits.push(`doi:${s.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`);
      bits.push(s.url);
      const caveats = [
        ...(s.via === "abstract" ? ["abstract only"] : []),
        ...(s.note ? [s.note] : []),
      ];
      const note = caveats.length ? `  [${caveats.join("; ")}]` : "";
      return `[${s.n}] ${bits.join(". ")}${note}`;
    })
    .join("\n");
}
