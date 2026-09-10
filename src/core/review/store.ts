/**
 * Reviews on disk, read back safely.
 *
 * The pure half of the store: what a file is called, and how a record that has
 * been edited, truncated by a full disk, or synced half-written is turned back
 * into something the page can draw. The half that touches a filesystem is
 * [main/review.ts](../../main/review.ts).
 *
 * A flat `<id>.json` each, like papers rather than like meetings: a review has
 * one artifact, and a directory per review would put a tree of folders holding
 * one file apiece in a place the user is invited to open.
 *
 * `parseRecord` is forgiving in the way papers/store.ts is. A list that throws
 * on the fifth of twenty reviews is worse than one that skips it -- and skipping
 * is visible, because the review is missing from a list the reviewer knows the
 * length of. A single unreadable reviewer inside an otherwise good record is
 * dropped for the same reason: two reports are worth more than none.
 */

import type { Review, ReviewReport, ReviewStatus } from "./record.ts";

export const REVIEW_EXT = ".json";

export function reviewFileName(id: string): string {
  return `${id}${REVIEW_EXT}`;
}

/** The id a filename belongs to, or nothing if it is not one of ours. */
export function idOfFile(filename: string): string | undefined {
  if (!filename.endsWith(REVIEW_EXT)) return undefined;
  const id = filename.slice(0, -REVIEW_EXT.length);
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== ".." ? id : undefined;
}

function text(row: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof row[key] === "string" ? (row[key] as string) : fallback;
}

function count(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

const STATUSES: readonly ReviewStatus[] = ["running", "done", "stopped", "failed"];

/**
 * A run interrupted by a crash is read back as stopped, not as running.
 *
 * `running` means a panel is being written right now, and nothing is writing
 * this one -- the process that was died. Leaving it as `running` would give the
 * list a row with a spinner that never resolves and a Stop button attached to
 * nothing.
 */
function parseStatus(raw: unknown): ReviewStatus {
  const value = typeof raw === "string" ? (raw as ReviewStatus) : "done";
  if (value === "running") return "stopped";
  return STATUSES.includes(value) ? value : "done";
}

function parseReport(raw: unknown, index: number): ReviewReport | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const body = text(row, "text");
  if (!body.trim()) return undefined;
  return {
    reviewerId: text(row, "reviewerId") || `reviewer-${index + 1}`,
    label: text(row, "label") || `Reviewer ${index + 1}`,
    text: body,
  };
}

export function parseRecord(raw: unknown, id: string): Review | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const reports = (Array.isArray(row["reports"]) ? row["reports"] : [])
    .map(parseReport)
    .filter((r): r is ReviewReport => r !== undefined);
  const error = text(row, "error");
  return {
    id,
    title: text(row, "title") || "Untitled manuscript",
    fileName: text(row, "fileName"),
    words: count(row, "words"),
    studyTypeId: text(row, "studyTypeId"),
    studyLabel: text(row, "studyLabel"),
    prompt: text(row, "prompt"),
    note: text(row, "note"),
    /* Falls back to what is actually here, so a record written before the run
       knew its panel size still reports "2 of 2" rather than "2 of 0". */
    reviewers: count(row, "reviewers") || reports.length,
    reports,
    assembled: text(row, "assembled"),
    invented: (Array.isArray(row["invented"]) ? row["invented"] : []).filter(
      (v): v is string => typeof v === "string",
    ),
    status: parseStatus(row["status"]),
    ...(error ? { error } : {}),
    createdAt: text(row, "createdAt"),
    updatedAt: text(row, "updatedAt"),
  };
}
