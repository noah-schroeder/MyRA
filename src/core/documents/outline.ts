/**
 * The outline: everything the draft will contain, as text you can edit.
 *
 * One dialog, before anything is written. You see the title, who it is for,
 * where it will be saved, and every section with its brief and its length. You
 * change whatever is wrong, and you approve once.
 *
 * This exists because a small model asked for a five-page report in one call
 * writes five pages of the same paragraph. Sections are generated separately,
 * which needs a list of sections -- and once that list exists, showing it to
 * the user before spending several minutes on it is nearly free. The approval
 * is not ceremony: it is the one moment where correcting a misunderstanding
 * costs a keystroke rather than a re-run.
 *
 * The format is markdown because you read it, but it is parsed strictly enough
 * to catch an empty section or a nonsense length before any of it is written.
 */

import {
  FORMAT_NAMES, looksAbsolute, looksLikeEscape, resolveFormat, safeRelativePath, slugName,
} from "./formats.ts";

export interface DraftSection {
  heading: string;
  /** What belongs in this section, in a line. This is the section's prompt. */
  brief: string;
  /** Target length. Advisory to the model, and the pacing signal for the user. */
  words: number;
}

export interface Outline {
  title: string;
  /**
   * Who reads this, and what they need from it.
   *
   * Carried into every section prompt. A section written for "the funding
   * committee" and one written for "my co-authors" differ in register, in how
   * much is assumed, and in what gets defended -- and a model told neither
   * writes for nobody.
   */
  audience: string;
  /** Filename inside the documents folder. */
  filename: string;
  /** One of FORMAT_NAMES. The sections are always drafted as Markdown. */
  format: string;
  sections: DraftSection[];
}

export class OutlineError extends Error {
  override readonly name = "OutlineError";
}

/**
 * Bounds, not preferences.
 *
 * The per-section ceiling is the one that matters: a local 2.6B asked for 2,000
 * words in one call does not produce 2,000 good words, it produces 400 good
 * ones and then restates them. Splitting is the entire point of this flow, so a
 * section that has grown past the ceiling should become two sections.
 */
export const MAX_SECTION_WORDS = 1200;
export const MAX_SECTIONS = 24;
const DEFAULT_WORDS = 300;

export function totalWords(outline: Outline): number {
  return outline.sections.reduce((n, s) => n + s.words, 0);
}

/**
 * @param notice Said before anything else when the outline is not the model's
 * work. Everything above the first `##` is dropped on the way back, so this
 * cannot become part of the document.
 */
export function renderOutline(outline: Outline, notice?: string): string {
  return [
    `# Draft plan`,
    ``,
    `Edit anything below, then save. Nothing has been written yet.`,
    ``,
    ...(notice ? [`> ${notice}`, ``] : []),
    `## Title`,
    outline.title,
    ``,
    `## Audience`,
    outline.audience || "(not specified)",
    ``,
    `## File`,
    `name: ${outline.filename}`,
    `format: ${outline.format}`,
    ``,
    `## Sections`,
    ``,
    `Each section is written on its own, to the brief and the length set here.`,
    `Delete a section to drop it. Add one in the same shape to include it.`,
    ``,
    ...outline.sections.flatMap((s) => [
      `### ${s.heading}`,
      `words: ${s.words}`,
      s.brief || "(no brief — the heading is all the model gets)",
      ``,
    ]),
    ...(totalWords(outline) > 4000
      ? [
          `> That is ${totalWords(outline).toLocaleString()} words across`,
          `> ${outline.sections.length} sections. On a local model this will take a while;`,
          `> the file is saved after every section, so you can read it as it fills in.`,
          ``,
        ]
      : []),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Parsing back                                                        *
 * ------------------------------------------------------------------ */

const PLACEHOLDER = /^\((none|not specified|no brief)[^)]*\)$/i;

/** Split on `## ` headings, keeping the lines under each. */
function topLevel(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | undefined;
  for (const raw of text.split("\n")) {
    const heading = /^##\s+(?!#)(.+?)\s*$/.exec(raw);
    if (heading) {
      current = heading[1]!.toLowerCase();
      out.set(current, []);
      continue;
    }
    if (current) out.get(current)!.push(raw);
  }
  return out;
}

function paragraph(lines: string[] | undefined): string {
  const text = (lines ?? []).map((l) => l.trim()).filter(Boolean).join(" ").trim();
  return PLACEHOLDER.test(text) ? "" : text;
}

function keyValues(lines: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines ?? []) {
    const m = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) out.set(m[1]!.toLowerCase(), m[2]!);
  }
  return out;
}

/**
 * Pull the `### ` blocks out of the Sections body.
 *
 * Everything that is not the `words:` line and not a blockquote becomes the
 * brief, so a user can write two lines of guidance under a heading and have it
 * all reach the model. The instructions rendered above the first heading are
 * dropped by construction: they sit before any `###`, so nothing collects them.
 */
function parseSections(lines: string[]): DraftSection[] {
  const out: DraftSection[] = [];
  let current: { heading: string; words?: number; brief: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const brief = current.brief.map((l) => l.trim()).filter(Boolean).join(" ").trim();
    out.push({
      heading: current.heading,
      brief: PLACEHOLDER.test(brief) ? "" : brief,
      words: current.words ?? DEFAULT_WORDS,
    });
    current = undefined;
  };

  for (const raw of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      flush();
      // Numbering is rendered by the user's own hand if they want it; strip a
      // leading "1." so re-ordering sections by hand does not embed stale
      // numbers into the finished document's headings.
      current = { heading: heading[1]!.replace(/^\d+[.)]\s*/, "").trim(), brief: [] };
      continue;
    }
    if (!current) continue;
    if (raw.trim().startsWith(">")) continue;
    const kv = /^\s*words\s*:\s*(.*?)\s*$/i.exec(raw);
    if (kv) {
      const n = Number(kv[1]);
      if (!Number.isFinite(n) || n < 1) {
        throw new OutlineError(
          `"${current.heading}": words must be a positive number, got "${kv[1]}"`,
        );
      }
      current.words = Math.min(Math.floor(n), MAX_SECTION_WORDS);
      continue;
    }
    current.brief.push(raw);
  }
  flush();
  return out.filter((s) => s.heading);
}

/**
 * Parse an edited outline, and reject what cannot be written.
 *
 * Strict, because every failure here is one the user can fix in the dialog they
 * are already looking at, and every failure caught later is one they discover
 * after watching a progress bar.
 */
export function parseOutline(text: string, previous: Outline): Outline {
  const s = topLevel(text);

  const title = paragraph(s.get("title")) || previous.title;
  if (!title) throw new OutlineError("the outline has no title — the ## Title section is empty");

  const sections = parseSections(s.get("sections") ?? []);
  if (sections.length === 0) {
    throw new OutlineError(
      "the outline has no sections — add at least one `### Heading` under ## Sections",
    );
  }
  if (sections.length > MAX_SECTIONS) {
    throw new OutlineError(
      `${sections.length} sections is more than this flow will write (${MAX_SECTIONS}). ` +
        `Each one is a separate request to the model.`,
    );
  }

  const file = keyValues(s.get("file"));
  const formatName = (file.get("format") || previous.format).trim().toLowerCase();
  const format = resolveFormat(formatName);
  if (!format) {
    throw new OutlineError(`unknown format "${formatName}". Choose one of: ${FORMAT_NAMES.join(", ")}`);
  }

  /* Renamed with the format, not just re-extensioned: someone who changes
     `format: docx` and leaves `name: report.md` means the docx, and writing
     Markdown into a file called .md while calling it a Word document is the
     kind of quiet mismatch that is only discovered when it is emailed. */
  const givenName = (file.get("name") || "").trim();
  const filename = normaliseName(givenName || slugName(title, format.ext), format.ext, title);

  return { title, audience: paragraph(s.get("audience")), filename, format: formatName, sections };
}

/**
 * A filename that is inside the documents folder and carries the right suffix.
 *
 * Refused rather than repaired when the path itself is the problem: a name with
 * `..` in it is a mistake worth reporting, whereas a missing extension is worth
 * fixing silently because nobody who typed "report" meant a file with no type.
 */
export function normaliseName(given: string, ext: string, title: string): string {
  /* Refused rather than reinterpreted, matching write_document exactly.
     safeRelativePath strips a leading slash, which is safe -- the result still
     lands inside the jail -- but it turns "/etc/passwd" into a real file at
     <jail>/etc/passwd, and a phantom etc/ directory appearing in someone's
     documents folder is nobody's intent. Two tools that jail the same folder
     must not disagree about what an absolute path means, which is why the test
     is one shared function rather than a copy of `/` in each of them. */
  if (looksAbsolute(given)) {
    throw new OutlineError(`"${given}" is an absolute path; give a name inside the documents folder`);
  }
  /* A climb stays an error. Falling back to the slug below would turn an
     attempt to leave the folder into a quiet relocation, which is the thing
     this boundary refuses to do. */
  if (looksLikeEscape(given)) {
    throw new OutlineError(`"${given}" is not a name inside the documents folder`);
  }
  /* Slugged rather than refused, which is what the empty case below already
     does. The name here was written by a model into an outline, and a draft
     is minutes of work across many sections -- aborting the whole run because
     a heading said "Study: A Review" is a worse answer than filing it as
     `study-a-review.md`. The characters that would make this a path, rather
     than merely an awkward filename, are gone either way: slugName reduces to
     [a-z0-9-], and an absolute path is refused above. */
  const rel = safeRelativePath(given) ?? slugName(title, ext);
  const base = rel.replace(/\.[A-Za-z0-9]+$/, "");
  if (!base) return slugName(title, ext);
  return `${base}.${ext}`;
}
