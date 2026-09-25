/**
 * A dropped paper's bytes as pages of text.
 *
 * Its own module, apart from sources.ts, for the reason projectStore.ts is
 * apart from projects.ts: that one imports electron, and this is the half the
 * tests need to run for real against pdftotext.
 */

import { pdfToPages } from "../core/research/pdf.ts";
import type { Extractor } from "../core/sources/store.ts";
import { extractDocument } from "./extract.ts";

/**
 * PDFs by page, because a citation needs the page; everything else as one
 * unpaged text through the same extractor the chat composer uses.
 */
export const extractPages: Extractor = async (name, bytes) => {
  if (/\.pdf$/i.test(name)) {
    try {
      return { pages: await pdfToPages(bytes), paged: true };
    } catch (err) {
      const message = (err as Error).message;
      return { error: message, scanned: /scanned|OCR/i.test(message) };
    }
  }
  const extracted = await extractDocument(name, bytes);
  return extracted.ok && extracted.text ? { pages: [extracted.text], paged: false } : { error: extracted.error ?? "no text could be read" };
};
