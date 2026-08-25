/**
 * Backward citation traversal, and the filter that makes it worth doing.
 *
 * `referenced_works` was already being fetched on every hit and only its
 * LENGTH was ever used. The reason to traverse it is that keyword search finds
 * papers whose title uses the vocabulary you searched for, and the foundational
 * paper of a literature usually does not — it predates that vocabulary and
 * surfaces only because everyone cites it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { coCitationThreshold, coCitedWorks } from "../src/core/research/snowball.ts";

test("a work several seeds cite outranks one that only appears often in a single seed", () => {
  const seeds = [
    ["W_foundational", "W_a", "W_a", "W_a"],
    ["W_foundational", "W_b"],
    ["W_foundational", "W_c"],
  ];
  const ranked = coCitedWorks(seeds, { threshold: 2, limit: 10 });
  assert.deepEqual(ranked, [{ id: "W_foundational", citedBy: 3 }]);
  // Repeats inside one seed must not accumulate, or a single paper could push
  // its own references over the threshold on its own.
  assert.ok(!ranked.some((r) => r.id === "W_a"));
});

test("works below the threshold are left out entirely", () => {
  const seeds = [["W1", "W2"], ["W1"], ["W3"]];
  assert.deepEqual(
    coCitedWorks(seeds, { threshold: 2, limit: 10 }).map((c) => c.id),
    ["W1"],
  );
});

test("candidates already found by the sweep are excluded", () => {
  const seeds = [["W_known", "W_new"], ["W_known", "W_new"]];
  const ranked = coCitedWorks(seeds, {
    threshold: 2,
    limit: 10,
    exclude: (id) => id === "W_known",
  });
  assert.deepEqual(ranked.map((c) => c.id), ["W_new"]);
});

test("ties are broken deterministically, so a run is reproducible", () => {
  const seeds = [["Wb", "Wa"], ["Wa", "Wb"]];
  const once = coCitedWorks(seeds, { threshold: 2, limit: 10 }).map((c) => c.id);
  const again = coCitedWorks([["Wa", "Wb"], ["Wb", "Wa"]], { threshold: 2, limit: 10 }).map((c) => c.id);
  assert.deepEqual(once, again);
  assert.deepEqual(once, ["Wa", "Wb"]);
});

test("the limit caps how much extra screening a round can cause", () => {
  const many = Array.from({ length: 300 }, (_, i) => `W${i}`);
  const ranked = coCitedWorks([many, many], { threshold: 2, limit: 50 });
  assert.equal(ranked.length, 50);
});

test("seeds with no references at all are harmless", () => {
  assert.deepEqual(coCitedWorks([undefined, undefined], { threshold: 1, limit: 10 }), []);
  assert.deepEqual(coCitedWorks([], { threshold: 1, limit: 10 }), []);
});

test("with few seeds the threshold drops rather than returning nothing", () => {
  // Five papers rarely share a reference, and a traversal that silently finds
  // nothing is worse than a slightly noisier one.
  assert.equal(coCitationThreshold(3), 1);
  assert.equal(coCitationThreshold(5), 2);
  assert.equal(coCitationThreshold(40), 2);
});

test("openAlexByIds batches at fifty and tolerates a failed batch", async () => {
  const { openAlexByIds } = await import("../src/core/research/openalex.ts");
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    // The second batch fails: the run must keep what the first one produced.
    if (seen.length === 2) return new Response("nope", { status: 503 });
    return new Response(JSON.stringify({ results: [{ id: "W1", title: "A paper" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const ids = Array.from({ length: 120 }, (_, i) => `W${i + 1}`);
    const works = await openAlexByIds(ids);
    assert.equal(seen.length, 3, "120 ids should be three batches of fifty");
    assert.equal(works.length, 2, "the failed batch contributes nothing, the others still count");
    // A filtered query costs 1 credit however many ids it names; a search costs 10.
    assert.match(seen[0]!, /filter=openalex%3AW1%7CW2/);
  } finally {
    globalThis.fetch = real;
  }
});

test("openAlexByIds accepts full OpenAlex URLs as well as bare ids", async () => {
  const { openAlexByIds } = await import("../src/core/research/openalex.ts");
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    // referenced_works comes back as full URLs, which is what makes this matter.
    await openAlexByIds(["https://openalex.org/W123", "W456", "not-an-id"]);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /W123%7CW456/);
    assert.ok(!seen[0]!.includes("not-an-id"));
  } finally {
    globalThis.fetch = real;
  }
});
