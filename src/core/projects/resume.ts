/**
 * "Where we left off": what changed in a project since it was last opened.
 *
 * Deliberately no model. Everything here is already recorded -- when each
 * note arrived, which questions are still open, when each piece of work was
 * made -- so a summary written by a model would only be a less reliable copy
 * of it, and one more thing on this page that could be wrong. Pure, so the
 * card and its test read the same function.
 */

import { activeItems, isActive, pendingSuggestions, type MemoryItem, type ProjectMemory } from "./memory.ts";
import type { MemberKind } from "./project.ts";

export interface ResumeRow {
  kind: MemberKind;
  ref: string;
  title: string;
  at: string;
}

export interface ResumeDigest {
  /** When the project was last opened before now. Absent the first time. */
  since?: string;
  /** Current notes that arrived after `since`, newest first. */
  newNotes: MemoryItem[];
  /** Notes closed after `since`: replaced, or questions answered. */
  closedNotes: MemoryItem[];
  /** Work made after `since`, newest first. */
  newWork: ResumeRow[];
  /** Open questions still open, whenever they were asked. */
  openQuestions: MemoryItem[];
  /** Automatic notes waiting on a person to accept or dismiss what they suggest. */
  waiting: number;
  /** Nothing worth a card: the first visit to an empty project, or a return to an unchanged one. */
  empty: boolean;
}

export function resumeDigest(
  memory: ProjectMemory | undefined,
  rows: readonly ResumeRow[],
  since: string | undefined,
): ResumeDigest {
  const after = (iso: string | undefined): boolean => Boolean(since && iso && iso > since);
  const current = memory ? activeItems(memory) : [];
  const newNotes = current.filter((it) => after(it.at)).sort((a, b) => b.at.localeCompare(a.at));
  const closedNotes = (memory?.items ?? []).filter((it) => !isActive(it) && after(it.closedAt));
  const newWork = rows.filter((r) => after(r.at)).sort((a, b) => b.at.localeCompare(a.at));
  const openQuestions = current.filter((it) => it.slot === "open");
  const waiting = memory ? pendingSuggestions(memory).length : 0;
  return {
    ...(since ? { since } : {}),
    newNotes,
    closedNotes,
    newWork,
    openQuestions,
    waiting,
    empty: !newNotes.length && !closedNotes.length && !newWork.length && !openQuestions.length && !waiting,
  };
}
