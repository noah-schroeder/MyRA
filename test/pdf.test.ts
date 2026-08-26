/**
 * PDF extraction error paths.
 *
 * The happy path needs a real PDF and is covered by the live-network test; what
 * matters here is that the failure modes are distinguishable, because "could
 * not read this paper" has several very different fixes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dehyphenate, pdfToText, pdfToolAvailable } from "../src/core/research/pdf.ts";

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

/* ------------------------------------------------------------------ *
 * De-hyphenation                                                      *
 * ------------------------------------------------------------------ */

test("a word broken across a line is rejoined without its hyphen", () => {
  const text = "Direct instruc-\ntion improved recall.";
  assert.equal(dehyphenate(text), "Direct instruction improved recall.");
});

test("a real compound keeps its hyphen when the paper writes it that way", () => {
  // The document is its own dictionary: "self-report" appears intact further
  // down, so the break at the top is a compound, not a typesetter's hyphen.
  const text = "Students gave a self-\nreport of effort. Each self-report was scored.";
  assert.equal(
    dehyphenate(text),
    "Students gave a self-report of effort. Each self-report was scored.",
  );
});

test("with no evidence either way the hyphen is dropped", () => {
  // Line-break hyphenation is far and away the common case, so it is the
  // default when the document says nothing.
  assert.equal(dehyphenate("meta-\ncognitive"), "metacognitive");
});

test("a hyphen that does not end a line is left alone", () => {
  const text = "A well-known effect\nacross studies.";
  assert.equal(dehyphenate(text), text);
});

test("a break before a capitalised word is not a broken word", () => {
  // "the 2019-\nSmith dataset": a range or a name, not a split word.
  const text = "the 2019-\nSmith dataset";
  assert.equal(dehyphenate(text), text);
});

test("text with no line-break hyphens is returned untouched", () => {
  const text = "Nothing here is hyphenated at a line end.\nSecond line.";
  assert.equal(dehyphenate(text), text);
});
