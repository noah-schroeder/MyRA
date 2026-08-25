/**
 * BibTeX and CSL-JSON, rendered from the source table.
 *
 * Same rule as the bibliography, and for the same reason: **the model never
 * writes citation metadata.** Every field below comes from a `SourceRecord`
 * captured at retrieval time, so an exported entry cannot name an author the
 * paper does not have or a journal it did not appear in. There is no path by
 * which model output becomes a `.bib` file.
 *
 * This is what makes the pipeline usable for real academic work rather than
 * merely readable: a report you cannot get into Zotero or a LaTeX bibliography
 * is a report you retype by hand, and retyping is where citations drift.
 */

import type { SourceRecord } from "./sources.ts";

/* ------------------------------------------------------------------ *
 * Shared field derivation                                             *
 * ------------------------------------------------------------------ */

/** Strip the resolver prefix; a DOI is an identifier, not a URL. */
function bareDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
}

/**
 * Split a display name into family and given parts.
 *
 * OpenAlex gives "Given Family" in one string, which both formats want split.
 * The last whitespace-separated token is the family name -- wrong for a handful
 * of compound surnames, and the alternative is a name-parsing library that is
 * wrong about a different handful. Particles ("van", "de", "von") are kept with
 * the family name, which covers the common European cases.
 */
export function splitName(display: string): { family: string; given: string } {
  const parts = display.replace(/\s+/g, " ").trim().split(" ");
  if (parts.length === 1) return { family: parts[0] ?? "", given: "" };

  const PARTICLES = new Set(["van", "von", "de", "der", "den", "del", "della", "di", "da", "du", "la", "le", "dos", "das"]);
  let start = parts.length - 1;
  while (start > 1 && PARTICLES.has(parts[start - 1]!.toLowerCase())) start--;
  return { family: parts.slice(start).join(" "), given: parts.slice(0, start).join(" ") };
}

/**
 * A stable, human-legible citation key.
 *
 * First author's family name, year, first meaningful title word -- the
 * convention every reference manager uses, so a key stays recognisable when it
 * appears in a `\cite{}`. Collisions get a numeric suffix rather than silently
 * overwriting, because two papers sharing a key is a broken bibliography.
 */
export function citeKey(source: SourceRecord, taken: Set<string>): string {
  const ascii = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "");

  const first = source.authors?.[0];
  const author = first ? ascii(splitName(first).family) : "";
  const year = source.year ? String(source.year) : "nd";
  const STOP = new Set(["the", "a", "an", "on", "of", "in", "for", "and", "to", "is", "are"]);
  const word =
    source.title
      ?.split(/\s+/)
      .map((w) => ascii(w))
      .find((w) => w.length > 2 && !STOP.has(w.toLowerCase())) ?? "";

  // Lower-cased throughout: a key is typed by hand into \cite{}, and mixed
  // case there is a source of silent misses.
  const base = `${author.toLowerCase() || "anon"}${year}${word.toLowerCase()}` || `source${source.n}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Journal article when there is a venue, otherwise a web page. */
function isArticle(s: SourceRecord): boolean {
  return Boolean(s.venue && s.venue !== "(venue unknown)");
}

/* ------------------------------------------------------------------ *
 * BibTeX                                                              *
 * ------------------------------------------------------------------ */

/**
 * Escape the five characters that change meaning in a BibTeX field.
 *
 * Braces are the dangerous pair: an unbalanced `{` in a title silently
 * swallows the rest of the file when BibTeX parses it.
 */
function bibEscape(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}])/g, "\\$1")
    .replace(/([&%$#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\s+/g, " ")
    .trim();
}

function bibField(name: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const text = typeof value === "number" ? String(value) : bibEscape(value);
  return text ? `  ${name} = {${text}}` : undefined;
}

export function toBibtex(sources: SourceRecord[]): string {
  const taken = new Set<string>();
  return sources
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((s) => {
      const key = citeKey(s, taken);
      const type = isArticle(s) ? "article" : "misc";
      const fields = [
        bibField("title", s.title),
        // BibTeX joins authors with " and ", never commas -- a comma inside a
        // name field means "Family, Given" and would mangle every entry.
        bibField("author", s.authors?.map((a) => {
          const { family, given } = splitName(a);
          return given ? `${family}, ${given}` : family;
        }).join(" and ")),
        bibField(isArticle(s) ? "journal" : "howpublished", s.venue && s.venue !== "(venue unknown)" ? s.venue : undefined),
        bibField("year", s.year),
        bibField("doi", s.doi ? bareDoi(s.doi) : undefined),
        bibField("url", s.url),
        bibField("urldate", s.retrievedAt.slice(0, 10)),
        // The caveat travels with the entry: citing a preprint as the version
        // of record is exactly the quiet inaccuracy this pipeline exists to
        // prevent, and it must survive the trip into a reference manager.
        bibField("note", [s.via === "abstract" ? "read from abstract only" : "", s.note ?? ""].filter(Boolean).join("; ")),
      ].filter((f): f is string => f !== undefined);
      return `@${type}{${key},\n${fields.join(",\n")}\n}`;
    })
    .join("\n\n") + (sources.length ? "\n" : "");
}

/* ------------------------------------------------------------------ *
 * CSL-JSON                                                            *
 * ------------------------------------------------------------------ */

export interface CslEntry {
  id: string;
  type: "article-journal" | "webpage";
  title?: string;
  author?: { family: string; given?: string }[];
  "container-title"?: string;
  issued?: { "date-parts": [[number]] };
  DOI?: string;
  URL?: string;
  accessed?: { "date-parts": [[number, number, number]] };
  note?: string;
}

/** What Zotero imports, and what pandoc's --citeproc reads. */
export function toCsl(sources: SourceRecord[]): CslEntry[] {
  const taken = new Set<string>();
  return sources
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((s) => {
      const accessed = s.retrievedAt.slice(0, 10).split("-").map(Number);
      const caveats = [s.via === "abstract" ? "read from abstract only" : "", s.note ?? ""].filter(Boolean);
      return {
        id: citeKey(s, taken),
        type: isArticle(s) ? ("article-journal" as const) : ("webpage" as const),
        ...(s.title ? { title: s.title } : {}),
        ...(s.authors?.length
          ? {
              author: s.authors.map((a) => {
                const { family, given } = splitName(a);
                return given ? { family, given } : { family };
              }),
            }
          : {}),
        ...(isArticle(s) ? { "container-title": s.venue! } : {}),
        ...(s.year ? { issued: { "date-parts": [[s.year]] as [[number]] } } : {}),
        ...(s.doi ? { DOI: bareDoi(s.doi) } : {}),
        ...(s.url ? { URL: s.url } : {}),
        ...(accessed.length === 3 && accessed.every((n) => Number.isFinite(n))
          ? { accessed: { "date-parts": [accessed as [number, number, number]] } }
          : {}),
        ...(caveats.length ? { note: caveats.join("; ") } : {}),
      };
    });
}

export function toCslJson(sources: SourceRecord[]): string {
  return JSON.stringify(toCsl(sources), null, 2) + "\n";
}
