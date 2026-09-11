/**
 * What a search says when one backend is down.
 *
 * arXiv rate-limits hard and has real outages -- during the writing of this
 * test its API returned 503 and then stopped answering altogether -- while
 * OpenAlex kept working. That combination used to produce a half-size result
 * set with nothing anywhere saying why, which reads as a thin literature
 * rather than a thin search. These tests pin the reporting, not the weather.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { arxivQuery } from "../src/core/research/arxiv.ts";
import { search } from "../src/core/research/providers.ts";
import { NoProviderError, type SearchProvider } from "../src/core/research/types.ts";

const ok = (id: string, n: number): SearchProvider => ({
  id,
  label: id,
  scholarly: true,
  timeRange: false,
  search: async () =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://ex.test/${id}/${i}`,
      title: `${id} ${i}`,
      content: "",
      engine: id,
    })),
});

const dead = (id: string, err: Error): SearchProvider => ({
  id,
  label: id,
  scholarly: true,
  timeRange: false,
  search: async () => {
    throw err;
  },
});

/* The registry is module-level, so these drive `search` through its options
   rather than mutating it -- see `providersOverride` in SearchOptions. */
const via = (providers: SearchProvider[]) => ({ categories: "science", providers });

test("a working backend still returns results when the other one is down", async () => {
  const out = await search("q", via([ok("openalex", 3), dead("arxiv", new Error("503"))]));
  assert.equal(out.hits.length, 3);
});

test("the backend that failed is named, so half a sweep is not read as the whole", async () => {
  const out = await search("q", via([ok("openalex", 3), dead("arxiv", new Error("503"))]));
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0] ?? "", /arxiv/);
  assert.match(out.failures[0] ?? "", /503/);
});

test("a timeout is reported in words rather than as an abort message", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
  const out = await search("q", via([ok("openalex", 1), dead("arxiv", timeout)]));
  assert.match(out.failures[0] ?? "", /did not respond in time/);
  assert.doesNotMatch(out.failures[0] ?? "", /aborted/);
});

test("nothing is reported when every backend answered", async () => {
  const out = await search("q", via([ok("openalex", 2), ok("arxiv", 2)]));
  assert.deepEqual(out.failures, []);
  assert.equal(out.hits.length, 4);
});

test("every backend failing is an error, not an empty result set", async () => {
  await assert.rejects(
    () => search("q", via([dead("openalex", new Error("429")), dead("arxiv", new Error("503"))])),
    NoProviderError,
  );
});

test("an explicitly empty provider list is an empty result, not a thrown error", async () => {
  // resolveProviders returns [] with its own specific reason (e.g. "PubMed
  // skipped — no API key is stored for it") when every chosen database has
  // lost its key. Throwing a generic NoProviderError here discarded that
  // reason before the caller's own message could ever be built -- only an
  // OMITTED providers option (nothing was ever chosen) should throw.
  const out = await search("q", { categories: "science", providers: [] });
  assert.deepEqual(out, { hits: [], failures: [] });
});

test("no providers option at all still throws -- there is genuinely nothing configured", async () => {
  await assert.rejects(() => search("q", { categories: "general" }), NoProviderError);
});

/* ------------------------------------------------------------ arXiv query -- */

/*
 * The bug this file was opened for.
 *
 * Every arXiv query was wrapped in quotes, making it an exact phrase search.
 * Measured against the live API at the time of writing:
 *
 *   all:"transformer attention mechanism"            ->       74 results
 *   all:"qualitative coding inter-rater reliability" ->        0 results
 *
 * Four ordinary words returned nothing, so arXiv contributed nothing to a
 * merged search and Quick mode looked like OpenAlex on its own.
 */

test("a multi-word query is ANDed, not searched as an exact phrase", () => {
  assert.equal(
    arxivQuery("transformer attention mechanism"),
    "all:transformer AND all:attention AND all:mechanism",
  );
});

test("no query reaches arXiv wrapped in quotes", () => {
  for (const q of ["transformer attention", "a b c", "one"]) {
    assert.doesNotMatch(arxivQuery(q), /"/, q);
  }
});

test("stopwords are dropped, because an AND on 'the' can exclude a paper", () => {
  assert.equal(
    arxivQuery("What is the effect of climate policy on adaptation?"),
    "all:effect AND all:climate AND all:policy AND all:adaptation",
  );
});

test("syntax characters are stripped rather than passed to arXiv's parser", () => {
  const q = arxivQuery('"quoted" (parens) [brackets] ^caret ~tilde');
  assert.doesNotMatch(q, /["()[\]^~]/);
});

test("a long query is capped, so the ANDs focus rather than exclude", () => {
  const many = arxivQuery("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron");
  assert.equal(many.split(" AND ").length, 12);
});

test("a query of nothing but stopwords still asks arXiv something", () => {
  const q = arxivQuery("the of and");
  assert.ok(q.startsWith("all:"), q);
  assert.doesNotMatch(q, /AND/);
});
