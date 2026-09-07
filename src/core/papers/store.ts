/**
 * Papers on disk, read back safely.
 *
 * The pure half of the store: what a file is called, and how a record that has
 * been edited, truncated by a full disk, or synced half-written is turned back
 * into something the page can draw. The half that touches a filesystem is
 * [main/papers.ts](../../main/papers.ts).
 *
 * A flat `<id>.json` each, like generated images rather than like meetings: a
 * paper has one artifact, not six, and a directory per paper would put a tree
 * of folders holding one file apiece in a place the user is invited to open.
 *
 * `parseRecord` is deliberately forgiving in the same way images/store.ts is. A
 * list that throws on the fifth of twenty papers is worse than one that skips
 * it -- and skipping is visible, because the paper is missing from a list the
 * author knows the length of.
 */

import { newSection, type Paper, type PaperKind, type PaperSection, type PaperSummary } from "./paper.ts";

export const PAPER_EXT = ".json";

export function paperFileName(id: string): string {
  return `${id}${PAPER_EXT}`;
}

/** The id a filename belongs to, or nothing if it is not one of ours. */
export function idOfFile(filename: string): string | undefined {
  if (!filename.endsWith(PAPER_EXT)) return undefined;
  const id = filename.slice(0, -PAPER_EXT.length);
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".." ? id : undefined;
}

function text(row: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof row[key] === "string" ? (row[key] as string) : fallback;
}

function parseSection(raw: unknown, index: number): PaperSection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const base = newSection(text(row, "name") || `Section ${index + 1}`);
  return {
    /* A section that lost its id still gets one, because the id is how the
       page addresses a draft in flight. Generated rather than derived from the
       index: two sections that swap places must not swap drafts. */
    id: text(row, "id") || base.id,
    name: base.name,
    notes: text(row, "notes"),
    draft: text(row, "draft"),
    guidance: text(row, "guidance"),
  };
}

export function parseRecord(raw: unknown, id: string): Paper | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const kind: PaperKind = text(row, "kind") === "section" ? "section" : "paper";
  const sections = (Array.isArray(row["sections"]) ? row["sections"] : [])
    .map(parseSection)
    .filter((s): s is PaperSection => s !== undefined);
  return {
    id,
    kind,
    title: text(row, "title") || "Untitled",
    writingSample: text(row, "writingSample"),
    instructions: text(row, "instructions"),
    /* Never zero sections: the page has nothing to draw for one, and a record
       whose section list did not survive is still a writing sample and a title
       somebody would rather keep than lose. */
    sections: sections.length ? sections : [newSection(kind === "paper" ? "Introduction" : "This section")],
    updatedAt: text(row, "updatedAt"),
  };
}

export function summaryOf(paper: Paper): PaperSummary {
  return {
    id: paper.id,
    kind: paper.kind,
    title: paper.title,
    sections: paper.sections.length,
    drafted: paper.sections.filter((s) => s.draft.trim()).length,
    updatedAt: paper.updatedAt,
  };
}

/** Most recently worked on first, which is the order this list is read in. */
export function byNewest(a: PaperSummary, b: PaperSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}
