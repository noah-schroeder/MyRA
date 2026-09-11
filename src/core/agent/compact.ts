/**
 * Making room in the context window without losing the conversation.
 *
 * A model has a fixed window. Past it, llama.cpp either truncates from the
 * front -- silently dropping whatever was said first, including the system
 * prompt's effect -- or refuses the request. Neither is something a person
 * should have to know about, so the assistant summarises the older part of the
 * conversation and carries the summary forward instead.
 *
 * Two rules make this safe rather than merely clever:
 *
 *   **Compact the request, never the transcript.** The session file and the
 *   thread on screen keep every message exactly as it happened. Only the list
 *   sent to the model is shortened, so nothing is destroyed, the user can still
 *   read what was said, and a longer window later means the full history is
 *   still there to use.
 *
 *   **Never orphan a tool result.** A `tool` message without the `assistant`
 *   message carrying its `tool_call_id` is a protocol error, and most servers
 *   reject the whole request rather than the stray message. The split point is
 *   therefore chosen by walking backwards to a boundary where no result is left
 *   without its call.
 */

import type { ChatMessage } from "../llm/chat.ts";
import { IMAGE_TOKEN_ESTIMATE } from "../llm/attach.ts";

/** Compact once the conversation passes this share of the window. */
export const COMPACT_AT = 0.75;

/**
 * How much of the window the untouched recent messages may occupy.
 *
 * A *share of the window*, not a number of messages. Counting messages looks
 * reasonable and fails on the case that matters: three long pastes can fill an
 * 8k window between them, and a rule of "keep the last six" then finds nothing
 * it is allowed to summarise -- so the conversation dies at the limit with the
 * feature that exists to prevent it looking on. Measured in tokens, the same
 * rule handles both a hundred short turns and three enormous ones.
 */
export const KEEP_SHARE = 0.4;

/**
 * Messages never summarised, however large.
 *
 * One, not two, and the difference is not fussiness. Two keeps the last
 * exchange verbatim -- what was asked and what was answered -- which is what
 * you want whenever it fits, and the budget above keeps it whenever it does.
 * But an assistant reply can be enormous on its own: a model that does not stop
 * cleanly, or a long synthesis. Forcing such a reply to be kept meant the
 * request stayed over the limit *after* summarising everything else, so the
 * conversation failed anyway with the summary already paid for. Observed
 * exactly that: three messages summarised, and 6,498 tokens still offered to a
 * 4,096-token window.
 *
 * So the floor is the message the user is waiting on an answer to. Everything
 * else earns its place by fitting.
 */
export const MIN_KEEP = 1;

export interface CompactionPlan {
  /** Messages to replace with a summary, oldest first. */
  summarise: ChatMessage[];
  /** Messages carried through untouched. */
  keep: ChatMessage[];
}

/**
 * Roughly how many tokens a message list will occupy.
 *
 * Four characters to a token is the usual English approximation, and this is
 * only ever used to decide *whether* to summarise -- the authoritative figure
 * comes back with each reply. It has to exist because the true count is only
 * known after a request, and a request that was already too long has already
 * failed by then. Deciding from what is about to be sent is the difference
 * between compacting in time and explaining an error afterwards.
 *
 * Deliberately slightly pessimistic: compacting a little early costs one
 * summary, while compacting a little late costs the whole request.
 */
const CHARS_PER_TOKEN = 3.6;
/** Per-message envelope: role, delimiters, and the tool-call scaffolding. */
const MESSAGE_OVERHEAD = 4;

/**
 * The part of every request that is not the conversation.
 *
 * Tool schemas go out with each call and are not small: Karen's seven tools are
 * about a thousand tokens of JSON, on top of roughly two hundred for the system
 * prompt. Leaving them out of the estimate made compaction fire twelve hundred
 * tokens too late -- which on a small window is the difference between summarising
 * in time and being refused. Found by watching a compacted request still exceed a
 * 2,048-token window by more than the messages could account for.
 */
export function estimateFixedTokens(tools: unknown): number {
  if (!tools) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const call of m.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length;
    }
    /* `content` stays a string in a stored message -- see attach.ts -- so an
       image never shows up in `chars` at all, and would otherwise look free. */
    images += (m.attachments ?? []).filter((a) => a.kind === "image").length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + messages.length * MESSAGE_OVERHEAD + images * IMAGE_TOKEN_ESTIMATE;
}

/** True once the conversation is close enough to the window to act. */
export function needsCompaction(usedTokens: number, contextTokens: number | undefined, at = COMPACT_AT): boolean {
  if (!contextTokens || contextTokens <= 0) return false;
  return usedTokens >= contextTokens * at;
}

/**
 * A message that cannot be separated from the one before it.
 *
 * `tool` results belong to the assistant message that requested them. An
 * assistant message that made tool calls likewise cannot be the last thing
 * kept, because its results would be left behind on the other side.
 */
function isToolResult(message: ChatMessage): boolean {
  return message.role === "tool";
}

/**
 * Choose where to cut.
 *
 * Walks back from the newest message, keeping them until they have used up
 * `keepTokens`, then cuts. The boundary is then moved earlier if it would
 * separate a tool result from the assistant message that called it -- that
 * pairing is a protocol error, and servers reject the entire request over it
 * rather than the stray message.
 *
 * Returns undefined when there is nothing to gain: a conversation short enough
 * that everything is being kept anyway.
 */
export function planCompaction(
  messages: ChatMessage[],
  keepTokens: number,
): CompactionPlan | undefined {
  if (messages.length <= MIN_KEEP) return undefined;

  let split = messages.length;
  let kept = 0;
  /* Down to and including index 0: a conversation that fits in the budget
     entirely must reach split = 0 and be refused below, or every conversation
     would have its first message summarised whether or not that helped. */
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = estimateTokens([messages[i]!]);
    // The floor wins over the budget only for the newest message: summarising
    // the thing the user is waiting on an answer to would be absurd. Anything
    // older has to fit.
    const withinFloor = messages.length - i <= MIN_KEEP;
    if (!withinFloor && kept + size > keepTokens) break;
    kept += size;
    split = i;
  }

  /*
   * Pairing beats the budget, deliberately.
   *
   * Both adjustments move the boundary earlier, which keeps *more* than the
   * budget allowed for -- but the alternative is a request the server rejects
   * outright, and being a little over is recoverable where being invalid is
   * not. A tool result at the boundary would lose the assistant message that
   * called it, so move the boundary until the pair is on the same side.
   */
  while (split > 0 && isToolResult(messages[split]!)) split--;
  // An assistant message whose tool calls are answered after the split has the
  // same problem in reverse.
  while (split > 0 && messages[split - 1]?.tool_calls?.length) split--;

  if (split <= 0) return undefined;
  return { summarise: messages.slice(0, split), keep: messages.slice(split) };
}

/**
 * What the summariser is asked to read.
 *
 * Tool results are included but truncated: a 40 kB page fetch is what filled
 * the window in the first place, and re-sending it whole to be summarised would
 * be its own context problem.
 */
const TOOL_EXCERPT = 600;

export function transcriptFor(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        const body = (m.content ?? "").slice(0, TOOL_EXCERPT);
        return `[result of ${m.name ?? "a tool"}] ${body}`;
      }
      const calls = m.tool_calls?.map((c) => c.function.name).join(", ");
      const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role;
      const body = m.content ?? "";
      return calls ? `${prefix}: ${body} [used ${calls}]` : `${prefix}: ${body}`;
    })
    .join("\n\n");
}

export const SUMMARY_SYSTEM =
  "You are compressing the earlier part of a conversation so it can be carried forward in a " +
  "smaller context window. Write a factual summary in the third person. Preserve: what the user " +
  "asked for, decisions made, facts established, file paths, names, numbers, and anything the " +
  "user asked to be remembered. Preserve any citation markers such as [1] and the sources they " +
  "refer to. Do not add anything that was not said, do not offer opinions, and do not address " +
  "the user. If something was left unresolved, say so explicitly.";

export function summaryPrompt(messages: ChatMessage[]): string {
  return `Summarise this earlier part of the conversation:\n\n${transcriptFor(messages)}`;
}

/**
 * The message that stands in for what was summarised.
 *
 * `user` rather than `system`: a second system message part-way through a
 * conversation is treated inconsistently across servers, and some templates
 * drop all but the first. A labelled user message is understood everywhere.
 */
export function summaryMessage(summary: string, count: number): ChatMessage {
  return {
    role: "user",
    content:
      `[Summary of ${count} earlier message${count === 1 ? "" : "s"} in this conversation, ` +
      `condensed to save space. Treat it as established context.]\n\n${summary}`,
  };
}
