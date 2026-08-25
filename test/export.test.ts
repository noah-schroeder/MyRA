/**
 * Exports are rendered from the source table, never from model output.
 *
 * The point of these tests is not that the syntax is pretty. It is that a
 * `.bib` entry cannot name an author the paper does not have, that the version
 * caveat survives into a reference manager, and that a title full of braces
 * cannot silently swallow the rest of the file.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { citeKey, splitName, toBibtex, toCsl, toCslJson } from "../src/core/research/export.ts";
import type { SourceRecord } from "../src/core/research/sources.ts";

const paper: SourceRecord = {
  n: 1,
  url: "https://doi.org/10.1037/xge0001234",
  title: "The limits of working memory training",
  authors: ["Susanne M. Jaeggi", "Martin Buschkuehl", "Jos van der Linden"],
  year: 2021,
  venue: "Journal of Experimental Psychology: General",
  doi: "https://doi.org/10.1037/xge0001234",
  sha256: "abc",
  retrievedAt: "2026-08-25T10:00:00.000Z",
  chars: 40_000,
  via: "pdf",
};

const page: SourceRecord = {
  n: 2,
  url: "https://example.org/notes",
  title: "A blog post about memory",
  sha256: "def",
  retrievedAt: "2026-08-25T10:00:00.000Z",
  chars: 900,
  via: "html",
};

test("names split into family and given, keeping particles with the family", () => {
  assert.deepEqual(splitName("Susanne M. Jaeggi"), { family: "Jaeggi", given: "Susanne M." });
  assert.deepEqual(splitName("Jos van der Linden"), { family: "van der Linden", given: "Jos" });
  // A mononym is a family name, not a given one: "given" is what is optional.
  assert.deepEqual(splitName("Aristotle"), { family: "Aristotle", given: "" });
});

test("cite keys follow the convention reference managers expect", () => {
  const taken = new Set<string>();
  assert.equal(citeKey(paper, taken), "jaeggi2021limits");
  // "The" is a stop word; the first meaningful title word is used instead.
  assert.ok(!citeKey(paper, new Set()).includes("the"));
});

test("two papers never share a cite key", () => {
  const taken = new Set<string>();
  const a = citeKey(paper, taken);
  const b = citeKey({ ...paper, n: 2 }, taken);
  assert.notEqual(a, b);
  assert.equal(b, `${a}2`);
});

test("a paper with no author or year still gets a usable key", () => {
  assert.match(citeKey(page, new Set()), /^anonnd/);
});

test("bibtex joins authors with `and`, never with commas", () => {
  const bib = toBibtex([paper]);
  assert.match(bib, /author = \{Jaeggi, Susanne M\. and Buschkuehl, Martin and van der Linden, Jos\}/);
  // A comma inside a name field means "Family, Given" -- joining on commas
  // would merge three authors into one mangled name.
  assert.equal(bib.match(/author = \{/g)?.length, 1);
});

test("a venue makes it an article; its absence makes it misc", () => {
  assert.match(toBibtex([paper]), /^@article\{/m);
  assert.match(toBibtex([page]), /^@misc\{/m);
  assert.match(toBibtex([paper]), /journal = \{Journal of Experimental Psychology/);
  assert.ok(!/journal = /.test(toBibtex([page])));
});

test("the DOI is exported as an identifier, not as a resolver URL", () => {
  assert.match(toBibtex([paper]), /doi = \{10\.1037\/xge0001234\}/);
  assert.equal(toCsl([paper])[0]!.DOI, "10.1037/xge0001234");
});

test("braces in a title cannot swallow the rest of the file", () => {
  const nasty: SourceRecord = { ...paper, title: "Memory {and} 100% of $x^2$ & more_" };
  const bib = toBibtex([nasty]);
  const opens = (bib.match(/(?<!\\)\{/g) ?? []).length;
  const closes = (bib.match(/(?<!\\)\}/g) ?? []).length;
  assert.equal(opens, closes, `unbalanced braces in:\n${bib}`);
  assert.match(bib, /\\&/);
  assert.match(bib, /\\%/);
  assert.match(bib, /\\_/);
});

/*
 * The caveat is the whole reason this is not just a formatting exercise.
 *
 * "read from abstract only" and "this is the preprint, not the version of
 * record" are the two things a reader must not lose, and a bibliography
 * exported into Zotero is exactly where they would otherwise be lost.
 */
test("the version caveat survives into both formats", () => {
  const preprint: SourceRecord = {
    ...paper,
    note: "full text read from an open version of this work, not the version of record",
  };
  assert.match(toBibtex([preprint]), /note = \{full text read from an open version/);
  assert.match(toCsl([preprint])[0]!.note!, /not the version of record/);

  const abstractOnly: SourceRecord = { ...paper, via: "abstract" };
  assert.match(toBibtex([abstractOnly]), /note = \{read from abstract only\}/);
  assert.equal(toCsl([abstractOnly])[0]!.note, "read from abstract only");
});

test("csl-json is valid json with the fields Zotero reads", () => {
  const parsed = JSON.parse(toCslJson([paper, page])) as ReturnType<typeof toCsl>;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.type, "article-journal");
  assert.equal(parsed[1]!.type, "webpage");
  assert.deepEqual(parsed[0]!.issued, { "date-parts": [[2021]] });
  assert.deepEqual(parsed[0]!.accessed, { "date-parts": [[2026, 8, 25]] });
  assert.deepEqual(parsed[0]!.author?.[0], { family: "Jaeggi", given: "Susanne M." });
});

test("an empty source table exports empty, not malformed", () => {
  assert.equal(toBibtex([]), "");
  assert.equal(toCslJson([]), "[]\n");
});
