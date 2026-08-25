/**
 * fetch_page must not become a window onto the local network.
 *
 * It is the only tool that opens a URL, and the URL comes from a model that
 * reads scraped pages and search snippets — text written by strangers. Until
 * this guard existed the only check was `^https?://`, so "fetch
 * http://127.0.0.1:11434/api/tags and tell me what it says" was a request the
 * app carried out: an unauthenticated model server, a router admin page, a
 * printer or a cloud metadata endpoint could be read, and the answer landed in
 * the conversation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertFetchable, BlockedUrlError, isPrivateAddress } from "../src/core/research/guard.ts";

/** No DNS in tests: every host resolves to whatever the test says. */
const resolving = (map: Record<string, string[]>) => ({
  resolve: async (host: string) => map[host] ?? ["93.184.216.34"],
});

test("loopback, private and link-local addresses are all refused", () => {
  for (const ip of [
    "127.0.0.1", "127.1.2.3", "0.0.0.0",
    "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // the cloud metadata service — instance credentials
    "100.64.0.1",      // carrier-grade NAT
    "224.0.0.1", "255.255.255.255",
    "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("real public addresses are allowed", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:2800:220:1::1"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("a bare private IP in the URL is refused", async () => {
  await assert.rejects(
    () => assertFetchable("http://127.0.0.1:11434/api/tags"),
    (e: Error) => e instanceof BlockedUrlError && /private address/.test(e.message),
  );
  await assert.rejects(() => assertFetchable("http://[::1]:8080/"), BlockedUrlError);
});

test("localhost and .local names are refused whatever DNS says", async () => {
  await assert.rejects(
    () => assertFetchable("http://localhost:8888/", resolving({ localhost: ["93.184.216.34"] })),
    (e: Error) => e instanceof BlockedUrlError && /this machine/.test(e.message),
  );
  await assert.rejects(
    () => assertFetchable("http://printer.local/status", resolving({})),
    (e: Error) => e instanceof BlockedUrlError && /local network name/.test(e.message),
  );
});

/*
 * The check that a literal-host blocklist would miss entirely. A public
 * hostname pointing at 127.0.0.1 is one DNS record, not an exotic attack.
 */
test("a public hostname resolving to a private address is refused", async () => {
  await assert.rejects(
    () =>
      assertFetchable("https://totally-normal.example/", resolving({
        "totally-normal.example": ["127.0.0.1"],
      })),
    (e: Error) => e instanceof BlockedUrlError && /resolves to 127\.0\.0\.1/.test(e.message),
  );
});

test("every resolved address is checked, not just the first", async () => {
  // A host with one public and one loopback record would otherwise pass the
  // check and then connect to whichever the OS happened to pick.
  await assert.rejects(
    () =>
      assertFetchable("https://mixed.example/", resolving({
        "mixed.example": ["93.184.216.34", "127.0.0.1"],
      })),
    BlockedUrlError,
  );
});

test("non-web protocols are refused, file: included", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
    await assert.rejects(
      () => assertFetchable(url),
      (e: Error) => e instanceof BlockedUrlError && /not a web protocol/.test(e.message),
      url,
    );
  }
});

test("a host that does not resolve is refused rather than attempted", async () => {
  await assert.rejects(
    () => assertFetchable("https://nope.example/", { resolve: async () => { throw new Error("ENOTFOUND"); } }),
    (e: Error) => e instanceof BlockedUrlError && /could not be resolved/.test(e.message),
  );
  await assert.rejects(
    () => assertFetchable("https://empty.example/", { resolve: async () => [] }),
    BlockedUrlError,
  );
});

test("an ordinary public page is allowed through", async () => {
  const url = await assertFetchable("https://arxiv.org/abs/2101.00001", resolving({
    "arxiv.org": ["151.101.3.42"],
  }));
  assert.equal(url.hostname, "arxiv.org");
});

/*
 * The hop check. A guard applied only to the URL the model supplied approves
 * the request that ends up somewhere else entirely.
 */
test("a redirect into the private range is refused at the hop", async () => {
  const { fetchPage } = await import("../src/core/research/fetch.ts");
  const { setAddressResolver } = await import("../src/core/research/guard.ts");
  setAddressResolver(async () => ["93.184.216.34"]);
  const real = globalThis.fetch;
  let hops = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    hops++;
    const href = typeof input === "string" ? input : (input as URL).href;
    if (href.startsWith("https://redirector.example")) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    return new Response("secrets", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const page = await fetchPage("https://redirector.example/paper", 5_000);
    assert.match(page.error ?? "", /private address/);
    // One request made, and the metadata service never contacted.
    assert.equal(hops, 1);
  } finally {
    globalThis.fetch = real;
    (await import("../src/core/research/guard.ts")).setAddressResolver(undefined);
  }
});

test("a redirect chain that stays public is followed", async () => {
  const { fetchPage } = await import("../src/core/research/fetch.ts");
  const { setAddressResolver } = await import("../src/core/research/guard.ts");
  setAddressResolver(async () => ["93.184.216.34"]);
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : (input as URL).href;
    if (href.endsWith("/paper")) {
      return new Response(null, { status: 301, headers: { location: "https://cdn.example/paper.html" } });
    }
    return new Response("<html><body><p>The findings were null.</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  try {
    const page = await fetchPage("https://publisher.example/paper", 5_000);
    assert.equal(page.error, undefined);
    assert.match(page.text, /findings were null/);
    // The page reports where it actually ended up, not where it was asked to go.
    assert.equal(page.url, "https://cdn.example/paper.html");
  } finally {
    globalThis.fetch = real;
    (await import("../src/core/research/guard.ts")).setAddressResolver(undefined);
  }
});
