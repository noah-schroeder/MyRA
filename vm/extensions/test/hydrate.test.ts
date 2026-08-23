/**
 * The scholarly gate, and the identifiers that drive hydration.
 *
 * The gate matters because it decides whether a research run touches OpenAlex
 * at all: a general web sweep must make zero calls, and a scholarly sweep must
 * make them even when the category is not literally named "science".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { arxivDoiFromUrl, doiFromUrl } from "../research/hydrate.ts";
import { isScholarlyCategory, resetCategoryCache, supportsTimeRange } from "../research/categories.ts";

/** Stand in for SearXNG's /config, shaped exactly as the real one. */
function withSearxngConfig<T>(
  engines: { name: string; enabled: boolean; categories: string[] }[],
  body: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ engines }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  resetCategoryCache();
  return body().finally(() => {
    globalThis.fetch = real;
    resetCategoryCache();
  });
}

const REAL_ENGINES = [
  { name: "duckduckgo", enabled: true, categories: ["general", "web"] },
  { name: "wikipedia", enabled: true, categories: ["general"] },
  { name: "google news", enabled: true, categories: ["news"] },
  { name: "arxiv", enabled: true, categories: ["science", "scientific publications"] },
  { name: "pubmed", enabled: true, categories: ["science", "scientific publications"] },
  { name: "pdbe", enabled: true, categories: ["science"] },
];

test("scholarly categories come from the engines behind them, not the name", async () => {
  await withSearxngConfig(REAL_ENGINES, async () => {
    assert.equal(await isScholarlyCategory("science"), true);
    // The one a name check on "science" would miss -- and the user has it.
    assert.equal(await isScholarlyCategory("scientific publications"), true);
    assert.equal(await isScholarlyCategory("general"), false);
    assert.equal(await isScholarlyCategory("news"), false);
    assert.equal(await isScholarlyCategory("it"), false);
    assert.equal(await isScholarlyCategory(""), false);
  });
});

test("a renamed category is still scholarly if scholarly engines back it", async () => {
  await withSearxngConfig(
    [{ name: "semantic scholar", enabled: true, categories: ["papers"] }],
    async () => {
      assert.equal(await isScholarlyCategory("papers"), true);
    },
  );
});

test("a category with no scholarly engine behind it is not hydrated", async () => {
  await withSearxngConfig(
    [
      { name: "wttr.in", enabled: true, categories: ["science"] },
      { name: "duckduckgo", enabled: true, categories: ["general"] },
    ],
    async () => {
      assert.equal(await isScholarlyCategory("science"), false);
    },
  );
});

/*
 * SearXNG's `enabled` flag is the DEFAULT STATE OF THE TOGGLE on its own
 * preferences page -- a per-browser cookie setting. It is not whether the
 * engine answers an API search. Measured against the live instance: openalex
 * and crossref both report enabled:false, and both return results for
 * ?categories=scientific+publications; `books` has zero engines marked enabled
 * and still returns results. Gating on the flag skipped hydration for
 * categories that really are scholarly.
 */
test("an engine SearXNG reports as disabled still counts, because it still answers", async () => {
  await withSearxngConfig(
    [{ name: "openalex", enabled: false, categories: ["scientific publications"] }],
    async () => {
      assert.equal(await isScholarlyCategory("scientific publications"), true);
    },
  );
});

test("one scholarly category among several is enough to hydrate", async () => {
  await withSearxngConfig(REAL_ENGINES, async () => {
    assert.equal(await isScholarlyCategory("science,news"), true);
    assert.equal(await isScholarlyCategory("news,scientific publications"), true);
    // Spacing is the user's, not ours: the plan document is hand-editable.
    assert.equal(await isScholarlyCategory("news, science"), true);
    assert.equal(await isScholarlyCategory("general,news"), false);
    assert.equal(await isScholarlyCategory(" , "), false);
  });
});

test("an unreachable SearXNG falls back to the name rather than failing the run", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  resetCategoryCache();
  try {
    assert.equal(await isScholarlyCategory("science"), true);
    assert.equal(await isScholarlyCategory("scientific publications"), true);
    assert.equal(await isScholarlyCategory("general"), false);
  } finally {
    globalThis.fetch = real;
    resetCategoryCache();
  }
});

test("doiFromUrl pulls the identifier out of the URLs SearXNG actually returns", () => {
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
  const { makeSourceRecord, renderBibliography } = await import("../research/sources.ts");
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
  const { openAlexByDoi } = await import("../research/openalex.ts");
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
  const { openAlexByTitle, resetOpenAlexCredits } = await import("../research/openalex.ts");
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
  const { openAlexByDoi, openAlexCredits, resetOpenAlexCredits } = await import("../research/openalex.ts");
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
 * The failure this encodes: SearXNG drops every engine lacking time-range
 * support when `time_range` is set. For a scholarly category that leaves none,
 * so the search returns zero results with no error. Measured on the live
 * instance: "scientific publications" gives 50 hits unfiltered and 0 with
 * time_range=year. A model that volunteered time_range:"year" concluded, over
 * eight consecutive empty searches, that its search tool was broken.
 */
const TIME_RANGE_ENGINES = [
  { name: "duckduckgo", enabled: true, categories: ["general"], time_range_support: true },
  { name: "google news", enabled: true, categories: ["news"], time_range_support: true },
  { name: "arxiv", enabled: true, categories: ["science", "scientific publications"] },
  { name: "pubmed", enabled: true, categories: ["science", "scientific publications"] },
  { name: "openalex", enabled: false, categories: ["scientific publications"] },
];

test("a time filter no engine supports is reported as unsupported, not applied", async () => {
  await withSearxngConfig(TIME_RANGE_ENGINES as never, async () => {
    assert.equal(await supportsTimeRange("scientific publications"), false);
    assert.equal(await supportsTimeRange("science"), false);
    assert.equal(await supportsTimeRange("general"), true);
    assert.equal(await supportsTimeRange("news"), true);
  });
});

test("one time-capable category in the selection is enough to keep the filter", async () => {
  await withSearxngConfig(TIME_RANGE_ENGINES as never, async () => {
    assert.equal(await supportsTimeRange("science,news"), true);
    assert.equal(await supportsTimeRange("science,scientific publications"), false);
  });
});

test("an unverifiable time filter is honoured rather than silently discarded", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  resetCategoryCache();
  try {
    // Better to pass a filter through and get nothing than to drop the user's
    // explicit choice because SearXNG happened to be unreachable.
    assert.equal(await supportsTimeRange("science"), true);
  } finally {
    globalThis.fetch = real;
    resetCategoryCache();
  }
});

test("an empty selection does not claim time ranges are unsupported", async () => {
  await withSearxngConfig(TIME_RANGE_ENGINES as never, async () => {
    assert.equal(await supportsTimeRange(""), true);
    assert.equal(await supportsTimeRange(" , "), true);
  });
});
