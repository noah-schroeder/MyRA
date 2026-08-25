/**
 * Academic search with no model in the loop.
 *
 * The pipeline already queried these APIs, but only ever through a tool call,
 * which meant a lookup cost a conversation turn and came back as prose a model
 * had formatted. These tests are about the two things that make the panel
 * usable: results are structured, and the same paper arriving from both
 * backends is one row, not two.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { academicLookup, sortResults, type AcademicResult } from "../src/core/research/lookup.ts";

const row = (over: Partial<AcademicResult>): AcademicResult => ({
  id: 1, title: "t", authors: [], url: "https://example.org/", engine: "openalex", ...over,
});

test("sorting reorders what is here and never re-searches", () => {
  const results = [
    row({ id: 1, citedBy: 10, year: 2020 }),
    row({ id: 2, citedBy: 900, year: 2008 }),
    row({ id: 3, year: 2024 }),
  ];
  assert.deepEqual(sortResults(results, "citations").map((r) => r.id), [2, 1, 3]);
  assert.deepEqual(sortResults(results, "newest").map((r) => r.id), [3, 1, 2]);
  // Relevance is the order the databases returned; it must be left alone.
  assert.deepEqual(sortResults(results, "relevance"), results);
  // And sorting is never destructive.
  assert.deepEqual(results.map((r) => r.id), [1, 2, 3]);
});

test("a record with no citation count sorts last, not first", () => {
  // arXiv-only records have no count. Treating undefined as 0 would be fine;
  // treating it as "best" would put every preprint above every paper.
  const results = [row({ id: 1 }), row({ id: 2, citedBy: 0 })];
  assert.deepEqual(sortResults(results, "citations").map((r) => r.id), [2, 1]);
});

function stubFetch(handler: (url: string) => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(typeof input === "string" ? input : (input as URL).href)) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("results come back structured, with the fields the panel shows", async () => {
  const restore = stubFetch((url) =>
    url.includes("openalex")
      ? json({
          results: [{
            id: "https://openalex.org/W1",
            doi: "https://doi.org/10.1177/1745691616635612",
            title: "Working memory training does not improve intelligence",
            publication_year: 2016,
            cited_by_count: 890,
            authorships: [{ author: { display_name: "Monica Melby-Lervag" } }],
            primary_location: { source: { display_name: "Perspectives on Psychological Science" } },
            open_access: { oa_url: "https://example.org/open.pdf", is_oa: true },
            abstract_inverted_index: { It: [0], has: [1], "been": [2], claimed: [3] },
          }],
        })
      : new Response("<feed></feed>", { status: 200 }),
  );
  try {
    const { results, failures } = await academicLookup("working memory");
    assert.equal(failures.length, 0);
    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.citedBy, 890);
    assert.equal(r.venue, "Perspectives on Psychological Science");
    assert.equal(r.doi, "10.1177/1745691616635612");
    // The landing page is the DOI resolver; the PDF is separate, so "open the
    // paper" and "read the full text" are different buttons.
    assert.equal(r.url, "https://doi.org/10.1177/1745691616635612");
    assert.equal(r.pdfUrl, "https://example.org/open.pdf");
    // The abstract is reconstructed from OpenAlex's position index, not shown raw.
    assert.equal(r.abstract, "It has been claimed");
  } finally {
    restore();
  }
});

test("one paper from both backends is one row", async () => {
  const restore = stubFetch((url) =>
    url.includes("openalex")
      ? json({
          results: [{
            id: "https://openalex.org/W2",
            doi: "https://doi.org/10.48550/arxiv.2101.00001",
            title: "Scaling laws for neural language models",
            publication_year: 2021,
            cited_by_count: 900,
          }],
        })
      : new Response(
          `<feed><entry><id>http://arxiv.org/abs/2101.00001</id>
           <title>Scaling laws for neural language models</title>
           <summary>We study empirical scaling laws.</summary>
           <published>2021-01-23T00:00:00Z</published>
           <link title="pdf" href="http://arxiv.org/pdf/2101.00001"/>
           </entry></feed>`,
          { status: 200 },
        ),
  );
  try {
    const { results } = await academicLookup("scaling laws");
    assert.equal(results.length, 1, "the same paper should not appear twice");
    // Metadata from OpenAlex, the readable copy from arXiv.
    assert.equal(results[0]!.citedBy, 900);
    assert.ok(results[0]!.pdfUrl?.includes("arxiv.org/pdf"));
  } finally {
    restore();
  }
});

test("one backend failing halves the results but does not fail the search", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("openalex")) return new Response("rate limited", { status: 429 });
    return new Response(
      `<feed><entry><id>http://arxiv.org/abs/2101.00002</id>
       <title>A preprint that survived</title><summary>Body.</summary>
       <published>2021-02-01T00:00:00Z</published>
       <link title="pdf" href="http://arxiv.org/pdf/2101.00002"/></entry></feed>`,
      { status: 200 },
    );
  });
  try {
    const { results, failures } = await academicLookup("anything");
    assert.equal(results.length, 1);
    // Silence here would look like a thin literature rather than a thin search.
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /OpenAlex/);
  } finally {
    restore();
  }
});

test("an empty query does no work at all", async () => {
  let called = false;
  const restore = stubFetch(() => { called = true; return json({ results: [] }); });
  try {
    const { results } = await academicLookup("   ");
    assert.deepEqual(results, []);
    assert.equal(called, false, "an empty query must not spend an OpenAlex credit");
  } finally {
    restore();
  }
});
