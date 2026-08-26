/**
 * The agent loop.
 *
 * Send the conversation and the tool schemas, receive either text or tool
 * calls, run the calls through the registry, append the results, repeat until
 * the model answers in prose or the step budget runs out.
 *
 * That is the whole thing, and its smallness is the point. In v1 this job
 * belonged to pi, which brought its own tool set including `bash`; the loop and
 * the capability set were one package and could not be separated. Here they are
 * two files, and this one has no opinion about what the tools are -- it can
 * only call what the registry holds.
 */

import { chat, type ChatMessage, type ChatUsage, type ToolCall } from "../llm/chat.ts";
import type { DeltaKind } from "../llm/thinking.ts";
import type { EndpointSettings } from "../config.ts";
import { UnknownToolError, type ToolRegistry } from "./registry.ts";
import {
  KEEP_SHARE, estimateFixedTokens, estimateTokens, needsCompaction, planCompaction, summaryMessage,
} from "./compact.ts";

/**
 * How many tool rounds one turn may take before it is stopped.
 *
 * Not a safety limit -- the tools are bounded by their own schemas -- but a
 * cost and patience limit. A model that has called search twelve times without
 * answering is stuck in a loop, and letting it run is worse than telling it so.
 */
export const DEFAULT_MAX_STEPS = 12;

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_update" | "tool_end" | "tool_error" | "compacted";
  /** For text: the delta. For tool events: a human-readable note. */
  text?: string;
  /**
   * For text: whether this delta is the answer or the model's reasoning.
   *
   * Absent means answer, so a consumer that does not care about reasoning is
   * unaffected. The reasoning is shown as it arrives and then kept out of the
   * message history -- see ChatResult.reasoning.
   */
  kind?: DeltaKind;
  toolCallId?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
}

export interface AgentTurnOptions {
  registry: ToolRegistry;
  messages: ChatMessage[];
  endpoint: EndpointSettings;
  apiKey?: string;
  system?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Asked before each call. Returning false refuses it.
   *
   * The loop deliberately knows nothing about permission modes or risk classes:
   * it takes a yes-or-no. That keeps the policy in one place and means this
   * file cannot drift out of step with it.
   */
  approve?: (tool: string, params: Record<string, unknown>) => Promise<boolean>;
  /**
   * Tokens one conversation may occupy, when it is knowable.
   *
   * Only the bundled runtime can say, because only it can ask the server it
   * started. Undefined means the meter and the compaction below both stand
   * down -- guessing a limit and summarising against it would rewrite a
   * conversation that was nowhere near full.
   */
  contextLimit?: number;
  /** Occupancy carried in from the previous turn, in tokens. */
  contextUsed?: number;
  /**
   * A summary already made for this conversation, and how much it covers.
   *
   * Carried between turns so the older messages are summarised once rather than
   * again on every turn past the threshold -- which would mean a whole extra
   * model call per message, re-reading the same history each time. `upTo` is an
   * index into `messages`.
   */
  compaction?: { upTo: number; summary: string };
  /** Condense a run of messages into one paragraph. Provided by the host. */
  summarise?: (messages: ChatMessage[]) => Promise<string>;
}

export interface AgentTurnResult {
  /** The assistant's final prose. */
  text: string;
  /** Every message produced this turn, ready to append to the conversation. */
  messages: ChatMessage[];
  usage: ChatUsage;
  steps: number;
  /** True when the step budget stopped the turn rather than the model. */
  exhausted: boolean;
  /**
   * How full the window is now, in tokens: the last reply's prompt plus its
   * output. Not the sum across steps -- that counts the same prompt again for
   * every tool call and would read as far more than the conversation occupies.
   */
  contextTokens: number;
  /** Set when older messages were summarised to make room during this turn. */
  compacted?: { replaced: number; summary: string };
  /** The summary in force, to carry into the next turn. Reuse, do not redo. */
  compaction?: { upTo: number; summary: string };
}

/**
 * Arguments arrive as a JSON string the model wrote, so they can be malformed.
 *
 * A parse failure is reported back to the model as the tool's result rather
 * than thrown: the model can usually fix its own JSON on the next step, and
 * failing the whole turn over a stray comma loses the work done so far.
 */
export function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The tool result message, shaped as the wire format expects. */
export function toolMessage(call: ToolCall, content: string): ChatMessage {
  return {
    role: "tool",
    content,
    tool_call_id: call.id,
    name: call.function.name,
  };
}

export async function runTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const produced: ChatMessage[] = [];
  const usage: ChatUsage = { input: 0, output: 0, total: 0 };
  let steps = 0;

  /*
   * A local copy, because compaction rewrites it.
   *
   * `opts.messages` is the caller's transcript and stays untouched: what is
   * summarised is the request, never the record. The session file and the
   * thread keep every message exactly as it happened, so nothing is destroyed
   * and a larger window later can still use all of it.
   */
  let compaction = opts.compaction;
  /* An existing summary is applied before anything is sent, so a conversation
     that was compacted last turn does not pay for it again this turn. */
  let prior =
    compaction && compaction.upTo > 0 && compaction.upTo <= opts.messages.length
      ? [summaryMessage(compaction.summary, compaction.upTo), ...opts.messages.slice(compaction.upTo)]
      : [...opts.messages];
  let contextTokens = opts.contextUsed ?? 0;
  let compacted: { replaced: number; summary: string } | undefined;
  /* Constant for the turn, and re-serialising 3 kB of schemas on every step of
     every loop would be for nothing. */
  const fixedTokens = estimateFixedTokens(opts.registry.schemas());

  const history = (): ChatMessage[] => [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    ...prior,
    ...produced,
  ];

  /**
   * Summarise the older part of the conversation when it approaches the window.
   *
   * Attempted once per turn. A second attempt inside one turn would mean the
   * summary itself did not free enough room, and summarising a summary loses
   * more than it saves.
   */
  const makeRoom = async (): Promise<void> => {
    if (compacted || !opts.summarise) return;
    /*
     * Measured against what is about to be sent, not against what came back.
     *
     * Occupancy from the last reply cannot see the message the user just typed,
     * so a conversation that was comfortably inside the window one turn ago can
     * still be refused on this one -- and by the time the reply says so, the
     * request has already failed. The estimate is rough; it only has to be
     * right enough to decide whether to summarise.
     */
    const projected = Math.max(contextTokens, estimateTokens(history()) + fixedTokens);
    if (!needsCompaction(projected, opts.contextLimit)) return;

    const plan = planCompaction(prior, Math.floor((opts.contextLimit ?? 0) * KEEP_SHARE));
    if (!plan) return;

    try {
      const summary = await opts.summarise(plan.summarise);
      if (!summary.trim()) return;
      prior = [summaryMessage(summary, plan.summarise.length), ...plan.keep];
      compacted = { replaced: plan.summarise.length, summary };
      /*
       * Expressed against the caller's untouched transcript, not against
       * `prior`: `prior` may already start with a summary standing in for
       * several messages, so its indices do not line up with the real history.
       */
      const covered = opts.messages.length - plan.keep.length;
      compaction = { upTo: covered, summary };
      /*
       * `covered`, not `plan.summarise.length`. On a second pass `prior` already
       * begins with a summary standing in for several messages, so counting the
       * list it was cut from would report three where the reader can see ten.
       */
      opts.onEvent?.({
        type: "compacted",
        text:
          covered === 1
            ? "Summarised the earliest message to make room."
            : `Summarised the earliest ${covered} messages to make room.`,
      });
    } catch {
      /*
       * A failed summary is not a failed turn. The request goes out at its
       * full length and llama.cpp does whatever it does at the limit, which is
       * no worse than the position before this feature existed.
       */
    }
  };

  for (;;) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    await makeRoom();

    const reply = await chat({
      endpoint: opts.endpoint,
      messages: history(),
      tools: opts.registry.schemas(),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onEvent
        ? { onDelta: (d: string, kind: DeltaKind) => opts.onEvent!({ type: "text", text: d, kind }) }
        : {}),
    });

    usage.input += reply.usage.input;
    usage.output += reply.usage.output;
    usage.total += reply.usage.total;
    // Occupancy, not consumption: what this exchange leaves sitting in the
    // window, which is what the next request has to fit alongside.
    contextTokens = reply.usage.input + reply.usage.output;

    const assistant: ChatMessage = {
      role: "assistant",
      content: reply.text,
      ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
    };
    produced.push(assistant);

    if (reply.toolCalls.length === 0) {
      return {
        text: reply.text, messages: produced, usage, steps, exhausted: false,
        contextTokens,
        ...(compacted ? { compacted } : {}),
        ...(compaction ? { compaction } : {}),
      };
    }

    steps++;
    if (steps > maxSteps) {
      // Tell the model, in its own transcript, why it was stopped -- so if the
      // user says "carry on" the next turn starts from a truthful state rather
      // than from a tool call that appears to have silently vanished.
      for (const call of reply.toolCalls) {
        produced.push(
          toolMessage(call, `Stopped: this turn reached its limit of ${maxSteps} tool steps.`),
        );
      }
      return {
        text: reply.text, messages: produced, usage, steps, exhausted: true,
        contextTokens,
        ...(compacted ? { compacted } : {}),
        ...(compaction ? { compaction } : {}),
      };
    }

    for (const call of reply.toolCalls) {
      const name = call.function.name;
      const parsed = parseArguments(call.function.arguments);
      if (!parsed.ok) {
        opts.onEvent?.({ type: "tool_error", tool: name, toolCallId: call.id, text: parsed.error });
        produced.push(
          toolMessage(call, `The arguments were not valid JSON (${parsed.error}). Try again.`),
        );
        continue;
      }

      opts.onEvent?.({ type: "tool_start", tool: name, toolCallId: call.id, params: parsed.value });

      if (opts.approve && !(await opts.approve(name, parsed.value))) {
        // Refusal is a result, not an error: the model is told plainly so it
        // can propose something else rather than retrying the same call.
        const refused = `The user declined to run ${name}.`;
        opts.onEvent?.({ type: "tool_error", tool: name, toolCallId: call.id, text: refused });
        produced.push(toolMessage(call, refused));
        continue;
      }

      try {
        const result = await opts.registry.dispatch(name, parsed.value, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onUpdate: (note: string) =>
            opts.onEvent?.({ type: "tool_update", tool: name, toolCallId: call.id, text: note }),
        });
        opts.onEvent?.({ type: "tool_end", tool: name, toolCallId: call.id, result: result.content });
        produced.push(toolMessage(call, result.content));
      } catch (err) {
        // Every failure goes back to the model as a result, including an
        // unknown tool name. Models hallucinate names, and the useful reply is
        // the list of real ones, not a crashed turn.
        const message =
          err instanceof UnknownToolError
            ? err.message
            : `${name} failed: ${(err as Error).message}`;
        opts.onEvent?.({ type: "tool_error", tool: name, toolCallId: call.id, text: message });
        produced.push(toolMessage(call, message));
      }
    }
  }
}
