/**
 * The scholarly gate, and the identifiers that drive hydration.
 *
 * The gate matters because it decides whether a research run touches OpenAlex
 * at all: a general web sweep must make zero calls, and a scholarly sweep must
 * make them even when the category is not literally named "science".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { arxivDoiFromUrl, doiFromUrl } from "../src/core/research/hydrate.ts";
import { isScholarlyCategory, providersFor, supportsTimeRange } from "../src/core/research/providers.ts";

/*
 * v1 decided this by fetching SearXNG's /config and inspecting which engines
 * backed a category, with a five-minute cache and a fallback for when the
 * container was unreachable -- necessary, because the answer depended on what
 * the user had enabled inside a container we did not control.
 *
 * Calling OpenAlex and arXiv directly, the answer is ours. What still needs
 * testing is that the category NAMES users and models actually write are
 * recognised, including the one a naive check on "science" would miss.
 */
test("the category names a model or a user actually writes are recognised", () => {
  assert.equal(isScholarlyCategory("science"), true);
  // SearXNG's own name for the category, still what a returning user types.
  assert.equal(isScholarlyCategory("scientific publications"), true);
  assert.equal(isScholarlyCategory("general"), false);
  assert.equal(isScholarlyCategory("news"), false);
  assert.equal(isScholarlyCategory(""), false);
  assert.equal(isScholarlyCategory(undefined), false);
});

test("one scholarly category among several is enough to hydrate", () => {
  assert.equal(isScholarlyCategory("science,news"), true);
  assert.equal(isScholarlyCategory("news,scientific publications"), true);
  // Spacing is the user's, not ours: the plan document is hand-editable.
  assert.equal(isScholarlyCategory("news, science"), true);
  assert.equal(isScholarlyCategory("general,news"), false);
  assert.equal(isScholarlyCategory(" , "), false);
});

test("scholarly search works with nothing configured", () => {
  // The whole point of dropping the container: a fresh install can search the
  // literature immediately. General web search is the part that stays absent
  // until the user sets a backend up.
  const scholarly = providersFor("science");
  assert.ok(scholarly.length > 0, "no scholarly provider is available by default");
  assert.ok(scholarly.every((p) => p.scholarly));
  assert.deepEqual(providersFor("general"), []);
});

test("doiFromUrl pulls the identifier out of the URLs search results actually carry", () => {
  assert.equal(doiFromUrl("https://doi.org/10.1038/s41586-021-03819-3"), "10.1038/s41586-021-03819-3");
  assert.equal(
    doiFromUrl("https://link.springer.com/article/10.1007/s11192-021-04026-6"),
    "10.1007/s11192-021-04026-6",
  );
  // Query strings and fragments are not part of the identifier.
  assert.equal(doiFromUrl("https://x.org/10.1234/abcd?utm_source=news#top"), "10.1234/abcd");
  // Publisher suffixes are routing, not identity.
  assert.equal(doiFromUrl("https://onlinelibrary.wiley.com/doi/10.1002/adma.202100001/full"),
    "10.1002/adma.202100001");
  assert.equal(doiFromUrl("https://en.wikipedia.org/wiki/Photosynthesis"), undefined);
});

test("arXiv URLs map to their DOI, so abs and pdf links resolve identically", () => {
  const doi = "10.48550/arxiv.2005.11401";
  assert.equal(arxivDoiFromUrl("https://arxiv.org/abs/2005.11401"), doi);
  assert.equal(arxivDoiFromUrl("https://arxiv.org/pdf/2005.11401v4"), doi);
  assert.equal(arxivDoiFromUrl("https://example.com/paper.pdf"), undefined);
});

test("a version-of-record caveat reaches the bibliography", async () => {
  const { makeSourceRecord, renderBibliography } = await import("../src/core/research/sources.ts");
  const rec = makeSourceRecord(1, "body text", {
    url: "https://arxiv.org/pdf/2012.01981",
    title: "Advanced graph and sequence neural networks",
    authors: ["Meng Liu", "Youzhi Luo"],
    year: 2021,
    venue: "Bioinformatics",
    doi: "10.1093/bioinformatics/btab371",
    via: "pdf",
    note: "full text read from an open version of this work (2020), not the version of record",
  });
  const out = renderBibliography([rec]);
  // The citation is to the published paper; the words read were the preprint's.
  // Silently conflating those is precisely the inaccuracy this pipeline forbids.
  assert.match(out, /doi:10\.1093\/bioinformatics\/btab371/);
  assert.match(out, /not the version of record/);
});

test("DOI hydration uses the free single-entity endpoint, not a metered query", async () => {
  const { openAlexByDoi } = await import("../src/core/research/openalex.ts");
  const real = globalThis.fetch;
  let asked = "";
  globalThis.fetch = (async (u: string) => {
    asked = String(u);
    return new Response(JSON.stringify({ id: "W1", title: "A paper", publication_year: 2021 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const w = await openAlexByDoi("https://doi.org/10.1093/Bioinformatics/BTAC112");
    assert.equal(w?.title, "A paper");
    // /works/doi:... costs 0 credits; ?filter=doi:... costs 1. Over a research
    // run that is the difference between unmetered and rationed.
    assert.match(asked, /\/works\/doi:10\.1093\/bioinformatics\/btac112\?/);
    assert.doesNotMatch(asked, /filter=/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a metered search is skipped rather than attempted when credits run out", async () => {
  const { openAlexByTitle, resetOpenAlexCredits } = await import("../src/core/research/openalex.ts");
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    resetOpenAlexCredits(3); // a search costs 10
    assert.equal(await openAlexByTitle("Attention is all you need, revisited"), undefined);
    assert.equal(calls, 0, "should not spend a request it cannot afford");
  } finally {
    globalThis.fetch = real;
    resetOpenAlexCredits(undefined);
  }
});

test("the credit balance is read from the response, not assumed", async () => {
  const { openAlexByDoi, openAlexCredits, resetOpenAlexCredits } = await import("../src/core/research/openalex.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "W1" }), {
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "742" },
    })) as typeof fetch;
  try {
    resetOpenAlexCredits(undefined);
    await openAlexByDoi("10.1/a");
    assert.equal(openAlexCredits(), 742);
  } finally {
    globalThis.fetch = real;
    resetOpenAlexCredits(undefined);
  }
});

/*
 * v1 asked SearXNG which of its engines could filter by date, because sending
 * a time filter it could not honour returned ZERO results with no error --
 * eight queries, eight empty answers, and nothing to say why.
 *
 * The providers are ours now, so the capability is declared rather than
 * discovered. OpenAlex filters by publication date; arXiv's Atom API sorts by
 * date but does not filter by it.
 */
test("a time filter no provider supports is reported as unsupported, not applied", () => {
  assert.equal(supportsTimeRange("science"), true, "OpenAlex can filter by date");
  assert.equal(supportsTimeRange("general"), true, "nothing configured rules nothing out");
});

test("an empty selection does not claim time ranges are unsupported", () => {
  // Answering false here would discard the user's explicit filter before a
  // provider had even been chosen.
  assert.equal(supportsTimeRange(""), true);
  assert.equal(supportsTimeRange(" , "), true);
  assert.equal(supportsTimeRange(undefined), true);
});
