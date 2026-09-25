/**
 * Growing a project's memory on its own, from an ordinary conversation.
 *
 * The meeting notes rule, applied here: [notes.ts](../meetings/notes.ts)
 * extracts grounded items and looks every quote up in the transcript before
 * trusting it, because a model asked to quote its source occasionally quotes
 * something that is not there. An automatic memory write is the same shape of
 * risk one level up -- what gets extracted here does not come from a
 * transcript MyRA recorded, it comes from a conversation that may itself
 * contain a fetched web page or a dropped document, and those are exactly
 * the untrusted content this app already knows not to act on.
 *
 * So nothing is added on the extractor's say-so. Every proposal is grounded
 * one of two ways, both checked against the user's OWN words by
 * `verifyQuote` (see [transcript.ts](../meetings/transcript.ts)) after
 * untrusted blocks are stripped ([memory.ts](./memory.ts)'s
 * `conversationLines`):
 *
 *   - **Stated**: the quote is something the user actually typed.
 *   - **Confirmed**: the quote is something the assistant proposed, and the
 *     very next thing the user said agreed to it. This is how "the model
 *     offered three questions and the user picked one" becomes memory
 *     without the user having to retype the question themselves. The code
 *     checks the position -- a proposal, then the user's very next reply --
 *     and the extractor judges whether that reply was a yes; grounding
 *     never has to.
 *
 * Anything else is dropped, silently: this module has no "suggested" pile.
 * A proposal is grounded and kept, or it is not, and the caller
 * ([main/projectMemory.ts](../../main/projectMemory.ts)) never sees the
 * difference between "the model proposed nothing" and "the model proposed
 * something nobody actually said".
 */

import { parseJsonReply, type ChatMessage } from "../llm/chat.ts";
import { verifyQuote, type QuoteMatch } from "../meetings/transcript.ts";
import {
  activeItems, conversationLines, isMemorySlot, mergeAuto, MEMORY_SLOTS, SLOT_LABELS,
  type AutoItem, type GroundingLine, type MemoryItem, type NewItem, type ProjectMemory,
} from "./memory.ts";

/**
 * Everything from the watermark on, plus the assistant reply just before it
 * when there is one -- the proposal a user's new message may be confirming
 * was "already seen" the last time this ran, but nothing could be extracted
 * from it then, because nothing had confirmed it yet.
 *
 * Only an assistant line is looked back to. The pass now runs before every
 * reply, so the watermark sits just after a user message that has already
 * been read; showing it again invited the same decision back under new
 * wording, which `addAuto`'s exact-text dedupe cannot catch.
 */
function linesSince(messages: readonly ChatMessage[], since: number): GroundingLine[] {
  const lines = conversationLines(messages);
  const first = lines.findIndex((l) => l.at >= since);
  if (first === -1) return [];
  const before = lines[first - 1];
  return lines.slice(before?.speaker === "assistant" ? first - 1 : first);
}

export function buildUpdatePrompt(
  memory: ProjectMemory,
  messages: readonly ChatMessage[],
  since: number,
): string {
  const lines = linesSince(messages, since);
  const notes = numberedNotes(memory);
  const known = notes.length
    ? `Already noted about this project:\n${notes.map((i, n) => `#${n + 1} (${SLOT_LABELS[i.slot]}) ${i.text}`).join("\n")}\n\n`
    : "";
  const transcript = lines.map((l) => `${l.speaker === "user" ? "User" : "Assistant"}: ${l.text}`).join("\n\n");

  return [
    `${known}Part of a conversation in this project:`,
    ``,
    transcript || "(nothing new)",
    ``,
    `Is there anything here worth remembering about the PROJECT itself -- not this one message,`,
    `something that would still matter in a different conversation in the same project? An aim, a`,
    `research question, a theory being used, a method decided on, a decision made, a key paper or`,
    `author the project builds on, something left open, or useful background. Do not repeat`,
    `anything already noted above. None is a fine answer, and is the right answer for small talk`,
    `or a question with no lasting content.`,
    ``,
    `Every item needs a "quote" copied EXACTLY, word for word, from the conversation above --`,
    `either something the User actually wrote, or something the Assistant suggested that the User`,
    `then agreed to. In the second case also give "confirmation": the User's own words agreeing to`,
    `it, quoted exactly from their very next message. Never write a quote from your own summary --`,
    `copy it.`,
    ...(notes.length
      ? [
          ``,
          `If the User has changed their mind about a note above, give the new version with "replaces"`,
          `set to that note's number. If they have answered one of the open questions above, set`,
          `"resolves" to its number. Leave both out otherwise.`,
        ]
      : []),
    ``,
    `Reply with JSON only:`,
    `{"proposals": [{"slot": "${MEMORY_SLOTS.join("|")}", "text": "one sentence, your own words",`,
    ` "quote": "copied exactly", "confirmation": "copied exactly, only if quote is the Assistant's"${
      notes.length ? `,\n "replaces": 0, "resolves": 0` : ""
    }}]}`,
  ].join("\n");
}

/**
 * The notes the prompt numbers, in the order it numbers them.
 *
 * One function for both halves -- the prompt that shows `#3` and the code that
 * turns a reply's `"replaces": 3` back into an id -- because two orderings
 * that drift apart would close the wrong note. Current notes only: a model
 * shown a note that was already replaced would propose replacing it again.
 */
export function numberedNotes(memory: ProjectMemory): MemoryItem[] {
  return activeItems(memory);
}

export interface Proposal {
  slot: string;
  text: string;
  quote: string;
  confirmation: string;
  /** The `#n` of a note this one says it replaces, as the model was shown it. */
  replaces?: number;
  /** The `#n` of an open question this one says it answers. */
  resolves?: number;
}

interface RawUpdate {
  proposals?: unknown;
}

/**
 * `undefined` when the reply held no readable JSON at all, which is not the
 * same answer as an empty list: a model that wrote prose, or spent its whole
 * reply reasoning, has not read the conversation and said "nothing here".
 * Treating the two alike moved the watermark past a decision nobody had
 * actually looked at, and the one message of lookback never reached it again.
 */
export function parseProposals(reply: string): Proposal[] | undefined {
  let raw: RawUpdate;
  try {
    raw = parseJsonReply<RawUpdate>(reply, "project memory update");
  } catch {
    return undefined;
  }
  const out: Proposal[] = [];
  for (const entry of Array.isArray(raw.proposals) ? raw.proposals : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      slot?: unknown; text?: unknown; quote?: unknown; confirmation?: unknown; replaces?: unknown; resolves?: unknown;
    };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    if (!text || !quote || !isMemorySlot(row.slot)) continue;
    const replaces = noteNumber(row.replaces);
    const resolves = noteNumber(row.resolves);
    out.push({
      slot: row.slot,
      text,
      quote,
      confirmation: typeof row.confirmation === "string" ? row.confirmation.trim() : "",
      ...(replaces ? { replaces } : {}),
      ...(resolves ? { resolves } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * A note number from a reply: a positive integer, or a string holding one.
 * The schema example shows `0` for "none", and a small model copies it.
 */
function noteNumber(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw.replace(/^#/, "")) : raw;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A proposal that survived grounding, with where it was found.
 *
 * `quote` is what was FOUND, not what the model claimed: for a near-verbatim
 * match it is the line itself, trimmed -- the meeting-notes rule that a
 * model's reconstruction of a quote is never believed over the transcript.
 */
export interface GroundedItem extends NewItem {
  quote: string;
  /** The message index the quote was found in. */
  msg: number;
  replaces?: number;
  resolves?: number;
}

/**
 * Proposals checked against what was actually said, and only what survives.
 *
 * `messages` is the whole conversation, not a slice -- grounding a quote must
 * never depend on exactly where the watermark happened to fall, only on
 * whether the words are really there. `mergeAuto`'s own dedupe is what makes
 * re-checking older messages harmless.
 */
export function groundProposals(proposals: readonly Proposal[], messages: readonly ChatMessage[]): GroundedItem[] {
  const lines = conversationLines(messages);
  const userLines = lines.filter((l) => l.speaker === "user");
  const assistantLines = lines.filter((l) => l.speaker === "assistant");

  const out: GroundedItem[] = [];
  const keep = (p: Proposal, match: QuoteMatch): void => {
    /* `verifyQuote` is typed against the general `Line`, but the object it
       hands back is always one of the `GroundingLine`s it was given. */
    const line = match.line as GroundingLine;
    out.push({
      slot: p.slot as NewItem["slot"],
      text: p.text,
      quote: match.exact ? p.quote : line.text.trim(),
      msg: line.at,
      ...(p.replaces ? { replaces: p.replaces } : {}),
      ...(p.resolves ? { resolves: p.resolves } : {}),
    });
  };

  for (const p of proposals) {
    if (!isMemorySlot(p.slot)) continue;

    const stated = verifyQuote(userLines, p.quote);
    if (stated) {
      keep(p, stated);
      continue;
    }

    if (!p.confirmation) continue;
    const match = verifyQuote(assistantLines, p.quote);
    if (!match) continue;
    const next = nextLine(lines, match.line as GroundingLine);
    if (next && next.speaker === "user" && verifyQuote([next], p.confirmation)) keep(p, match);
  }
  return out;
}

/**
 * Grounded items with their `#n` claims turned into ids, against the same
 * numbering the prompt was built from. A number that names no note is
 * dropped, never guessed at.
 */
export function toAutoItems(memory: ProjectMemory, grounded: readonly GroundedItem[]): AutoItem[] {
  const notes = numberedNotes(memory);
  return grounded.map((g) => ({
    slot: g.slot,
    text: g.text,
    quote: g.quote,
    msg: g.msg,
    replaces: g.replaces ? notes[g.replaces - 1]?.id : undefined,
    resolves: g.resolves ? notes[g.resolves - 1]?.id : undefined,
  }));
}

function nextLine(lines: readonly GroundingLine[], after: GroundingLine): GroundingLine | undefined {
  const idx = lines.indexOf(after);
  return idx === -1 ? undefined : lines[idx + 1];
}

export interface NotePass {
  /** What to write back: the grounded items appended, the watermark moved. */
  memory: ProjectMemory;
  /** The items that were new. Empty is a finished pass that found nothing. */
  added: MemoryItem[];
  /** Automatic notes this pass closed on its own, because a newer one replaced or answered them. */
  closed: MemoryItem[];
}

/**
 * One pass over what was said since the last one: ask, parse, ground, merge.
 *
 * Run by main at the start of every turn in a project that keeps notes, before
 * the reply -- "let's go with X" is saved while the answer to it is being
 * written, not after the conversation has gone quiet. `ask` is the one model
 * call, injected so this whole decision is testable with no model and no disk.
 *
 * `undefined` means leave the memory exactly as it was: nothing new to read,
 * or a reply that could not be read. The second case in particular must not
 * move the watermark -- the next turn's pass reads the same stretch again.
 * A throwing `ask` propagates; main decides that a failed pass never fails
 * the turn it runs in.
 */
export async function notePass(
  memory: ProjectMemory,
  messages: readonly ChatMessage[],
  sessionId: string,
  ask: (prompt: string) => Promise<string>,
  now = new Date(),
): Promise<NotePass | undefined> {
  const since = memory.seen[sessionId] ?? 0;
  if (since >= messages.length) return undefined;
  if (!linesSince(messages, since).some((l) => l.speaker === "user")) return undefined;

  const proposals = parseProposals(await ask(buildUpdatePrompt(memory, messages, since)));
  if (!proposals) return undefined;

  const grounded = toAutoItems(memory, groundProposals(proposals, messages));
  const merged = mergeAuto(memory, grounded, sessionId, messages.length, now);
  const wasActive = new Set(memory.items.filter((it) => it.status === undefined).map((it) => it.id));
  return {
    memory: merged,
    added: merged.items.slice(memory.items.length),
    closed: merged.items.filter((it) => wasActive.has(it.id) && it.status !== undefined),
  };
}
