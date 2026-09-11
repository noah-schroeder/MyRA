/**
 * PDF text extraction via poppler's pdftotext.
 *
 * This is the single biggest limit on academic depth: open-access links are
 * overwhelmingly PDFs, and without this the pipeline can only ever read
 * abstracts. poppler is used rather than a JS PDF library because it recovers
 * reading order from two-column academic layouts and is an order of magnitude
 * faster on a 40-page paper.
 *
 * Two details decide whether the text that comes out is quotable, and both were
 * wrong: `-layout`, which asks for the opposite of reading order, and the
 * hyphens a typesetter leaves at every line break. See `pdfToText` and
 * `dehyphenate` below.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Beyond this a "PDF" is a scanned book or a mis-served archive. */
export const MAX_PDF_MB = 40;
export const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;

/** Consistent units in messages: mebibytes, matching the limit itself. */
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

export class PdfError extends Error {
  override readonly name = "PdfError";
}

/** Is pdftotext installed? Checked once, since the answer cannot change mid-run. */
let available: boolean | undefined;
export async function pdfToolAvailable(): Promise<boolean> {
  if (available !== undefined) return available;
  try {
    await run("pdftotext", ["-v"], { timeout: 5_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/**
 * Extract text from PDF bytes.
 *
 * `-layout` preserves column structure, which matters enormously for papers:
 * without it, two-column text interleaves line by line into nonsense.
 */
export async function pdfToText(
  bytes: Uint8Array,
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!(await pdfToolAvailable())) {
    throw new PdfError("pdftotext is not installed (apt install poppler-utils)");
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfError(`PDF is ${mb(bytes.byteLength)}MB, over the ${MAX_PDF_MB}MB limit`);
  }
  // A PDF must start with %PDF-; anything else is a mislabelled error page.
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  if (header !== "%PDF-") throw new PdfError("not a PDF (missing %PDF- header)");

  const dir = await mkdtemp(join(tmpdir(), "myra-pdf-"));
  const src = join(dir, "in.pdf");
  try {
    await writeFile(src, bytes, { mode: 0o600 });
    /*
     * No `-layout`.
     *
     * It preserves the *physical* arrangement of the page, which on a
     * two-column paper means reading across both columns: every line becomes
     * the end of one sentence followed by the middle of an unrelated one. The
     * default mode recovers reading order instead, which is the whole reason
     * poppler is used here rather than a JS library. Measured on the two-column
     * ResNet paper (arXiv:1512.03385) while this was written: taking five
     * sentences a reader might quote, one could be located in the extracted
     * text with the flag and four without it. What breaks the other four is
     * figure labels -- "weight layer", "relu", "identity" -- landing in the
     * middle of body sentences, because on the page they are physically there.
     */
    const args = ["-nopgbrk", "-enc", "UTF-8"];
    if (opts.maxPages) args.push("-l", String(opts.maxPages));
    args.push(src, "-"); // "-" writes to stdout

    const { stdout } = await run("pdftotext", args, {
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const text = dehyphenate(
      stdout.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    );
    if (!text) {
      // Almost always a scanned image PDF. Say which, because the fix differs.
      throw new PdfError("no extractable text — the PDF is probably scanned images, which need OCR");
    }
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


/**
 * Rejoin words a typesetter broke across a line.
 *
 * This has to happen here, before the text is handed to anything else, because
 * quote offsets are recorded against the stored text: de-hyphenating later
 * would move every passage the verifier had already located. A paper full of
 * "instruc-\ntion" is a paper whose sentences cannot be found, quoted or
 * checked, which defeats the point of reading the full text at all.
 *
 * The hard part is telling a line break from a real compound. "self-\nreport"
 * should keep its hyphen; "instruc-\ntion" must lose it. The document answers
 * that itself: a genuine compound is written the same way somewhere else on the
 * page, so the hyphen survives only where the hyphenated form appears again
 * elsewhere in the same text. Anything else was the typesetter's.
 */
export function dehyphenate(text: string): string {
  const BREAK = /([A-Za-z\u00C0-\u024F]{2,})-\n[ \t]*([a-z\u00E0-\u024F]+)/g;
  if (!BREAK.test(text)) return text;
  BREAK.lastIndex = 0;

  const flat = text.toLowerCase();
  return text.replace(BREAK, (whole, left: string, right: string) => {
    const joined = `${left}-${right}`.toLowerCase();
    // Look for the compound written on one line somewhere else. `indexOf` on
    // the whole document rather than a word set: cheap, and it does not have to
    // be tokenised to be evidence.
    return flat.includes(joined) ? `${left}-${right}` : `${left}${right}`;
  });
}
