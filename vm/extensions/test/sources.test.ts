/**
 * Tests for the citation guarantees.
 *
 * These are the claims the whole design rests on, so they are tested against
 * the ways a model actually misbehaves: inventing a reference number, quoting
 * something close-but-not-quite, citing across a range, and reformatting
 * whitespace that came out of a PDF.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditCitations,
  containsVerbatim,
  extractCitations,
  extractQuotes,
  hashText,
  makeSourceRecord,
  renderBibliography,
  verifyQuotes,
  type SourceRecord,
} from "../research/sources.ts";

const src = (n: number, over: Partial<SourceRecord> = {}): SourceRecord => ({
  n,
  url: `https://example.test/${n}`,
  title: `Paper ${n}`,
  authors: ["Ada Lovelace", "Alan Turing"],
  year: 2024,
  venue: "Journal of Testing",
  doi: `10.1234/test.${n}`,
  sha256: "deadbeef",
  retrievedAt: "2026-08-19T00:00:00.000Z",
  chars: 100,
  via: "html",
  ...over,
});

/* ---------------- markers ---------------- */

test("extractCitations reads single, list and range markers", () => {
  assert.deepEqual(extractCitations("as shown [1]"), [1]);
  assert.deepEqual(extractCitations("several [1,2,3] agree"), [1, 2, 3]);
  assert.deepEqual(extractCitations("a range [4-6] here"), [4, 5, 6]);
  assert.deepEqual(extractCitations("en dash [7–8]"), [7, 8]);
});

test("extractCitations ignores bracketed things that are not citations", () => {
  // Page spans and years appear in brackets in real drafts; treating "[1990-2020]"
  // as thirty citations would fabricate dangling markers out of nothing.
  assert.deepEqual(extractCitations("over [1990-2020] the field grew"), []);
  assert.deepEqual(extractCitations("see [figure] and [n]"), []);
});

test("auditCitations passes a well-formed draft", () => {
  const a = auditCitations("Claim one [1]. Claim two [2].", [src(1), src(2)]);
  assert.equal(a.ok, true);
  assert.deepEqual(a.dangling, []);
  assert.deepEqual(a.cited, [1, 2]);
});

test("auditCitations catches a fabricated reference number", () => {
  // The failure that matters: the model cites [7] when only 3 sources exist.
  const a = auditCitations("Well established [1] and also [7].", [src(1), src(2), src(3)]);
  assert.equal(a.ok, false, "a marker with no source must fail the audit");
  assert.deepEqual(a.dangling, [7]);
});

test("auditCitations reports retrieved-but-uncited sources without failing", () => {
  const a = auditCitations("Only one is used [1].", [src(1), src(2)]);
  assert.equal(a.ok, true, "an unused source is not an error");
  assert.deepEqual(a.uncited, [2]);
});

/* ---------------- quotes ---------------- */

test("containsVerbatim survives PDF whitespace mangling", () => {
  // pdftotext -layout emits column padding and hard line breaks; a byte-exact
  // check would reject correct quotes constantly.
  const stored = "the  effect   was\n   large   and\nconsistent across trials";
  assert.ok(containsVerbatim(stored, "the effect was large and consistent"));
});

test("containsVerbatim still rejects a changed word", () => {
  const stored = "the effect was large and consistent across trials";
  assert.ok(!containsVerbatim(stored, "the effect was small and consistent"));
});

test("extractQuotes finds quoted spans and their citation", () => {
  const draft = 'The authors note "a marked increase in specificity" [2] in later work.';
  const quotes = extractQuotes(draft);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.quote, "a marked increase in specificity");
  assert.equal(quotes[0]!.citation, 2);
});

test("verifyQuotes passes a real quote and fails an invented one", () => {
  const texts = new Map([[1, "We observed a marked increase in specificity under the new protocol."]]);
  const good = verifyQuotes('They report "a marked increase in specificity" [1].', [src(1)], texts);
  assert.equal(good[0]!.verbatim, true);

  const bad = verifyQuotes('They report "a dramatic collapse in specificity" [1].', [src(1)], texts);
  assert.equal(bad[0]!.verbatim, false);
  assert.match(bad[0]!.reason!, /not found verbatim/);
});

test("verifyQuotes rejects a quote with no citation at all", () => {
  const checks = verifyQuotes('It simply says "something plausible sounding here".', [src(1)], new Map());
  assert.equal(checks[0]!.verbatim, false);
  assert.match(checks[0]!.reason!, /no \[n\] citation/);
});

test("verifyQuotes rejects a quote citing an unknown source", () => {
  const checks = verifyQuotes('As stated "a marked increase in specificity" [9].', [src(1)], new Map());
  assert.equal(checks[0]!.verbatim, false);
  assert.match(checks[0]!.reason!, /not a known source/);
});

/* ---------------- rendering ---------------- */

test("the bibliography is built from records, never from draft text", () => {
  // The guarantee in practice: whatever the model wrote, the rendered entry is
  // the retrieved record.
  const out = renderBibliography([src(1, { title: "Real Title" })]);
  assert.match(out, /^\[1\] Ada Lovelace, Alan Turing\. 2024\. Real Title\./);
  assert.match(out, /doi:10\.1234\/test\.1/);
  assert.match(out, /https:\/\/example\.test\/1/);
});

test("abstract-only sources are labelled as such", () => {
  // Silently treating an abstract as a full read would misrepresent the evidence.
  assert.match(renderBibliography([src(1, { via: "abstract" })]), /\[abstract only\]/);
});

test("renderBibliography can be limited to what was actually cited", () => {
  const out = renderBibliography([src(1), src(2), src(3)], [1, 3]);
  assert.match(out, /\[1\]/);
  assert.ok(!out.includes("[2]"), "uncited source should be omitted when filtering");
  assert.match(out, /\[3\]/);
});

test("makeSourceRecord fingerprints exactly what was read", () => {
  const text = "the stored text";
  const rec = makeSourceRecord(1, text, { url: "u", title: "t", via: "pdf" });
  assert.equal(rec.sha256, hashText(text));
  assert.equal(rec.chars, text.length);
  assert.equal(rec.via, "pdf");
});
