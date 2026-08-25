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

const UA = "Karen/0.1 (private research assistant)";
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
      const bytes = new Uint8Array(await res.arrayBuffer());
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

    const raw = (await res.text()).slice(0, MAX_PAGE_BYTES);
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
