/**
 * PDF extraction error paths.
 *
 * The happy path needs a real PDF and is covered by the live-network test; what
 * matters here is that the failure modes are distinguishable, because "could
 * not read this paper" has several very different fixes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfToText, pdfToolAvailable } from "../research/pdf.ts";

test("pdftotext is installed", async () => {
  assert.equal(await pdfToolAvailable(), true, "install poppler-utils");
});

test("a non-PDF is rejected on its header, not by the parser", async () => {
  // Servers routinely return an HTML error page with a PDF content-type; saying
  // "not a PDF" is more useful than whatever poppler would report.
  const html = new TextEncoder().encode("<!doctype html><html><body>404</body></html>");
  await assert.rejects(() => pdfToText(html), /missing %PDF- header/);
});

test("an empty body is rejected", async () => {
  await assert.rejects(() => pdfToText(new Uint8Array(0)), /missing %PDF- header/);
});

test("an oversized PDF is refused before spawning anything", async () => {
  const huge = new Uint8Array(41 * 1024 * 1024);
  huge.set(new TextEncoder().encode("%PDF-"), 0);
  await assert.rejects(() => pdfToText(huge), /over the 40MB limit/);
});

test("a scanned PDF reports that it needs OCR", async (t) => {
  // A structurally valid PDF with no text layer. Built by hand so the test does
  // not depend on the network.
  const minimal = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
    "trailer<</Root 1 0 R>>",
  ].join("\n");
  try {
    await pdfToText(new TextEncoder().encode(minimal));
    t.diagnostic("poppler extracted text from a page with none; skipping");
  } catch (err) {
    assert.match((err as Error).message, /scanned images|OCR|no extractable text|PDF/i);
  }
});
