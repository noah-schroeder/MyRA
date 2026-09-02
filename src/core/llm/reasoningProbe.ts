/**
 * Asking a provider, directly, whether it sends the model's reasoning.
 *
 * "Why can't I see the reasoning?" has four possible answers and no way to tell
 * them apart from the outside: the model did not reason; the provider does not
 * send it; the provider sends it only when asked; or Karen is not reading the
 * field it arrives in. Guessing between those produces confident, wrong advice.
 *
 * So Karen asks. One small request, a fixed prompt with no user content in it,
 * and a report of what came back -- field names, not text. The report is the
 * thing: it turns an argument about what some API "should" do into a fact about
 * what this endpoint actually did.
 *
 * Nothing here is logged or stored. The reply is inspected in memory, counted,
 * and dropped.
 */

import { buildRequest, chatUrl, LlmError } from "./chat.ts";
import type { EndpointSettings } from "../config.ts";

/**
 * The documented ways to ask for reasoning, sent together.
 *
 * `reasoning` is OpenRouter's switch. `google` is what the OpenAI SDK's
 * `extra_body` produces against Gemini's OpenAI-compatible endpoint, which
 * withholds the thought summary unless it is asked for.
 *
 * Sent ONLY to a provider that has been probed and answered better with them
 * than without: a strict server rejects unknown top-level parameters outright,
 * and a chat that 400s is far worse than a chat with no reasoning shown.
 */
export const ASK_FOR_REASONING: Record<string, unknown> = {
  reasoning: { enabled: true },
  google: { thinking_config: { include_thoughts: true } },
};

/** A question that takes a moment's thought and no context to answer. */
export const PROBE_PROMPT =
  "Think it through step by step, then answer: a shelf holds 17 boxes of 23 pens. How many pens?";

export interface ProbeReport {
  /** Did the request itself succeed? */
  ok: boolean;
  error?: string;
  /** The status, when the endpoint refused. */
  status?: number;
  /** Reasoning fields Karen reads that actually arrived. */
  read: string[];
  /**
   * Fields that look like reasoning and that Karen does NOT read.
   *
   * The reason this whole probe is worth having: a provider naming its
   * reasoning something nobody else does is invisible otherwise, and shows up
   * only as "this model does not seem to think".
   */
  unread: string[];
  /** `<think>` or `<thinking>` in the answer text. */
  inline: boolean;
  /** How much reasoning text arrived, in characters. Never the text itself. */
  chars: number;
  /** What the usage block said was spent reasoning. */
  reasoningTokens: number;
}

/** Field names Karen already reads, in the order chat.ts tries them. */
const KNOWN = ["reasoning_content", "reasoning", "reasoning_details", "thinking", "thinking_blocks"];

/** Anything else whose name suggests it carries reasoning. */
const SUSPECT = /reason|think|thought|analysis|deliberat/i;

/** How much text sits under a key, however it is nested. Never the text. */
function lengthOf(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (depth > 3) return 0;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + lengthOf(v, depth + 1), 0);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (n, v) => n + lengthOf(v, depth + 1),
      0,
    );
  }
  return 0;
}

/**
 * What one delta or message object says about reasoning.
 *
 * Accumulated into the report rather than returned, because a stream is many of
 * these and the question is what the reply carried overall.
 */
export function inspect(node: unknown, into: ProbeReport): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "content" || key === "tool_calls" || key === "role") continue;
    const known = KNOWN.includes(key);
    if (!known && !SUSPECT.test(key)) continue;
    const chars = lengthOf(value);
    if (chars === 0) continue;
    const list = known ? into.read : into.unread;
    if (!list.includes(key)) list.push(key);
    if (known) into.chars += chars;
  }
}

const INLINE = /<think>|<thinking>/i;

/**
 * One probe request, streamed, inspected, and thrown away.
 *
 * Streaming deliberately: several providers send reasoning only on the
 * streaming path, so a probe that asked for a whole response could report "no
 * reasoning" about an endpoint that streams it perfectly well.
 */
export async function probeReasoning(opts: {
  endpoint: EndpointSettings;
  apiKey?: string;
  /** Extra request fields to try, i.e. asking for reasoning. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ProbeReport> {
  const report: ProbeReport = {
    ok: false, read: [], unread: [], inline: false, chars: 0, reasoningTokens: 0,
  };

  let res: Response;
  try {
    res = await fetch(chatUrl(opts.endpoint.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(
        buildRequest({
          ...(opts.endpoint.model ? { model: opts.endpoint.model } : {}),
          messages: [{ role: "user", content: PROBE_PROMPT }],
          stream: true,
          ...(opts.extra ? { extra: opts.extra } : {}),
        }),
      ),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    report.error = `Could not reach ${opts.endpoint.baseUrl}: ${(err as Error).message}`;
    return report;
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300).trim();
    report.status = res.status;
    report.error = `${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`;
    return report;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    report.error = "The endpoint returned no response body.";
    return report;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const choice = (frame["choices"] as { delta?: unknown; message?: unknown }[] | undefined)?.[0];
        inspect(choice?.delta, report);
        inspect(choice?.message, report);
        const delta = choice?.delta as { content?: unknown } | undefined;
        if (typeof delta?.content === "string") answer += delta.content;
        const usage = frame["usage"] as
          | { completion_tokens_details?: { reasoning_tokens?: unknown } }
          | undefined;
        const spent = usage?.completion_tokens_details?.reasoning_tokens;
        if (typeof spent === "number" && spent > report.reasoningTokens) {
          report.reasoningTokens = spent;
        }
      }
    }
  }
  report.ok = true;
  report.inline = INLINE.test(answer);
  return report;
}

/**
 * The report in words, and only words the report supports.
 *
 * Each branch says what was observed and what follows from it. None of them
 * says "the model does not reason", because that is not something this can see:
 * a provider that sends nothing and reports no tokens is a provider that told
 * Karen nothing either way.
 */
export function describeProbe(plain: ProbeReport, asked?: ProbeReport): string {
  if (!plain.ok && !asked?.ok) {
    return `The endpoint did not answer the test request: ${plain.error ?? "no reason given"}`;
  }
  const best = plain.read.length || plain.inline ? plain : (asked?.read.length || asked?.inline ? asked : plain);
  const viaAsking = best === asked && best !== plain;

  if (best.unread.length) {
    return (
      `This provider sent its reasoning in ${best.unread.map((f) => `“${f}”`).join(", ")}, which ` +
      `Karen does not read yet${best.read.length ? ", alongside fields it does" : ""}. ` +
      "Report that field name — it is a shape worth adding."
    );
  }
  if (best.read.length) {
    return (
      `Reasoning arrived in “${best.read.join("”, “")}” (${best.chars.toLocaleString()} characters)` +
      (viaAsking
        ? ", but only when Karen asked for it. Asking has been turned on for this provider."
        : ". Karen shows this as the Reasoning block above each answer.")
    );
  }
  if (best.inline) {
    return "The reasoning came inline, in <thinking> tags. Karen separates those from the answer.";
  }
  if (best.reasoningTokens > 0) {
    return (
      `This provider reported ${best.reasoningTokens.toLocaleString()} reasoning tokens and sent ` +
      "none of the text. It reasons and withholds the chain, so there is nothing for Karen to " +
      "show — Karen says so in the conversation when it happens."
    );
  }
  return (
    "No reasoning of any kind came back, and the reply reported no reasoning tokens" +
    (asked ? ", with or without asking for it" : "") +
    ". Either this model does not reason, or this endpoint does not pass it on."
  );
}
