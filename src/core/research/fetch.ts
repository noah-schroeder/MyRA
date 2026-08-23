/**
 * Retrieving a source's text: HTML, plain text, or PDF.
 *
 * PDF support is what makes academic depth possible at all -- open-access links
 * are overwhelmingly PDFs, and without extraction the pipeline could only ever
 * read abstracts.
 */

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

export async function fetchPage(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<Page> {
  const fail = (error: string): Page => ({ url, title: "", text: "", via: "html", error });

  try {
    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        // Identify honestly. Pretending to be a browser is what gets an IP
        // blocked, and this one is shared with every other tool in the VM.
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9",
      },
    });
    if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText}`);

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
