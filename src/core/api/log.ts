/**
 * What was asked of MyRA, and how it went.
 *
 * Metadata only, in memory, capped. Request bodies are prompts, which is the
 * most sensitive material in the application: someone drafting a paper about a
 * sensitive population puts it all through this socket. So the default record
 * holds who asked, what for, and how it went, and nothing about what was said.
 *
 * There is deliberately no option to record bodies. One existed briefly and
 * was removed rather than shipped switched off: a prompt log is the single
 * most sensitive artefact this application could hold, and the strongest
 * guarantee is code that cannot produce one. Nothing here is written to disk
 * either -- closing MyRA loses the log, which is the right trade for what is
 * only a debugging aid.
 *
 * The usage record (core/usage/) is the one thing that outlives it: when a
 * request finishes, its key label, model, token counts and timings -- the same
 * metadata as here, still never a word of the body -- are added to the counts
 * Settings → Usage shows, unless recording is switched off there.
 */

/** How far a request got. `open` means it is still streaming. */
export type RequestState = "open" | "done" | "error" | "cancelled";

export interface RequestRecord {
  id: string;
  startedAt: string;
  /** Which MyRA key was used, by label. Never the key itself. */
  keyLabel: string;
  keyId: string;
  method: string;
  path: string;
  /** openai, ollama, anthropic -- what the client speaks. */
  dialect: string;
  model?: string | undefined;
  state: RequestState;
  status?: number | undefined;
  /** Milliseconds from accept to last byte. */
  durationMs?: number | undefined;
  /** Milliseconds to the first byte of the response body. */
  firstTokenMs?: number | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  error?: string | undefined;
}

const MAX_ENTRIES = 500;

/**
 * A fixed-size ring of recent requests, newest first.
 *
 * Bounded because a client in a retry loop can produce thousands of records a
 * minute, and an unbounded array in the main process is a slow leak that ends
 * as a crash on the user's machine hours later.
 */
export class RequestLog {
  #entries: RequestRecord[] = [];
  #listeners = new Set<(entries: readonly RequestRecord[]) => void>();

  get entries(): readonly RequestRecord[] {
    return this.#entries;
  }

  /** In-flight requests, which the UI shows above the finished ones. */
  get open(): readonly RequestRecord[] {
    return this.#entries.filter((e) => e.state === "open");
  }

  onChange(fn: (entries: readonly RequestRecord[]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn(this.#entries);
  }

  start(record: RequestRecord): void {
    this.#entries.unshift(record);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.length = MAX_ENTRIES;
    this.#emit();
  }

  /**
   * Update a record in place.
   *
   * Silently does nothing when the id has already fallen off the end of the
   * ring: a request that outlives 500 newer ones is possible, and it must not
   * be able to throw inside a response handler.
   */
  update(id: string, patch: Partial<RequestRecord>): void {
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.#emit();
  }

  clear(): void {
    /* In-flight requests survive: they are not history, they are things
       currently happening, and dropping them would strand a Cancel button
       with nothing to cancel. */
    this.#entries = this.#entries.filter((e) => e.state === "open");
    this.#emit();
  }
}

/**
 * The model a request is asking for, whichever dialect it speaks.
 *
 * All three put it in the same place, which is a small mercy: `model` at the
 * top level of a JSON body. Parsing is best-effort because the body may be
 * multipart audio, a stream, or malformed, and none of those should stop the
 * request being served.
 */
export function modelFrom(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** The counts in one parsed response body or stream frame, in any of the three dialects. */
function countsIn(parsed: unknown): { prompt?: number; completion?: number } {
  const p = parsed as {
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  } | null;
  if (!p || typeof p !== "object") return {};
  /* Three dialects, three spellings, all reaching this one function because
     the gateway does not care which one a client speaks. OpenAI and
     Anthropic both nest theirs under `usage`; Ollama puts its counts at the
     top level with different names again. */
  const u = p.usage;
  const prompt = u?.prompt_tokens ?? u?.input_tokens ?? p.prompt_eval_count;
  const completion = u?.completion_tokens ?? u?.output_tokens ?? p.eval_count;
  return {
    ...(typeof prompt === "number" ? { prompt } : {}),
    ...(typeof completion === "number" ? { completion } : {}),
  };
}

/**
 * Token counts from a completed response, for the rows that show them.
 *
 * `body` is the last few kilobytes of what was relayed. A plain JSON reply is
 * read whole; a stream is not JSON at all -- server-sent `data:` frames for
 * OpenAI and Anthropic, one JSON object per line for Ollama -- so it is read
 * from the end, frame by frame, until one carries counts. Reading only the
 * whole-body case meant every streamed request through the gateway, which is
 * most of them, was recorded with no tokens.
 */
export function usageFrom(body: string): { prompt?: number; completion?: number } {
  try {
    return countsIn(JSON.parse(body));
  } catch {
    // Not one JSON document; read it as a stream below.
  }
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i]!.trim();
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line.startsWith("{")) continue;
    try {
      const found = countsIn(JSON.parse(line));
      if (found.prompt !== undefined || found.completion !== undefined) return found;
    } catch {
      // The first line of a cut tail is usually half a frame.
    }
  }
  return {};
}

/** Tokens per second, when there is enough to compute it honestly. */
export function tokensPerSecond(record: RequestRecord): number | undefined {
  const { completionTokens, durationMs, firstTokenMs } = record;
  if (!completionTokens || !durationMs) return undefined;
  // Generation time, not total: waiting for the first token is prompt
  // processing, and counting it makes a long prompt look like a slow model.
  const generating = durationMs - (firstTokenMs ?? 0);
  if (generating <= 0) return undefined;
  return Math.round((completionTokens / generating) * 1000 * 10) / 10;
}
