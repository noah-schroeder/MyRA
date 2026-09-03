/**
 * Speech to text, against wherever the chosen transcription model lives.
 *
 * Where the audio goes is the user's choice, and it is made once: a model is
 * picked in Settings → Audio, and `main/audio.ts` resolves it to the local
 * daemon or to one of the user's providers. Nothing here reads a base URL the
 * user typed, because there is no longer a field for one -- the endpoint
 * arrives already resolved, and the messages below are written for somebody who
 * chose a MODEL rather than an address.
 *
 * Its mirror is `core/audio/speech.ts`, which does the same job in the other
 * direction. This file used to say it was the only place in the app allowed to
 * reach the network; that was true when it was written and speech makes two.
 */

import type { EndpointSettings } from "./config.ts";

export class TranscriptionError extends Error {
  override readonly name = "TranscriptionError";
}

export interface TranscribeOptions {
  endpoint: EndpointSettings;
  audio: Buffer;
  apiKey?: string;
  /** ISO-639-1 hint. Improves accuracy and latency when the language is known. */
  language?: string;
  /**
   * Vocabulary hint, passed to the model as its decoding prompt.
   *
   * The cheapest accuracy win available: Whisper biases decoding toward terms
   * it has seen here, so feeding it the names, products and acronyms a meeting
   * is about is what stops proper nouns coming back garbled -- and proper nouns
   * are exactly what an action item turns on.
   */
  prompt?: string;
  /** Sent as the upload filename; some servers infer the container from it. */
  filename?: string;
  signal?: AbortSignal;
}

/** One timed span of speech, as the endpoint reported it. */
export interface Segment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
}

export interface DetailedTranscription {
  text: string;
  segments: Segment[];
  language?: string;
  duration?: number;
}

function url(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Accept a base with or without /v1, since both are written in the wild.
  return /\/v\d+$/.test(base)
    ? `${base}/audio/transcriptions`
    : `${base}/v1/audio/transcriptions`;
}


/**
 * POST the audio and hand back the raw body.
 *
 * Shared by both callers so that the error handling -- which is most of the
 * value here, because a transcription failure is otherwise indistinguishable
 * from a silent meeting -- exists once.
 */
async function post(opts: TranscribeOptions, format: "json" | "verbose_json"): Promise<string> {
  const { endpoint, audio } = opts;
  if (!endpoint.baseUrl) {
    throw new TranscriptionError(
      "No transcription model is set up. Choose one in Settings → Audio.",
    );
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    opts.filename ?? "dictation.wav",
  );
  form.append("model", endpoint.model || "whisper-1");
  form.append("response_format", format);
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);

  // The endpoint may be a slow local whisper.cpp, so the timeout comes from the
  // endpoint's own setting rather than a constant here.
  const timeout = AbortSignal.timeout(endpoint.timeoutMs || 120_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url(endpoint.baseUrl), {
      method: "POST",
      body: form,
      ...(opts.apiKey ? { headers: { authorization: `Bearer ${opts.apiKey}` } } : {}),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new TranscriptionError(
        `${endpoint.model || "The transcription model"} did not answer within ` +
          `${(endpoint.timeoutMs || 120_000) / 1000}s.`,
      );
    }
    throw new TranscriptionError(
      `Could not reach ${endpoint.model || "the transcription model"} at ` +
        `${endpoint.baseUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 400).trim();
    if (res.status === 401 || res.status === 403) {
      throw new TranscriptionError(
        `The transcription model's provider rejected the API key (${res.status}). ` +
          "Check it in Settings → Providers.",
      );
    }
    if (res.status === 404) {
      /* A 404 means the address is wrong, and the only address the user
         controls now is a provider's -- so that is where they are sent. For a
         local model this is a bug rather than a setting, and naming the URL is
         what makes it reportable. */
      throw new TranscriptionError(
        `Nothing answers at ${url(endpoint.baseUrl)} (404). If this model came from a ` +
          "provider, check its base URL in Settings → Providers.",
      );
    }
    throw new TranscriptionError(`Transcription failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  return await res.text();
}

/** Plain text, for dictation. */
export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const raw = await post(opts, "json");
  // Most servers answer {"text": "..."}; some answer plain text despite
  // response_format. Accept both rather than failing on a working endpoint.
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; error?: { message?: string } };
    if (parsed?.error?.message) throw new TranscriptionError(parsed.error.message);
    if (typeof parsed?.text === "string") return parsed.text.trim();
    throw new TranscriptionError("The endpoint returned JSON with no `text` field.");
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    const text = raw.trim();
    if (!text) throw new TranscriptionError("The endpoint returned an empty response.");
    return text;
  }
}

/**
 * Text with timestamps, for meetings.
 *
 * A meeting needs times for two reasons: two tracks cannot be interleaved into
 * one conversation without them, and an action item that cannot point at the
 * moment it came from is not checkable.
 */
export async function transcribeDetailed(opts: TranscribeOptions): Promise<DetailedTranscription> {
  const raw = await post(opts, "verbose_json");
  return parseDetailed(raw);
}

/**
 * Read a verbose_json body, tolerating servers that do not fully implement it.
 *
 * Exported for testing, and because the shape varies more than the OpenAI
 * documentation suggests: whisper.cpp, faster-whisper-server and vLLM all
 * differ in what they include.
 */
export function parseDetailed(raw: string): DetailedTranscription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all: a server that ignored response_format and sent text.
    const text = raw.trim();
    if (!text) throw new TranscriptionError("The endpoint returned an empty response.");
    return { text, segments: [] };
  }

  const body = parsed as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
    segments?: unknown;
    error?: { message?: string };
  };
  if (body?.error?.message) throw new TranscriptionError(body.error.message);

  const segments: Segment[] = [];
  if (Array.isArray(body.segments)) {
    for (const raw of body.segments) {
      const segment = raw as { start?: unknown; end?: unknown; text?: unknown };
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) continue;
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      segments.push({ start, end: Math.max(start, end), text });
    }
  }

  const text = typeof body.text === "string" && body.text.trim()
    ? body.text.trim()
    : segments.map((s) => s.text).join(" ");
  if (!text) throw new TranscriptionError("The endpoint returned a transcription with no text.");

  return {
    text,
    segments,
    ...(typeof body.language === "string" ? { language: body.language } : {}),
    ...(Number.isFinite(Number(body.duration)) ? { duration: Number(body.duration) } : {}),
  };
}
