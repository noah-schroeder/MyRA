/**
 * A paper's full text, shaped so a model can find its way around it.
 *
 * The design answer to "explore the papers in a project, without a vector
 * database": the model navigates the way a person skims -- the outline first,
 * then the passages a keyword search points at, then the section worth
 * reading -- and every step hands back literal text with a page number. That
 * is what makes the result quotable and checkable, which a nearest-neighbour
 * lookup over embeddings is not: it returns what is SIMILAR to a claim, and
 * similar is the one thing a citation must not settle for.
 *
 * Three pieces, all pure:
 *
 *   - `detectSections` reads headings off the pages. Heuristic, and allowed
 *     to be: an outline that misses a heading still has page numbers, and the
 *     text is all still there.
 *   - `passages` cuts the text into the ~150-word pieces search.ts indexes.
 *   - `readSpan` returns one bounded stretch -- a section, or from a page --
 *     sized to the reply's budget, and says where it stops, so a long paper
 *     is read in turns rather than dumped into a context window in one.
 *
 * A text with no page boundaries (Zotero's own full-text cache, a Word file)
 * is one "page" with `paged: false`, and nothing here pretends otherwise.
 */

export interface Section {
  /** The heading as printed, trimmed: "3. Methods". */
  name: string;
  /** 1-based page the heading is on. */
  page: number;
  /** Line index within that page where the heading sits. */
  line: number;
}

export interface FullText {
  /** One string per page; page N is `pages[N - 1]`, empty for a page with no text. */
  pages: string[];
  /** False when the source had no page boundaries, so "p. 1" would be a lie. */
  paged: boolean;
  sections: Section[];
  /** Where the reference list starts, if one was found. Search stops there. */
  references?: { page: number; line: number } | undefined;
}

/**
 * Heading words, as papers across fields actually print them. Matched against
 * the whole line (after any section number), never as a prefix of a sentence.
 */
const HEADING = new RegExp(
  "^(abstract|summary|keywords|introduction|background|literature review|review of (the )?literature|" +
    "related work|theoretical (framework|background)|conceptual framework|theory|hypothes[ie]s|" +
    "methods?|methodology|materials and methods|method and materials|study design|design|participants|" +
    "sample|setting|data( collection)?|measures|instruments?|procedures?|analysis|data analysis|" +
    "statistical analysis|results?|findings|results and discussion|discussion|limitations|" +
    "strengths and limitations|implications|practical implications|future (research|work|directions)|" +
    "conclusions?|concluding remarks|acknowledge?ments|funding|conflicts? of interest|" +
    "declarations?|references|bibliography|works cited|literature cited|appendix( [a-z0-9]+)?|" +
    "supplementary (material|materials|information))$",
  "i",
);

/** "3.", "3.2", "II.", "A." -- the numbering in front of a heading. */
const NUMBERING = /^((\d+(\.\d+)*\.?)|([IVX]+\.)|([A-H]\.))\s+/;

const REFERENCES = /^(references|bibliography|works cited|literature cited)$/i;

function headingOf(line: string): string | undefined {
  const text = line.trim().replace(/\s+/g, " ");
  if (text.length < 3 || text.length > 80) return undefined;
  const bare = text.replace(NUMBERING, "").replace(/[:.]$/, "").trim();
  if (HEADING.test(bare)) return text.replace(/[:.]$/, "");
  /* A numbered line that reads like a title rather than a sentence: short, no
     full stop, a capital to open it. "2.1 Participants and setting". A
     numbered LIST item -- "1. We recruited forty nurses." -- fails on its
     final full stop or its length, which is the distinction that matters. */
  if (NUMBERING.test(text) && !/[.;,]$/.test(text)) {
    const words = bare.split(" ");
    if (words.length >= 1 && words.length <= 8 && /^[A-Z]/.test(bare) && !/\d{3,}/.test(bare)) return text;
  }
  return undefined;
}

export function detectSections(pages: readonly string[]): Pick<FullText, "sections" | "references"> {
  const sections: Section[] = [];
  let references: FullText["references"];
  pages.forEach((page, p) => {
    page.split("\n").forEach((line, l) => {
      const name = headingOf(line);
      if (!name) return;
      const last = sections[sections.length - 1];
      if (last && last.name.toLowerCase() === name.toLowerCase()) return; // a running header, repeated
      sections.push({ name, page: p + 1, line: l });
      if (REFERENCES.test(name.replace(NUMBERING, "").trim())) references = { page: p + 1, line: l };
    });
  });
  /* A running header that repeats on every page ("Methods" at the top of each)
     would be every page's section. The LAST reference heading wins, because a
     paper that mentions "References" in its contents list on page one has its
     real list at the back. */
  return { sections, ...(references ? { references } : {}) };
}

/** A full text from pages -- the one constructor, so sections are never computed twice differently. */
export function fullTextOf(pages: readonly string[], paged = true): FullText {
  const clean = pages.map((p) => p.replace(/\r\n/g, "\n"));
  return { pages: clean, paged, ...detectSections(clean) };
}

/* ------------------------------------------------------------------ *
 * Passages, for the index                                             *
 * ------------------------------------------------------------------ */

export interface Passage {
  page: number;
  /** The nearest heading before it, or "" before the first one. */
  section: string;
  text: string;
}

/** Long enough to carry a claim and its qualifier, short enough that eight of them are a reply. */
const PASSAGE_WORDS = 150;

/**
 * The text cut into passages, never across a page and never past the reference
 * list -- a search for "self-efficacy" that returns forty reference entries
 * with the word in their titles is a search that found nothing.
 */
export function passages(text: FullText): Passage[] {
  const out: Passage[] = [];
  const starts = new Map<string, string>();
  for (const s of text.sections) starts.set(`${s.page}:${s.line}`, s.name);
  let section = "";

  text.pages.forEach((page, p) => {
    const pageNo = p + 1;
    if (text.references && pageNo > text.references.page) return;
    let words: string[] = [];
    let at = section;
    const flush = (): void => {
      if (words.length) out.push({ page: pageNo, section: at, text: words.join(" ") });
      words = [];
      at = section;
    };
    const lines = page.split("\n");
    for (let l = 0; l < lines.length; l++) {
      if (text.references && pageNo === text.references.page && l >= text.references.line) break;
      const heading = starts.get(`${pageNo}:${l}`);
      if (heading) {
        flush();
        section = heading;
        at = heading;
      }
      const line = lines[l]!.trim();
      if (!line) {
        if (words.length >= PASSAGE_WORDS * 0.6) flush();
        continue;
      }
      /* Word by word, not line by line: a Word or Markdown file arrives with a
         whole paragraph on one line, and Zotero's index text often with a
         whole page on one, which would otherwise be a single passage the size
         of the paper. */
      for (const word of line.split(/\s+/)) {
        words.push(word);
        if (words.length >= PASSAGE_WORDS) flush();
      }
    }
    flush();
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading a stretch                                                   *
 * ------------------------------------------------------------------ */

/** The same estimate compaction uses: characters, not a tokenizer nobody here has. */
const CHARS_PER_TOKEN = 3.6;

/** "Abstract (p. 1) · 2. Methods (p. 3) · … · 14 pages". */
export function outline(text: FullText): string {
  const parts = text.sections.map((s) => (text.paged ? `${s.name} (p. ${s.page})` : s.name));
  const size = text.paged
    ? `${text.pages.length} page${text.pages.length === 1 ? "" : "s"}`
    : "no page numbers in this copy";
  return parts.length ? `${parts.join(" · ")} — ${size}` : `No headings found — ${size}`;
}

export interface Span {
  /** The text, with `[p. N]` where each page begins. */
  text: string;
  /** Where the next unread page starts, when the budget ran out first. */
  continuesAt?: number | undefined;
  /** What was asked for and could not be found -- the reply names the real sections instead. */
  missing?: string | undefined;
}

/**
 * One stretch of the paper, no longer than the budget.
 *
 * Whole pages at a time where it can, so "continues at page 7" loses nothing;
 * a single page over budget on its own is cut at a paragraph and says so. A
 * section runs to the next heading. With neither, it starts at the beginning.
 */
export function readSpan(
  text: FullText,
  want: { section?: string | undefined; page?: number | undefined },
  budgetTokens: number,
): Span {
  const budget = Math.max(400, Math.floor(budgetTokens * CHARS_PER_TOKEN));
  let startPage = 1;
  let startLine = 0;
  let end: { page: number; line: number } | undefined;

  if (want.section?.trim()) {
    const found = findSection(text, want.section);
    if (!found) return { text: "", missing: want.section.trim() };
    startPage = found.page;
    startLine = found.line;
    const next = text.sections[text.sections.indexOf(found) + 1];
    if (next) end = { page: next.page, line: next.line };
  } else if (want.page !== undefined) {
    if (!text.paged) return { text: "", missing: `page ${want.page} (this copy has no page numbers)` };
    if (!Number.isInteger(want.page) || want.page < 1 || want.page > text.pages.length) {
      return { text: "", missing: `page ${want.page} (the paper has ${text.pages.length})` };
    }
    startPage = want.page;
  }

  const chunks: string[] = [];
  let used = 0;
  for (let p = startPage; p <= text.pages.length; p++) {
    if (end && p > end.page) break;
    let lines = text.pages[p - 1]!.split("\n");
    if (p === startPage) lines = lines.slice(startLine);
    if (end && p === end.page) lines = lines.slice(0, end.line - (p === startPage ? startLine : 0));
    const body = lines.join("\n").trim();
    const piece = text.paged ? `[p. ${p}]\n${body}` : body;
    if (!body) continue;

    if (used + piece.length > budget) {
      if (!chunks.length) {
        // One page over budget on its own: cut at the last paragraph that fits.
        const cut = piece.lastIndexOf("\n\n", budget);
        chunks.push(`${piece.slice(0, cut > budget / 2 ? cut : budget).trimEnd()}\n[… the rest of this page was cut to fit]`);
        return { text: chunks.join("\n\n"), ...(p < text.pages.length ? { continuesAt: p + 1 } : {}) };
      }
      return { text: chunks.join("\n\n"), continuesAt: p };
    }
    chunks.push(piece);
    used += piece.length + 2;
  }
  return { text: chunks.join("\n\n") };
}

/**
 * A section by what the model called it: exact first, then by the heading's
 * words without its number ("methods" finds "3. Methods"), then containment.
 */
export function findSection(text: FullText, name: string): Section | undefined {
  const want = name.trim().toLowerCase().replace(NUMBERING, "");
  const bare = (s: Section): string => s.name.toLowerCase().replace(NUMBERING, "").trim();
  return (
    text.sections.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ??
    text.sections.find((s) => bare(s) === want) ??
    text.sections.find((s) => bare(s).includes(want) || want.includes(bare(s)))
  );
}
