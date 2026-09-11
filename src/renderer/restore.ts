/**
 * Rebuilding a rendered thread from a stored conversation.
 *
 * The two forms are genuinely different shapes, which is why this is a file
 * rather than a map(). What is stored is the model's message list: an assistant
 * message carries `tool_calls`, and each result comes back later as a separate
 * `tool` message keyed by `tool_call_id`. What is rendered is a sequence of
 * cards in the order they happened, each already knowing its own outcome.
 *
 * Two things this must get right, because getting them subtly wrong is worse
 * than not doing it at all:
 *
 *  1. **A tool call and its result must be reunited.** They are separate
 *     messages, and a run that was interrupted leaves a call with no result at
 *     all -- which is a real state to render, not an error.
 *  2. **Citations must come back.** The [n] markers live in the assistant's
 *     prose, but the sources they point at were only ever in the tool output.
 *     Without harvesting those, a reopened conversation shows numbered markers
 *     that resolve to nothing.
 */

import type { CitedSource, Item, MessageStats, ToolItem } from "./types.ts";

/** The stored shape. Mirrors ChatMessage in core, which the renderer cannot import. */
export interface StoredMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
  meta?: MessageStats;
  /** Image references on a user message. Never the bytes -- see core/llm/attach.ts. */
  attachments?: { kind: "image" | "document"; name: string }[];
}

export interface Restored {
  items: Item[];
  sources: Map<number, CitedSource>;
}

/**
 * Sources a tool reported, in the format formatHits writes.
 *
 * Shared with the live path in useAgent, so a restored thread and a live one
 * resolve their citations identically -- if these ever diverge, reopening a
 * conversation would quietly renumber it.
 */
export function harvestSources(output: string | undefined): CitedSource[] {
  if (!output) return [];
  const found: CitedSource[] = [];
  const pattern = /^\[(\d+)\]\s+(.*)\n\s+(https?:\/\/\S+)/gm;
  for (const m of output.matchAll(pattern)) {
    found.push({ n: Number(m[1]), title: m[2]!.trim(), url: m[3]! });
  }
  return found;
}

/** Tool arguments were stored as the JSON string the model wrote. */
function argsOf(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // The model wrote it, so it can be malformed. The card still shows what
    // ran; only the parameter list is lost.
    return {};
  }
}

/**
 * A tool result that reads as a failure.
 *
 * Failures were fed back to the model as ordinary results rather than thrown,
 * so nothing in the stored form marks them. These prefixes are the ones the
 * registry and the loop actually produce, matched at the start of the message
 * so a paper whose abstract happens to contain the word "failed" is not
 * mistaken for one.
 */
function looksLikeFailure(output: string): boolean {
  return (
    /^There is no tool named /.test(output) ||
    /^The tool "[^"]*" is not enabled/.test(output) ||
    /^The arguments were not valid JSON/.test(output) ||
    /^Stopped: this turn reached its limit/.test(output) ||
    /^[a-z_]+ failed: /.test(output)
  );
}

let seq = 0;
const nextId = (): string => `r${++seq}`;

export function restoreThread(messages: StoredMessage[]): Restored {
  // Results first: a call is rendered when it is seen, and its result appears
  // later in the list, so a single forward pass would always render it pending.
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m.content ?? "");
  }

  const items: Item[] = [];
  const sources = new Map<number, CitedSource>();

  for (const m of messages) {
    // The system prompt is ours, not the conversation's, and showing it would
    // be both noise and a leak of wording the user never wrote.
    if (m.role === "system" || m.role === "tool") continue;

    if (m.role === "user") {
      // An attachment-only turn (an image with no caption) has empty content,
      // which used to be the only thing this guard checked -- so the whole
      // turn vanished on reopen, image included, even though it was still
      // stored and still sent to the model on the next turn.
      if (m.content?.trim() || m.attachments?.length) {
        items.push({
          id: nextId(),
          kind: "user",
          text: m.content,
          ...(m.attachments?.length
            ? { attachments: m.attachments.map((a) => ({ kind: a.kind, name: a.name })) }
            : {}),
        });
      }
      continue;
    }

    if (m.content?.trim()) {
      items.push({
        id: nextId(),
        kind: "assistant",
        blocks: [{ kind: "text", text: m.content }],
        streaming: false,
        ...(m.meta ? { stats: m.meta } : {}),
      });
    }

    for (const call of m.tool_calls ?? []) {
      const output = results.get(call.id);
      const card: ToolItem = {
        id: nextId(),
        kind: "tool",
        toolCallId: call.id,
        name: call.function.name,
        args: argsOf(call.function.arguments),
        output: output ?? "",
        // No result means the run was interrupted -- the app closed mid-turn.
        // Rendering that as "ok" would claim something that never finished.
        status: output === undefined ? "error" : looksLikeFailure(output) ? "error" : "ok",
      };
      if (output === undefined) card.output = "This call did not finish.";
      items.push(card);
      for (const source of harvestSources(output)) sources.set(source.n, source);
    }
  }

  return { items, sources };
}
