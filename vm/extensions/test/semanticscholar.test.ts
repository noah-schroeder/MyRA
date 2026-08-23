/**
 * Semantic Scholar's batch response is POSITIONAL and contains nulls for ids it
 * does not know, so the request order is the only thing tying a PDF back to the
 * paper that asked for it. Getting that wrong would attach one paper's full
 * text to another's citation -- silently, and with a real URL to back it up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRepositoryCopy, s2OpenAccessPdfs } from "../research/semanticscholar.ts";

function withResponse(handler: (body: unknown) => unknown, run: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: RequestInit) =>
    new Response(JSON.stringify(handler(JSON.parse(String(init?.body ?? "{}")))), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

test("a null in the middle of the batch does not shift the results", async () => {
  await withResponse(
    () => [
      { externalIds: { DOI: "10.1/a" }, openAccessPdf: { url: "https://a.pdf", status: "GREEN" } },
      null, // Semantic Scholar has never heard of the second DOI
      { externalIds: { DOI: "10.3/c" }, openAccessPdf: { url: "https://c.pdf", status: "GOLD" } },
    ],
    async () => {
      const got = await s2OpenAccessPdfs(["10.1/a", "10.2/b", "10.3/c"]);
      assert.equal(got.get("10.1/a")?.url, "https://a.pdf");
      assert.equal(got.get("10.2/b"), undefined);
      assert.equal(got.get("10.3/c")?.url, "https://c.pdf");
    },
  );
});

test("DOIs are matched case-insensitively, as publishers write them either way", async () => {
  await withResponse(
    () => [{ externalIds: { DOI: "10.1093/Bioinformatics/BTAC112" }, openAccessPdf: { url: "https://x.pdf" } }],
    async () => {
      const got = await s2OpenAccessPdfs(["10.1093/bioinformatics/btac112"]);
      assert.equal(got.get("10.1093/bioinformatics/btac112")?.url, "https://x.pdf");
    },
  );
});

test("a paper with no open PDF is absent rather than present-and-empty", async () => {
  await withResponse(
    () => [{ externalIds: { DOI: "10.1/closed" }, openAccessPdf: null }],
    async () => {
      assert.equal((await s2OpenAccessPdfs(["10.1/closed"])).size, 0);
    },
  );
});

test("a rate limit degrades to no results, never to a failed run", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    assert.equal((await s2OpenAccessPdfs(["10.1/a"])).size, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test("an outage degrades to no results, never to a failed run", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ENOTFOUND");
  }) as typeof fetch;
  try {
    assert.equal((await s2OpenAccessPdfs(["10.1/a"])).size, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test("only a repository copy carries a version-of-record caveat", () => {
  // GREEN is an author manuscript; the rest are the publisher's own PDF.
  assert.equal(isRepositoryCopy("GREEN"), true);
  assert.equal(isRepositoryCopy("green"), true);
  assert.equal(isRepositoryCopy("GOLD"), false);
  assert.equal(isRepositoryCopy("HYBRID"), false);
  assert.equal(isRepositoryCopy("BRONZE"), false);
  assert.equal(isRepositoryCopy(undefined), false);
});
