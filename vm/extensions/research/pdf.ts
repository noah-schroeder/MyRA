/**
 * PDF text extraction via poppler's pdftotext.
 *
 * This is the single biggest limit on academic depth: open-access links are
 * overwhelmingly PDFs, and without this the pipeline can only ever read
 * abstracts. poppler is used rather than a JS PDF library because it handles
 * two-column academic layouts correctly and is an order of magnitude faster on
 * a 40-page paper.
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

  const dir = await mkdtemp(join(tmpdir(), "karen-pdf-"));
  const src = join(dir, "in.pdf");
  try {
    await writeFile(src, bytes);
    const args = ["-layout", "-nopgbrk", "-enc", "UTF-8"];
    if (opts.maxPages) args.push("-l", String(opts.maxPages));
    args.push(src, "-"); // "-" writes to stdout

    const { stdout } = await run("pdftotext", args, {
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const text = stdout.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      // Almost always a scanned image PDF. Say which, because the fix differs.
      throw new PdfError("no extractable text — the PDF is probably scanned images, which need OCR");
    }
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
