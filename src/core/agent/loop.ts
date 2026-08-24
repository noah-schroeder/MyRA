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
import type { EndpointSettings } from "../config.ts";
import { UnknownToolError, type ToolRegistry } from "./registry.ts";

/**
 * How many tool rounds one turn may take before it is stopped.
 *
 * Not a safety limit -- the tools are bounded by their own schemas -- but a
 * cost and patience limit. A model that has called search twelve times without
 * answering is stuck in a loop, and letting it run is worse than telling it so.
 */
export const DEFAULT_MAX_STEPS = 12;

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_update" | "tool_end" | "tool_error";
  /** For text: the delta. For tool events: a human-readable note. */
  text?: string;
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

  const history = (): ChatMessage[] => [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    ...opts.messages,
    ...produced,
  ];

  for (;;) {
    if (opts.signal?.aborted) throw new Error("cancelled");

    const reply = await chat({
      endpoint: opts.endpoint,
      messages: history(),
      tools: opts.registry.schemas(),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onEvent
        ? { onDelta: (d: string) => opts.onEvent!({ type: "text", text: d }) }
        : {}),
    });

    usage.input += reply.usage.input;
    usage.output += reply.usage.output;
    usage.total += reply.usage.total;

    const assistant: ChatMessage = {
      role: "assistant",
      content: reply.text,
      ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
    };
    produced.push(assistant);

    if (reply.toolCalls.length === 0) {
      return { text: reply.text, messages: produced, usage, steps, exhausted: false };
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
      return { text: reply.text, messages: produced, usage, steps, exhausted: true };
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
