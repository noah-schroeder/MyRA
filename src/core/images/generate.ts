/**
 * Making a picture, against whichever endpoint the chosen model lives on.
 *
 * The mirror of audio/speech.ts, and deliberately shaped like it: one function
 * that posts, one error type that says what went wrong in words, and no
 * knowledge of Electron so the whole thing is reachable from the test runner.
 *
 * WHAT IS ASSUMED, AND STILL NEEDS MEASURING against a running Lemonade with a
 * diffusion model loaded. speech.ts's header is the standard to bring this up
 * to -- every line of it was measured -- and these are the open questions:
 *
 *   - Whether `sd-cpp` honours `negative_prompt`. It is not an OpenAI field;
 *     llama.cpp's image server and most OpenAI-compatible shims accept it, and
 *     a server that does not should ignore an unknown key rather than fault.
 *   - Whether `size` is honoured or the model's own default always wins.
 *   - Whether the reply carries `b64_json` or a `url`. Both are handled, and
 *     `response_format` asks for the first, but speech.ts records Lemonade
 *     returning MP3 whatever the request asked for -- so the reply is read for
 *     what it actually contains rather than for what was requested.
 *
 * Until those are confirmed, the rule here is that a surprising reply produces
 * a sentence naming what came back, never a crash and never a zero-byte file.
 */

import type { EndpointSettings } from "../config.ts";

export class ImageError extends Error {
  override readonly name = "ImageError";
}

export interface GenerateOptions {
  endpoint: EndpointSettings;
  /** The prompt as it will be sent. Compose with presets.ts first. */
  prompt: string;
  /** Omitted is legal and means the engine's default. */
  negative?: string;
  size?: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface Generated {
  image: Buffer;
  /** Read from the bytes, because neither the request nor the header decides it. */
  mime: string;
}

/**
 * How long to wait for a picture.
 *
 * Longer than speech, for speech's reason and one more. The first call for a
 * model that is not on disk downloads it, and on top of that diffusion on a CPU
 * is slow in a way synthesis is not: a 1024px image on an unaccelerated machine
 * is minutes of real work, not a slow response.
 */
export const IMAGE_TIMEOUT_MS = 15 * 60_000;

/** A returned URL is fetched, so it gets a ceiling like any other body. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export function imagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
}

/**
 * What kind of image this is, from its first bytes.
 *
 * Not from `response_format`, and not from a content-type header: speech.ts
 * asked Lemonade for WAV and got an ID3 frame, and the same engine family is
 * serving this route. The bytes are the only field that cannot be wrong.
 */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/** The extension to save under, so the file opens by double-clicking it. */
export function extensionFor(mime: string): string {
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/bmp": return "bmp";
    case "image/webp": return "webp";
    default: return "png";
  }
}

/** The request body, separated out so a test can assert what is on the wire. */
export function buildRequest(opts: Pick<GenerateOptions, "endpoint" | "prompt" | "negative" | "size">): {
  model: string;
  prompt: string;
  n: number;
  response_format: string;
  negative_prompt?: string;
  size?: string;
} {
  const negative = opts.negative?.trim();
  const size = opts.size?.trim();
  return {
    model: opts.endpoint.model ?? "",
    prompt: opts.prompt.trim(),
    n: 1,
    response_format: "b64_json",
    /* Spread conditionally, as speak() does: a field the user did not fill in
       should not be sent at all, so an engine that has an opinion about its
       own default gets to keep it. */
    ...(negative ? { negative_prompt: negative } : {}),
    ...(size ? { size } : {}),
  };
}

export async function generate(opts: GenerateOptions): Promise<Generated> {
  const { endpoint, prompt } = opts;
  if (!endpoint.baseUrl) {
    throw new ImageError("No image model is set up. Choose one from the picker above.");
  }
  if (!endpoint.model) {
    throw new ImageError("No image model is set up. Choose one from the picker above.");
  }
  if (!prompt.trim()) throw new ImageError("There was nothing to draw.");

  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const url = imagesUrl(endpoint.baseUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(buildRequest(opts)),
      signal,
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "AbortError" && opts.signal?.aborted) throw new ImageError("Stopped before the image was finished.");
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ImageError(
        "The image model did not answer in fifteen minutes. If it was downloading, try again — what arrived is kept.",
      );
    }
    throw new ImageError(`Could not reach the image model: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300).trim();
    if (res.status === 401 || res.status === 403) {
      throw new ImageError(`The image endpoint rejected the API key (${res.status}).`);
    }
    if (res.status === 404) {
      throw new ImageError(`No image endpoint at ${url} (404). Check the provider's base URL.`);
    }
    throw new ImageError(`Generating the image failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ImageError("The image endpoint answered with something that was not JSON.");
  }

  const image = await firstImage(payload, opts.apiKey, signal);
  const mime = sniffImage(image);
  if (!mime) {
    /* Named rather than guessed. A body that is not an image is usually an
       error document served with a 200, and saying so beats writing it to disk
       under a .png nobody can open. */
    throw new ImageError("The image endpoint returned something that is not an image.");
  }
  return { image: Buffer.from(image), mime };
}

/**
 * The bytes out of an OpenAI-shaped images reply.
 *
 * `data[0].b64_json` is what is asked for. `data[0].url` is the other half of
 * the spec and is fetched only over http(s) -- a `file:` URL from a
 * misbehaving endpoint would otherwise turn this into an arbitrary file read
 * on the user's machine, which is not a thing an image generator should be
 * able to do.
 */
async function firstImage(payload: unknown, apiKey: string | undefined, signal: AbortSignal): Promise<Uint8Array> {
  const data = (payload as { data?: unknown })?.data;
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) {
    const message = messageIn(payload);
    throw new ImageError(message ? `The image model refused: ${message}` : "The image model returned no image.");
  }

  const b64 = first["b64_json"];
  if (typeof b64 === "string" && b64.length) {
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new ImageError("The image model returned an empty image.");
    return bytes;
  }

  const href = first["url"];
  if (typeof href === "string" && /^https?:\/\//i.test(href)) {
    const res = await fetch(href, {
      signal,
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!res.ok) throw new ImageError(`The image was published at a URL that answered ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new ImageError("The image model returned an empty image.");
    if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError("The image was larger than 64 MB and was not kept.");
    return bytes;
  }

  throw new ImageError("The image model's reply had neither image data nor a usable URL in it.");
}

/** An error sentence out of whatever shape the endpoint used to report one. */
function messageIn(payload: unknown): string | undefined {
  const error = (payload as { error?: unknown })?.error;
  if (typeof error === "string") return error.slice(0, 300);
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message.slice(0, 300) : undefined;
}
