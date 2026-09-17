/**
 * What day it is, unconditionally.
 *
 * One line, and the whole reason the task tools work at all: "tomorrow" is a
 * question the model answers, not one MyRA parses (see core/time.ts's
 * `normaliseDay`, which accepts only what the model is told to send back), so
 * the arithmetic needs an origin. Without this a model asked to make a task
 * for tomorrow either refuses, invents a date from its training cutoff, or
 * spends a whole tool call finding out -- and the third costs a round trip
 * for a fact that costs eight words.
 *
 * Unconditional, unlike spokenGuidance and the rung closings it sits beside
 * in systemPrompt.ts: there is no rung at which it is wrong to know the date,
 * and a fact that is sometimes absent is a fact the model learns not to rely
 * on.
 *
 * The LOCAL clock, for the reason every id stamp in this app already uses it:
 * the person reading the answer is looking at their own calendar, not UTC's.
 * Returned as lines and never empty, so the caller splices it unconditionally
 * -- the same shape `spokenGuidance` returns.
 */
export function todayLine(now: Date = new Date()): string[] {
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(now);
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  return [`Today is ${weekday}, ${date}.`];
}
