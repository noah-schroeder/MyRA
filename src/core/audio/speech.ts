/**
 * Text to speech, against whichever endpoint the chosen voice model lives on.
 *
 * The mirror of stt.ts, and deliberately shaped like it: one function that
 * posts, one error type that says what went wrong in words, and no knowledge of
 * Electron so the whole thing is reachable from the test runner.
 *
 * What was measured against Lemonade 11.8.0, because none of it is documented
 * in a form Karen could rely on:
 *
 *   - `POST /v1/audio/speech` is the route. There is no `/audio/voices` and no
 *     OpenAPI document, so the voice names are shipped (see voices.ts).
 *   - The reply is **MP3**, whatever `response_format` asks for. Sending
 *     `response_format: "wav"` returned an ID3 frame just the same, so the
 *     container is read off the response rather than assumed from the request.
 *   - `model` is required; `voice` is not, and omitting it uses the engine's
 *     own default.
 *   - The first request for a model that is not downloaded **pulls it**, which
 *     took 19.7 s for Kokoro's 354 MB on this machine against 0.2 s once it was
 *     resident. That is why the deadline here is generous and why the caller
 *     tells the user a download may be happening.
 */

import { audioMime, refusedTheFormat, sniffAudio } from "./container.ts";
import {
  DEFAULT_PCM, isRawPcm, PCM_FORMAT, rateFrom, repairWav, wavFromPcm, WAV_FORMAT,
} from "./wav.ts";
import type { EndpointSettings } from "../config.ts";

export class SpeechError extends Error {
  override readonly name = "SpeechError";
}

export interface SpeakOptions {
  endpoint: EndpointSettings;
  /** What to say. Run through `speakable()` first; this does no cleaning. */
  text: string;
  /** Omitted is legal and means the engine's default. */
  voice?: string;
  /** 0.5 to 2.0, where 1 is the model's natural pace. */
  speed?: number;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface Spoken {
  audio: Buffer;
  /** Taken from the response, because the request cannot decide it. */
  mime: string;
}

/**
 * How long to wait for audio.
 *
 * Longer than a chat request rather than shorter, despite synthesis being fast:
 * the first call for a model that is not on disk downloads it, and cutting that
 * off at the usual two minutes would make a working setup look broken on
 * exactly the request that sets it up.
 */
export const SPEECH_TIMEOUT_MS = 10 * 60_000;

export function speechUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
}

export async function speak(opts: SpeakOptions): Promise<Spoken> {
  const { endpoint, text } = opts;
  if (!endpoint.baseUrl) {
    throw new SpeechError("No voice model is set up. Choose one in Settings → Audio.");
  }
  if (!endpoint.model) {
    /* Lemonade answers a request with no model as
       `Missing 'model' field in request`, which is true and unhelpful in front
       of someone who never typed a model name anywhere. */
    throw new SpeechError("No voice model is set up. Choose one in Settings → Audio.");
  }
  if (!text.trim()) throw new SpeechError("There was nothing to say.");

  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const send = async (format: string | undefined): Promise<Response> =>
    fetch(speechUrl(endpoint.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        input: text,
        ...(opts.voice ? { voice: opts.voice } : {}),
        ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
        ...(format ? { response_format: format } : {}),
      }),
      signal,
    });

  let res: Response;
  try {
    /*
     * Raw samples first, then WAV, then whatever the endpoint likes.
     *
     * With no format named the local daemon answers MP3, which needs a codec
     * the renderer may not ship. Asking it for WAV was the obvious fix and was
     * not one: it returns float32 samples under two 0xFFFFFFFF size fields,
     * and Chromium refuses that just as firmly -- reported, after the change,
     * as "That audio could not be played: the voice model returned audio/wav".
     *
     * `pcm` has nothing left to get wrong. It is 16-bit little-endian at 24 kHz
     * on both the local daemon and OpenAI, and Karen puts a correct header in
     * front of it below. The two fallbacks are for an endpoint that will not
     * produce raw samples; being unable to speak at all is the worse failure.
     */
    res = await send(PCM_FORMAT);
    for (const next of [WAV_FORMAT, undefined]) {
      if (res.ok || !refusedTheFormat(res.status, await res.clone().text().catch(() => ""))) break;
      res = await send(next);
    }
  } catch (err) {
    const name = (err as Error).name;
    if (name === "AbortError" && opts.signal?.aborted) {
      throw new SpeechError("Stopped before the reply was spoken.");
    }
    if (name === "TimeoutError" || name === "AbortError") {
      throw new SpeechError(
        "The voice model did not answer in ten minutes. If it was downloading, try again — " +
          "what arrived is kept.",
      );
    }
    throw new SpeechError(`Could not reach the voice model: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300).trim();
    if (res.status === 401 || res.status === 403) {
      throw new SpeechError(`The voice endpoint rejected the API key (${res.status}).`);
    }
    if (res.status === 404) {
      throw new SpeechError(
        `No speech endpoint at ${speechUrl(endpoint.baseUrl)} (404). Check the provider's base URL.`,
      );
    }
    /*
     * The one failure worth naming specially, because it is the one a person
     * will actually hit and its wire form says nothing.
     *
     * An unknown voice comes back as `backend returned HTTP 500` with no
     * mention of the voice -- measured. Anyone who typed a voice name for an
     * engine Karen cannot enumerate would otherwise be told the server broke.
     */
    if (res.status >= 500 && opts.voice) {
      throw new SpeechError(
        `The voice model refused the voice “${opts.voice}”. It may not have that voice — ` +
          `choose another in Settings → Audio. (${res.status}${body ? `: ${body}` : ""})`,
      );
    }
    throw new SpeechError(`Speech failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  const received = Buffer.from(await res.arrayBuffer());
  if (received.length === 0) throw new SpeechError("The voice model returned no audio.");
  const header = res.headers.get("content-type") ?? undefined;

  /*
   * Raw samples get the header they never had; a broken container gets fixed.
   *
   * Only when the bytes really are raw: an endpoint that ignored the format
   * and sent an MP3 anyway must be passed through, not wrapped, or the result
   * is an MP3 wearing a WAV header and nothing can play THAT either.
   */
  if (isRawPcm(header) && !sniffAudio(received)) {
    const rate = rateFrom(header) ?? DEFAULT_PCM.rate;
    const wav = wavFromPcm(received, { ...DEFAULT_PCM, rate });
    return { audio: Buffer.from(wav), mime: "audio/wav" };
  }
  const repaired = repairWav(received);
  if (repaired) return { audio: Buffer.from(repaired), mime: "audio/wav" };

  return {
    audio: received,
    /* The bytes are asked before the header. A server that labels its audio
       `application/octet-stream`, or mislabels it outright, otherwise hands
       the <audio> element a Blob it declines to play -- and the failure looks
       identical to a voice model that answered with silence. */
    mime: audioMime(received, header),
  };
}
