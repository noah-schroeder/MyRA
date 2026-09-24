/**
 * How far along a model call is, while it is still running.
 *
 * The window had nothing to show between pressing Send and the first word of a
 * reply, and on a local model that gap is the prompt being read: tens of
 * seconds for a long conversation on a small card, indistinguishable from a
 * wedged server. llama.cpp will say how far it has got if asked
 * (`return_progress`, measured against the bundled b10375 and through lemond
 * 11.8.0: one `prompt_progress` frame per batch, `processed` counting the
 * cached tokens too), and every server says a reply is arriving by sending it.
 *
 * No imports, so the renderer can share the shape and the wording -- the same
 * reason ladder.ts and databases.ts hold none.
 */

export type TurnProgress =
  /** Sent, nothing back yet: a model loading, a queue, or a server that does not report reading. */
  | { phase: "waiting" }
  /** llama.cpp reading the prompt. `processed` includes `cache`, as the server counts it. */
  | { phase: "prompt"; processed: number; total: number; cache: number }
  /** Frames arriving. One per token from llama.cpp; a hosted API may pack several into one. */
  | { phase: "writing"; tokens: number }
  /** A tool the model asked for is running. Drawn by the window from its own tool events. */
  | { phase: "tool"; tool: string }
  /** A dialog is open and nothing moves until it is answered -- not a model that is slow. */
  | { phase: "asking" };

/**
 * The share of the NEW work done, 0 to 1.
 *
 * Measured against what was not already cached, because that is what takes
 * time: a follow-up in a long conversation arrives with nearly all of it
 * cached, and a bar that started at 99% would say nothing about the part the
 * user is actually waiting for.
 */
export function promptFraction(p: { processed: number; total: number; cache: number }): number {
  const work = p.total - p.cache;
  if (work <= 0) return 1;
  return Math.min(1, Math.max(0, (p.processed - p.cache) / work));
}

/** One line for the status row. Honest about what is and is not known. */
export function describeProgress(p: TurnProgress): string {
  switch (p.phase) {
    case "waiting":
      return "Waiting for the model";
    case "prompt": {
      const work = Math.max(0, p.total - p.cache);
      const done = Math.max(0, Math.min(work, p.processed - p.cache));
      return work === 0
        ? "Reading the conversation"
        : `Reading the conversation — ${done.toLocaleString()} of ${work.toLocaleString()} tokens` +
            (p.cache > 0 ? ` (${p.cache.toLocaleString()} already cached)` : "");
    }
    case "writing":
      /* "~" because a hosted API may pack several tokens into one frame; the
         exact figure is the one printed under the reply when it finishes. */
      return p.tokens > 0 ? `Writing — ~${p.tokens.toLocaleString()} tokens` : "Writing";
    case "tool":
      return `Running ${p.tool}`;
    case "asking":
      return "Waiting for your answer";
  }
}

/** `42s`, `3m 05s`: short enough to sit beside a label, and it moves every second. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
