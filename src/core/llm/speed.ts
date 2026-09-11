/**
 * One reply's speed, in the shape the message footer shows.
 *
 * `chat.ts` hands back a `ChatUsage` (token counts) and a `ChatTiming` (the
 * clock) separately, because one is the server's arithmetic and the other is
 * either the server's own `timings` object or this app's wall clock standing
 * in for it. This is where the two are combined into the numbers a person
 * reads, and it is deliberately conservative: a rate this app did not measure
 * honestly is not printed, not estimated from a token count nobody sent.
 */

import type { ChatTiming, ChatUsage } from "./chat.ts";

export interface MessageStats {
  promptTokens: number;
  completionTokens: number;
  /** Generation speed. Undefined when there were no completion tokens to divide by. */
  tokensPerSecond?: number;
  /** Prompt-processing speed, when the numbers allow it. */
  promptPerSecond?: number;
  ttftMs?: number;
  totalMs: number;
  /** False when the split between prefill and generation is time-to-first-token, our estimate. */
  measured: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Combine what the server said it did with how long it took.
 *
 * `timing` is absent only for the non-streaming subagent path
 * (`readWhole`), which nothing shows stats for -- so this returns nothing
 * rather than a half-built record with no wall clock behind it at all.
 */
export function statsFrom(usage: ChatUsage, timing: ChatTiming | undefined): MessageStats | undefined {
  if (!timing) return undefined;
  const { totalMs, ttftMs, promptMs, predictedMs, measured } = timing;

  /* Generation time: the server's own figure when it sent one, otherwise
     everything after the first token arrived. Excludes prompt processing
     deliberately -- the same call core/api/log.ts's tokensPerSecond makes, so
     a long prompt does not read as a slow model. */
  const generatingMs = predictedMs ?? (ttftMs !== undefined ? totalMs - ttftMs : undefined);
  const tokensPerSecond =
    usage.output > 0 && generatingMs !== undefined && generatingMs > 0
      ? round1((usage.output / generatingMs) * 1000)
      : undefined;

  /* Prompt time: the server's figure, or time-to-first-token as an estimate --
     which also counts queueing and network, so it only stands in when nothing
     better was sent. */
  const promptTimeMs = promptMs ?? ttftMs;
  const promptPerSecond =
    usage.input > 0 && promptTimeMs !== undefined && promptTimeMs > 0
      ? round1((usage.input / promptTimeMs) * 1000)
      : undefined;

  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    ...(promptPerSecond !== undefined ? { promptPerSecond } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    totalMs,
    measured,
  };
}

/** The one-line footer. Falls back to elapsed time when there is no rate to show. */
export function formatSpeed(stats: MessageStats): string {
  return stats.tokensPerSecond !== undefined
    ? `${stats.tokensPerSecond.toFixed(1)} tok/s`
    : `${(stats.totalMs / 1000).toFixed(1)}s`;
}
