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
import { verifyQuote } from "../meetings/transcript.ts";
import {
  conversationLines, isMemorySlot, MEMORY_SLOTS, SLOT_LABELS,
  type GroundingLine, type NewItem, type ProjectMemory,
} from "./memory.ts";

/**
 * The prompt reads from one message before the watermark, not from it --
 * a single message of lookback, so an assistant proposal the user is about
 * to confirm is still in view even though it was "already seen" the last
 * time this ran (nothing was extracted from it then, because nothing had
 * confirmed it yet).
 */
export function buildUpdatePrompt(
  memory: ProjectMemory,
  messages: readonly ChatMessage[],
  since: number,
): string {
  const from = Math.max(0, since - 1);
  const lines = conversationLines(messages).filter((l) => l.at >= from);
  const known = memory.items.length
    ? `Already noted about this project:\n${memory.items.map((i) => `- (${SLOT_LABELS[i.slot]}) ${i.text}`).join("\n")}\n\n`
    : "";
  const transcript = lines.map((l) => `${l.speaker === "user" ? "User" : "Assistant"}: ${l.text}`).join("\n\n");

  return [
    `${known}Part of a conversation in this project:`,
    ``,
    transcript || "(nothing new)",
    ``,
    `Is there anything here worth remembering about the PROJECT itself -- not this one message,`,
    `something that would still matter in a different conversation in the same project? An aim, a`,
    `research question, a theory being used, a method decided on, a decision made, something left`,
    `open, or useful background. Do not repeat anything already noted above. None is a fine answer,`,
    `and is the right answer for small talk or a question with no lasting content.`,
    ``,
    `Every item needs a "quote" copied EXACTLY, word for word, from the conversation above --`,
    `either something the User actually wrote, or something the Assistant suggested that the User`,
    `then agreed to. In the second case also give "confirmation": the User's own words agreeing to`,
    `it, quoted exactly from their very next message. Never write a quote from your own summary --`,
    `copy it.`,
    ``,
    `Reply with JSON only:`,
    `{"proposals": [{"slot": "${MEMORY_SLOTS.join("|")}", "text": "one sentence, your own words",`,
    ` "quote": "copied exactly", "confirmation": "copied exactly, only if quote is the Assistant's"}]}`,
  ].join("\n");
}

export interface Proposal {
  slot: string;
  text: string;
  quote: string;
  confirmation: string;
}

interface RawUpdate {
  proposals?: unknown;
}

export function parseProposals(reply: string): Proposal[] {
  let raw: RawUpdate;
  try {
    raw = parseJsonReply<RawUpdate>(reply, "project memory update");
  } catch {
    return [];
  }
  const out: Proposal[] = [];
  for (const entry of Array.isArray(raw.proposals) ? raw.proposals : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { slot?: unknown; text?: unknown; quote?: unknown; confirmation?: unknown };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    if (!text || !quote || !isMemorySlot(row.slot)) continue;
    out.push({
      slot: row.slot,
      text,
      quote,
      confirmation: typeof row.confirmation === "string" ? row.confirmation.trim() : "",
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Proposals checked against what was actually said, and only what survives.
 *
 * `messages` is the whole conversation, not a slice -- grounding a quote must
 * never depend on exactly where the watermark happened to fall, only on
 * whether the words are really there. `mergeAuto`'s own dedupe is what makes
 * re-checking older messages harmless.
 */
export function groundProposals(proposals: readonly Proposal[], messages: readonly ChatMessage[]): NewItem[] {
  const lines = conversationLines(messages);
  const userLines = lines.filter((l) => l.speaker === "user");
  const assistantLines = lines.filter((l) => l.speaker === "assistant");

  const out: NewItem[] = [];
  for (const p of proposals) {
    if (!isMemorySlot(p.slot)) continue;

    if (verifyQuote(userLines, p.quote)) {
      out.push({ slot: p.slot, text: p.text });
      continue;
    }

    if (!p.confirmation) continue;
    const match = verifyQuote(assistantLines, p.quote);
    if (!match) continue;
    /* `verifyQuote` is typed against the general `Line`, but the object it
       hands back is always one of the `GroundingLine`s it was given --
       `assistantLines` never holds anything else. */
    const next = nextLine(lines, match.line as GroundingLine);
    if (next && next.speaker === "user" && verifyQuote([next], p.confirmation)) {
      out.push({ slot: p.slot, text: p.text });
    }
  }
  return out;
}

function nextLine(lines: readonly GroundingLine[], after: GroundingLine): GroundingLine | undefined {
  const idx = lines.indexOf(after);
  return idx === -1 ? undefined : lines[idx + 1];
}
