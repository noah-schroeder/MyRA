/**
 * A paper being drafted: what it holds, and what it becomes.
 *
 * The workflow this describes came from Braindump5000, a separate tool the user
 * had already built and used: you paste a sample of your own academic prose,
 * you jot or dictate raw thoughts under each section heading, and the model
 * turns those thoughts into first-draft prose that sounds like you wrote it.
 * Citations are forbidden outright, because in that workflow they are added
 * later by a different process against real sources -- see
 * [prompt.ts](./prompt.ts), which is where that rule is enforced.
 *
 * Two kinds of work, one record. "A whole paper" and "one section" differ only
 * in how many sections there are and how much of the page is shown; making them
 * two shapes would be two components, two save paths and two sets of bugs, and
 * the second one would be the one nobody remembered to fix.
 *
 * The pure half, so it is testable with no Electron and no disk. What touches a
 * filesystem lives in [main/papers.ts](../../main/papers.ts).
 */

/** `paper`: sections you add, reorder and draft. `section`: exactly one. */
export type PaperKind = "paper" | "section";

export interface PaperSection {
  id: string;
  /** The heading. In `section` kind this is not shown and not written out. */
  name: string;
  /** What the author jotted or dictated. The input to a draft. */
  notes: string;
  /** The prose, editable by hand afterwards. Never contains reasoning. */
  draft: string;
  /** Instructions for this section alone. */
  guidance: string;
}

export interface Paper {
  id: string;
  kind: PaperKind;
  title: string;
  /**
   * A few paragraphs of the author's own writing.
   *
   * The single most load-bearing field here: every section prompt carries it,
   * and matching its voice is the thing this feature is for. Optional, and the
   * prompt says plainly what it falls back to when it is empty.
   */
  writingSample: string;
  /** Guidance applied to every section. Whole-paper mode only. */
  instructions: string;
  sections: PaperSection[];
  updatedAt: string;
}

/** What the list on the front of the page shows, without reading every draft. */
export interface PaperSummary {
  id: string;
  kind: PaperKind;
  title: string;
  sections: number;
  /** How many of them have prose in them, which is the real progress bar. */
  drafted: number;
  updatedAt: string;
}

/**
 * The sections an empty paper starts with.
 *
 * The IMRaD shape plus Background and Conclusion, which is what the tool this
 * came from opened with. Not a rule -- every one of them can be renamed,
 * reordered or deleted -- but a blank page is a worse place to start than a
 * conventional outline somebody disagrees with.
 */
export const DEFAULT_SECTIONS = [
  "Introduction",
  "Background",
  "Methods",
  "Results",
  "Discussion",
  "Conclusion",
] as const;

/** The name a single-section paper's one section carries, before it is titled. */
export const LONE_SECTION = "This section";

function randomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function newSection(name: string, id = randomId()): PaperSection {
  return { id, name, notes: "", draft: "", guidance: "" };
}

/**
 * A short, human-legible, filesystem-safe id: date, time, and a title slug.
 *
 * The local clock, not UTC, for the reason images/store.ts records: this name
 * is read in a file manager beside the modification time that manager prints,
 * and the two disagreeing by seven hours reads as a bug in the app.
 */
export function paperId(title: string, now = new Date(), salt = ""): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "paper"}${salt ? `-${salt}` : ""}`;
}

/**
 * A paper id, refused if it is anything but one.
 *
 * The same guard `assertImageId` and `assertRunId` are, for the same reason:
 * these come back from the window to be joined onto the papers root and then
 * read, exported and deleted.
 */
export function assertPaperId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no paper named ${JSON.stringify(id)}`);
  }
  return id;
}

export function newPaper(opts: {
  kind: PaperKind;
  title: string;
  id?: string;
  now?: Date;
}): Paper {
  const now = opts.now ?? new Date();
  const title = opts.title.trim() || (opts.kind === "paper" ? "Untitled paper" : "Untitled section");
  return {
    id: opts.id ?? paperId(title, now),
    kind: opts.kind,
    title,
    writingSample: "",
    instructions: "",
    sections:
      opts.kind === "paper"
        ? DEFAULT_SECTIONS.map((name) => newSection(name))
        : [newSection(LONE_SECTION)],
    updatedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Editing the section list                                            *
 * ------------------------------------------------------------------ */

/** Swap a section with its neighbour. Out of range is a no-op, not an error:
 *  the ▲ on the first row is pressed, and nothing happening is the answer. */
export function moveSection(sections: PaperSection[], index: number, delta: number): PaperSection[] {
  const to = index + delta;
  if (index < 0 || index >= sections.length || to < 0 || to >= sections.length) return sections;
  const next = [...sections];
  const moved = next[index]!;
  next[index] = next[to]!;
  next[to] = moved;
  return next;
}

export function withoutSection(sections: PaperSection[], id: string): PaperSection[] {
  return sections.filter((s) => s.id !== id);
}

/* ------------------------------------------------------------------ *
 * Becoming a document                                                 *
 * ------------------------------------------------------------------ */

/** Said in place of a section nobody has drafted yet. */
export const NOT_WRITTEN = "*(not yet written)*";

/**
 * The whole paper as Markdown, which is what gets converted and exported.
 *
 * A section with no draft is marked rather than skipped -- the same call
 * documents/draft.ts makes. A document that silently omits an empty section
 * reads as finished, and the gap is only discovered by the person it was sent
 * to.
 *
 * Single-section mode writes no `##` heading: there is one piece of prose and
 * the title is already above it, so a heading would be the title twice.
 */
export function assemble(paper: Paper): string {
  const title = paper.title.trim() || "Untitled";
  const body =
    paper.kind === "section"
      ? [paper.sections[0]?.draft.trim() || NOT_WRITTEN, ""]
      : paper.sections.flatMap((s) => [
          `## ${s.name.trim() || "Untitled section"}`,
          ``,
          s.draft.trim() || NOT_WRITTEN,
          ``,
        ]);
  return [`# ${title}`, ``, ...body].join("\n").trimEnd() + "\n";
}
