/**
 * `remember`: the model writing one note into its research project's memory.
 *
 * The automatic pass ([main/projectMemory.ts](../../../main/projectMemory.ts))
 * runs before every reply and is what reliably catches "let's go with X" --
 * code runs it, so no model can decline to. This tool is the second chance:
 * an explicit "remember that…" the pass judged not worth a note, caught by the
 * model answering it. The prompt tells it the pass has already run, because a
 * model saving the same decision again in new words is a duplicate the
 * exact-text dedupe cannot see.
 *
 * **The grounding is the automatic pass's own, not a second opinion.** A
 * note is kept only when its `quote` is something the user wrote, or something
 * the assistant proposed that the user's very next message agreed to --
 * `groundProposals` decides, over the same untrusted-stripped lines. That is
 * what stops a fetched page or a dropped document from asking the model to
 * "remember" something on its behalf: text that lived only inside an untrusted
 * block can never be the quote a note rests on, so injection can reach this
 * tool but cannot get past it.
 *
 * `write` rather than `safe`: it changes a file. The file is MyRA's own and
 * the change is an append the user can edit or delete from the project page,
 * which is the case `tasks.ts` argues for `write` in full.
 */

import type { ChatMessage } from "../../llm/chat.ts";
import { actsLocally, readResearchConfig } from "../../research/config.ts";
import { isMemorySlot, MEMORY_SLOTS, SLOT_LABELS, type AutoItem } from "../../projects/memory.ts";
import { groundProposals } from "../../projects/memoryUpdate.ts";
import type { ToolDef } from "../registry.ts";

/**
 * What main attaches for the length of one turn.
 *
 * `current` answers only inside a conversation filed to a research project
 * whose notes may grow on their own -- a simple folder has no memory to write
 * into, and a project whose owner switched automatic notes off has said no to
 * exactly this. Outside that, the tool is not offered at all.
 */
export interface MemoryToolHost {
  current(): { projectId: string; sessionId: string; messages: readonly ChatMessage[] } | undefined;
  /** Saves grounded items and returns how many were new (a duplicate adds nothing). */
  save(projectId: string, sessionId: string, items: readonly AutoItem[]): Promise<number>;
}

let host: MemoryToolHost | undefined;

export function setMemoryToolHost(installed: MemoryToolHost | undefined): void {
  host = installed;
}

function available(): boolean {
  return actsLocally(readResearchConfig().mode) && host?.current() !== undefined;
}

export const rememberTool: ToolDef = {
  name: "remember",
  description:
    "Save one note to the notes of the research project this conversation belongs to, so every " +
    "later conversation in the project starts out knowing it. Use it when the user asks you to " +
    "remember something lasting about the project -- a research question, an aim, a guiding " +
    "theory, a method, a decision, a key paper, an open question, or useful background -- that is not in its " +
    "notes yet. What the user settles is noted automatically before you reply, so never save the " +
    "same thing again. Not for small talk, and not for a one-off request about this reply. `note` is one " +
    "sentence in your own words. `quote` is the user's own words the note rests on, copied " +
    "exactly from one of their messages -- a note whose quote the user did not write is refused. " +
    "If the note is something YOU suggested and the user agreed to, `quote` is your suggestion " +
    "copied exactly and `confirmation` is the user's reply agreeing to it, copied exactly.",
  risk: "write",
  enabled: available,
  parameters: {
    type: "object",
    properties: {
      slot: {
        type: "string",
        enum: [...MEMORY_SLOTS],
        description:
          "Where the note belongs: questions, aims, theory, methods, decisions, literature (a key paper or " +
          "author the project builds on), open (open questions) or context",
      },
      note: { type: "string", description: "One sentence, in your words" },
      quote: { type: "string", description: "Copied exactly from the user's message (or from your suggestion they agreed to)" },
      confirmation: {
        type: "string",
        description: "Only when `quote` is your own suggestion: the user's reply agreeing to it, copied exactly",
      },
    },
    required: ["slot", "note", "quote"],
    additionalProperties: false,
  },
  async handler(params) {
    const current = host?.current();
    if (!host || !current) {
      return { content: "This conversation is not in a research project that keeps notes, so there is nowhere to save this." };
    }
    const slot = params["slot"];
    const note = typeof params["note"] === "string" ? params["note"].trim() : "";
    const quote = typeof params["quote"] === "string" ? params["quote"].trim() : "";
    const confirmation = typeof params["confirmation"] === "string" ? params["confirmation"].trim() : "";
    if (!isMemorySlot(slot)) {
      return { content: `\`slot\` must be one of: ${MEMORY_SLOTS.join(", ")}.` };
    }
    if (!note || !quote) {
      return { content: "Both `note` and `quote` are needed: the note, and the user's own words it rests on." };
    }

    const grounded = groundProposals([{ slot, text: note, quote, confirmation }], current.messages);
    if (!grounded.length) {
      /* Returned rather than thrown, and specific, because the model acts on
         it: the useful retry is the user's exact words, or asking first. */
      return {
        content:
          "Not saved: that quote was not found in anything the user wrote in this conversation. " +
          "Copy the user's own words exactly into `quote`. If the note is your own suggestion, ask " +
          "the user whether to keep it, and once they agree pass your suggestion as `quote` and " +
          "their reply as `confirmation`.",
      };
    }

    /* The quote and where it was found travel with the note; a `replaces`
       claim cannot, since this tool shows the model no numbered notes. */
    const added = await host.save(
      current.projectId,
      current.sessionId,
      grounded.map((g) => ({ slot: g.slot, text: g.text, quote: g.quote, msg: g.msg })),
    );
    return added
      ? {
          content:
            `Saved to this project's notes under ${SLOT_LABELS[slot]}: "${grounded[0]!.text}". ` +
            "The user can edit or remove it from the project page. Mention briefly that you noted it.",
          detail: { slot, note: grounded[0]!.text },
        }
      : { content: "That is already in this project's notes; nothing new was saved." };
  },
};

export const MEMORY_TOOL_DEFS: ToolDef[] = [rememberTool];
