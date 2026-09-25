/**
 * A meeting's verified items, offered to its project's notes.
 *
 * The meetings subsystem already did the hard part: every item it extracted
 * was looked up in the transcript before it was trusted, and the time is the
 * line's, not the model's. So nothing is re-derived here -- the items are
 * mapped to slots, the unverified ones kept out, and duplicates of a current
 * note dropped. Pure, so the mapping is tested with no meeting and no form.
 */

import type { VerifiedItem } from "../meetings/notes.ts";
import type { MemorySlot, NewItem, ProjectMemory, Provenance } from "./memory.ts";

/** Where each kind of meeting item belongs among a project's notes. Actions are tasks, not notes. */
const MEETING_SLOTS: Partial<Record<VerifiedItem["type"], MemorySlot>> = {
  decision: "decisions",
  question: "open",
  risk: "open",
  update: "context",
};

/**
 * The meeting's verified items as candidate notes: only what the transcript
 * actually holds (`verbatim` or `reworded` -- the notes' `## Unverified` pile
 * stays out), mapped to a slot, and not already a current note in it.
 */
export function meetingCandidates(
  memory: ProjectMemory,
  items: readonly VerifiedItem[],
  meeting: string,
): (NewItem & Provenance)[] {
  const current = new Set(
    memory.items.filter((it) => it.status === undefined).map((it) => `${it.slot}\u0000${it.text.toLowerCase()}`),
  );
  const out: (NewItem & Provenance)[] = [];
  for (const item of items) {
    const slot = MEETING_SLOTS[item.type];
    if (!slot || item.sourcing === "unverified") continue;
    const text = (item.type === "risk" ? `Risk: ${item.title}` : item.title).trim();
    if (!text || current.has(`${slot}\u0000${text.toLowerCase()}`)) continue;
    current.add(`${slot}\u0000${text.toLowerCase()}`);
    out.push({
      slot,
      text,
      quote: item.sourceText ?? item.quote,
      meeting,
      ...(item.at ? { meetingAt: item.at } : {}),
    });
  }
  return out;
}
