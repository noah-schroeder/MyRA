/**
 * Retrieving a source's text: HTML, plain text, or PDF.
 *
 * PDF support is what makes academic depth possible at all -- open-access links
 * are overwhelmingly PDFs, and without extraction the pipeline could only ever
 * read abstracts.
 */

import { assertFetchable, BlockedUrlError } from "./guard.ts";
import { FETCH_TIMEOUT_MS, MAX_PAGE_BYTES } from "./config.ts";
import { htmlToText } from "./html.ts";
import { MAX_PDF_BYTES, MAX_PDF_MB, pdfToText } from "./pdf.ts";

export interface Page {
  url: string;
  title: string;
  text: string;
  /** How the text was obtained, so an abstract is never mistaken for full text. */
  via: "html" | "pdf" | "text";
  error?: string;
}

const UA = "MyRA/0.1 (private research assistant)";
/** Enough for the publisher → repository → CDN chains that papers really use. */
const MAX_REDIRECTS = 5;

export async function fetchPage(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<Page> {
  // Closes over `url`, which is reassigned to the final hop below -- so an
  // error after a redirect names the page actually read, not the one asked for.
  const fail = (error: string): Page => ({ url, title: "", text: "", via: "html", error });

  try {
    /*
     * Redirects are followed BY HAND so every hop can be checked.
     *
     * With redirect: "follow", a perfectly ordinary public URL that answers
     * `302 http://169.254.169.254/` would be followed straight to the cloud
     * metadata service, and a guard applied only to the URL the model supplied
     * would have approved the request that got there. The check has to happen
     * per hop or it does not really happen at all.
     */
    let current = await assertFetchable(url);
    let res: Response;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) return fail(`too many redirects (over ${MAX_REDIRECTS})`);
      res = await fetch(current, {
        signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
        headers: {
          // Identify honestly. Pretending to be a browser is what gets an IP
          // blocked, and this one is shared with every other tool in the app.
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9",
        },
      });
      if (res.status < 300 || res.status > 399) break;
      const location = res.headers.get("location");
      if (!location) break; // a 3xx with nowhere to go is just a failed request
      current = await assertFetchable(new URL(location, current).href);
    }
    if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`);
    // Everything below reports the URL actually read, not the one requested.
    url = current.href;

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const looksPdf = /application\/pdf/.test(type) || /\.pdf($|\?)/i.test(url);

    if (looksPdf) {
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_PDF_BYTES) {
        return fail(`PDF is ${(declared / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_PDF_MB}MB limit`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, MAX_PDF_BYTES);
      } catch (err) {
        if (err instanceof TooLarge) return fail(`PDF is over the ${MAX_PDF_MB}MB limit`);
        throw err;
      }
      try {
        const text = await pdfToText(bytes);
        const clipped = text.length > maxChars;
        return {
          url,
          title: "",
          via: "pdf",
          text: clipped ? `${text.slice(0, maxChars)}\n\n[…truncated at ${maxChars} characters]` : text,
        };
      } catch (err) {
        return fail((err as Error).message);
      }
    }

    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) {
      return fail(`unsupported content-type: ${type || "unknown"}`);
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_PAGE_BYTES) return fail(`page too large (${declared} bytes)`);

    let raw: string;
    try {
      raw = new TextDecoder().decode(await readCapped(res, MAX_PAGE_BYTES));
    } catch (err) {
      if (err instanceof TooLarge) return fail(`page too large (over ${MAX_PAGE_BYTES} bytes)`);
      throw err;
    }
    const plain = /text\/plain/.test(type);
    const { title, text } = plain ? { title: "", text: raw } : htmlToText(raw);
    if (!text.trim()) return fail("no readable text found");

    const clipped = text.length > maxChars;
    return {
      url,
      title,
      via: plain ? "text" : "html",
      text: clipped ? `${text.slice(0, maxChars)}\n\n[…truncated at ${maxChars} characters]` : text,
    };
  } catch (err) {
    if (err instanceof BlockedUrlError) return fail(err.message);
    return fail((err as Error).message);
  }
}

export class TooLarge extends Error {
  override readonly name = "TooLarge";
}

/**
 * Read a response body, stopping at `limit` bytes instead of after them.
 *
 * `await res.text()` and `await res.arrayBuffer()` buffer the WHOLE body before
 * anything can look at its size, so the previous `(await res.text()).slice(0,
 * MAX_PAGE_BYTES)` enforced its limit only once the damage was done. The
 * content-length header is not a defence either: it is optional, a chunked
 * response omits it, and a hostile server can simply lie.
 *
 * That matters here more than it would elsewhere, because the URL is chosen by
 * a model acting on text written by strangers -- a search snippet, a fetched
 * page. One link to an endless stream would grow the main process until the
 * machine started swapping, taking the window and any loaded model with it.
 *
 * So the stream is read frame by frame and abandoned the moment it goes over.
 * Cancelling the reader also closes the connection, so nothing keeps arriving
 * after we have stopped caring.
 */
export async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new TooLarge(`body exceeded ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}
