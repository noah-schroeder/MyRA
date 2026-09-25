/**
 * A paper's full text, and the keyword index over it.
 *
 * The promise these pin is the one a citation needs: what comes back is the
 * paper's own words with the page they are on. Page N is always `pages[N-1]`
 * -- a full-page figure is an empty page, not a missing one -- the reference
 * list is never searched, a read never exceeds its budget, and a model's
 * query can never reach FTS5's own syntax.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { pdfToPages } from "../src/core/research/pdf.ts";
import {
  detectSections, findSection, fullTextOf, outline, passages, readSpan,
} from "../src/core/sources/fulltext.ts";
import { ftsQuery, PaperIndex } from "../src/core/sources/search.ts";
import { buildPdf } from "./pdfFixture.ts";

const PAPER = [
  "Nurse adoption of electronic records\nAbstract\nWe study how self-efficacy shapes adoption.",
  "1. Introduction\nElectronic health records spread unevenly across wards.\n\n2. Methods\nWe surveyed 240 nurses.",
  "",
  "3. Results\nSelf-efficacy predicted intention to use the system.\nReferences\n[12] Bandura A. Self-efficacy. 1977.\n    https://doi.org/10.1037/0033-295X.84.2.191",
];

describe("pages from a real PDF", () => {
  it("keeps one string per page, empty ones included, so page numbers stay true", async () => {
    const pages = await pdfToPages(buildPdf([["Abstract", "Page one text."], ["Page two text."], [], ["Page four text."]]));
    assert.equal(pages.length, 4);
    assert.match(pages[0]!, /Page one text/);
    assert.equal(pages[2], "");
    assert.match(pages[3]!, /Page four text/);
  });

  it("keeps a genuinely blank final page -- only pdftotext's own trailing form feed is dropped", async () => {
    const pages = await pdfToPages(buildPdf([["Page one text."], ["Page two text."], []]));
    assert.equal(pages.length, 3, "the blank third page must be kept, not mistaken for the form-feed artifact");
    assert.match(pages[0]!, /Page one text/);
    assert.match(pages[1]!, /Page two text/);
    assert.equal(pages[2], "");
  });
});

describe("the outline", () => {
  it("finds numbered and bare headings, and where the references start", () => {
    const { sections, references } = detectSections(PAPER);
    assert.deepEqual(sections.map((s) => [s.name, s.page]), [
      ["Abstract", 1], ["1. Introduction", 2], ["2. Methods", 2], ["3. Results", 4], ["References", 4],
    ]);
    assert.deepEqual(references, { page: 4, line: 2 });
  });

  it("does not mistake a numbered sentence for a heading", () => {
    const { sections } = detectSections(["1. We recruited forty nurses from two wards."]);
    assert.equal(sections.length, 0);
  });

  it("reads as a line a model can navigate by", () => {
    assert.match(outline(fullTextOf(PAPER)), /^Abstract \(p\. 1\) · 1\. Introduction \(p\. 2\).* — 4 pages$/);
    assert.match(outline(fullTextOf(["no headings here"], false)), /no page numbers in this copy/);
  });

  it("finds a section by what a model would call it", () => {
    const text = fullTextOf(PAPER);
    assert.equal(findSection(text, "methods")?.name, "2. Methods");
    assert.equal(findSection(text, "2. Methods")?.name, "2. Methods");
    assert.equal(findSection(text, "Discussion"), undefined);
  });
});

describe("passages", () => {
  it("carry their page and section, and stop at the reference list", () => {
    const found = passages(fullTextOf(PAPER));
    const results = found.find((p) => /predicted intention/.test(p.text));
    assert.equal(results?.page, 4);
    assert.equal(results?.section, "3. Results");
    assert.ok(!found.some((p) => /Bandura/.test(p.text)), "the reference list is not searchable");
  });

  it("never cross a page", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const found = passages(fullTextOf([long, "second page"]));
    assert.ok(found.length >= 3);
    assert.ok(found.every((p) => (p.page === 2 ? p.text === "second page" : !p.text.includes("second"))));
  });
});

describe("reading a stretch", () => {
  const text = fullTextOf(PAPER);

  it("a section runs to the next heading and is marked with its pages", () => {
    const span = readSpan(text, { section: "Methods" }, 3000);
    assert.match(span.text, /^\[p\. 2\]\n2\. Methods\nWe surveyed 240 nurses\.$/);
    assert.equal(span.continuesAt, undefined);
  });

  it("names what is missing rather than returning something else", () => {
    assert.equal(readSpan(text, { section: "Discussion" }, 3000).missing, "Discussion");
    assert.match(readSpan(text, { page: 9 }, 3000).missing ?? "", /has 4/);
    assert.match(readSpan(fullTextOf(["x"], false), { page: 1 }, 3000).missing ?? "", /no page numbers/);
  });

  it("stops at the budget on a page boundary and says where to go on", () => {
    const pages = Array.from({ length: 6 }, (_, i) => `Page ${i + 1}. ${"lorem ipsum ".repeat(120)}`);
    const span = readSpan(fullTextOf(pages), {}, 700);
    assert.ok(span.text.length <= 700 * 3.6 + 50);
    // Each page is ~1,450 characters against a ~2,500 budget: one page, then "go on at 2".
    assert.equal(span.continuesAt, 2);
    assert.match(span.text, /Page 1\./);
    assert.doesNotMatch(span.text, /Page 2\./);
  });

  it("cuts a single page that is over budget on its own, and says it did", () => {
    const span = readSpan(fullTextOf(["para one. ".repeat(300) + "\n\n" + "para two. ".repeat(300), "next"]), {}, 400);
    assert.match(span.text, /the rest of this page was cut/);
    assert.equal(span.continuesAt, 2);
  });
});

describe("the query a model writes never reaches FTS5's syntax", () => {
  it("keeps words and phrases, drops operators and punctuation", () => {
    assert.equal(ftsQuery('self-efficacy AND "technology acceptance" NOT'), '"technology acceptance" OR "self" OR "efficacy"');
    // Single letters are noise to a ranked search and are dropped with the punctuation.
    assert.equal(ftsQuery("title:adoption NEAR(xy z) * ^ ( ) \" '"), '"title" OR "adoption" OR "xy"');
    assert.equal(ftsQuery("   "), undefined);
    assert.equal(ftsQuery("!!! ??? --"), undefined);
  });

  it("hostile queries search, or find nothing, but never throw", () => {
    const index = new PaperIndex([{ paper: "p1", page: 1, section: "", text: "self-efficacy predicts adoption" }]);
    for (const q of ['"unbalanced', "a:b:c", "NEAR/3", "((((", "-1", "col:*", "'; DROP TABLE passages; --"]) {
      assert.doesNotThrow(() => index.search(q), q);
    }
    assert.equal(index.search("'; DROP TABLE passages; --").length, 0);
    assert.equal(index.search("adoption").length, 1, "the table is still there");
    index.close();
  });
});

describe("the index", () => {
  const rows = [
    { paper: "a", page: 3, section: "Results", text: "Self-efficacy strongly predicted adoption of the new records system." },
    { paper: "a", page: 4, section: "Results", text: "Adoption was slower on night shifts." },
    { paper: "a", page: 5, section: "Discussion", text: "Adoption, adoption, adoption everywhere." },
    { paper: "a", page: 6, section: "Discussion", text: "Adopting early mattered for adoption." },
    { paper: "b", page: 2, section: "Methods", text: "Interviews explored why nurses resisted adopting it." },
  ];

  it("stems, so 'adopting' finds 'adoption'", () => {
    const index = new PaperIndex(rows);
    assert.ok(index.search("adopting").some((h) => h.paper === "b"));
    index.close();
  });

  it("holds any one paper to its share of the answer", () => {
    const index = new PaperIndex(rows);
    const hits = index.search("adoption", { limit: 10, perPaper: 2 });
    assert.equal(hits.filter((h) => h.paper === "a").length, 2);
    assert.ok(hits.some((h) => h.paper === "b"));
    index.close();
  });

  it("ranks the passage holding more of the words first, and keeps page and section", () => {
    const index = new PaperIndex(rows);
    const [best] = index.search("self-efficacy adoption records");
    assert.equal(best?.page, 3);
    assert.equal(best?.section, "Results");
    index.close();
  });
});
