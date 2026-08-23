import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRegistered, registerHits, registeredSources, resetRegistry } from "../research/registry.ts";

const hit = (url: string, title = url) => ({ url, title, content: "snippet" });

test("a number belongs to a URL for the whole session, not to a search", () => {
  resetRegistry();
  const first = registerHits([hit("https://a.example"), hit("https://b.example")]);
  assert.deepEqual(first.map((s) => s.n), [1, 2]);

  // A later, unrelated search that turns up the same page must reuse its
  // number -- otherwise [1] means two different things in one transcript, and
  // no link in the GUI can be trusted.
  const second = registerHits([hit("https://c.example"), hit("https://a.example")]);
  assert.deepEqual(second.map((s) => s.n), [3, 1]);
});

test("the same page found under a different URL form keeps one number", () => {
  resetRegistry();
  registerHits([hit("https://example.com/paper?utm_source=x")]);
  const again = registerHits([hit("https://example.com/paper")]);
  assert.equal(again[0]!.n, 1, "tracking parameters must not mint a second number");
});

test("a hit with no URL is skipped rather than numbered", () => {
  resetRegistry();
  const out = registerHits([{ url: "", title: "nowhere", content: "" }, hit("https://a.example")]);
  assert.deepEqual(out.map((s) => s.n), [1]);
  assert.equal(registeredSources().length, 1);
});

test("a new session starts numbering again at one", () => {
  resetRegistry();
  registerHits([hit("https://a.example")]);
  resetRegistry();
  assert.deepEqual(registerHits([hit("https://z.example")]).map((s) => s.n), [1]);
});

test("the printed list uses assigned numbers, not the position in this result set", () => {
  resetRegistry();
  registerHits([hit("https://a.example"), hit("https://b.example")]);
  const text = formatRegistered(registerHits([hit("https://b.example")]));
  assert.match(text, /^\[2\] /, "a repeat must print as its original number");
});
