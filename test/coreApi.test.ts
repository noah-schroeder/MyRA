/**
 * CORE's `/search/works` response, parsed defensively -- CORE aggregates from
 * thousands of repositories and its metadata is the least uniform of the
 * four databases.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseCoreResults } from "../src/core/research/coreApi.ts";

test("a fullText field is discarded and never reaches the hit", () => {
  const [r] = parseCoreResults({
    results: [
      {
        id: "123", title: "A paper", authors: [{ name: "A. Uthor" }],
        abstract: "An abstract.", fullText: "x".repeat(500_000),
      },
    ],
  });
  assert.equal(r?.title, "A paper");
  assert.equal("fullText" in (r ?? {}), false);
});

test("authors come back as plain names, whether CORE sent objects or strings", () => {
  const [r] = parseCoreResults({
    results: [{ id: "1", title: "T", authors: [{ name: "Jane Smith" }, "John Doe", { name: "" }] }],
  });
  assert.deepEqual(r?.authors, ["Jane Smith", "John Doe"]);
});

test("a record with no title is skipped", () => {
  assert.deepEqual(parseCoreResults({ results: [{ id: "1", doi: "10.1/x" }] }), []);
});

test("a record with a title but no identifying URL is skipped -- nothing to cite it by", () => {
  assert.deepEqual(parseCoreResults({ results: [{ title: "No id at all" }] }), []);
});

test("any one of id, doi or downloadUrl is enough to keep a record", () => {
  const results = parseCoreResults({
    results: [
      { title: "By id", id: "1" },
      { title: "By doi", doi: "10.1/x" },
      { title: "By download", downloadUrl: "https://example.test/paper.pdf" },
    ],
  });
  assert.equal(results.length, 3);
});

test("year, doi and downloadUrl come through when CORE sent them", () => {
  const [r] = parseCoreResults({
    results: [
      {
        id: "1", title: "T", yearPublished: 2019, doi: "10.1/x",
        downloadUrl: "https://example.test/p.pdf", publisher: "A Press",
      },
    ],
  });
  assert.equal(r?.year, 2019);
  assert.equal(r?.doi, "10.1/x");
  assert.equal(r?.downloadUrl, "https://example.test/p.pdf");
  assert.equal(r?.publisher, "A Press");
});

test("a malformed or missing results array parses to nothing rather than throwing", () => {
  assert.deepEqual(parseCoreResults({}), []);
  assert.deepEqual(parseCoreResults(undefined), []);
  assert.deepEqual(parseCoreResults({ results: "not an array" }), []);
});
