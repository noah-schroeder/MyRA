import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { isSafeExternalUrl } from "../src/shared/safeUrl.ts";

/*
 * marked's own docs carry a loud warning: it does not sanitize output HTML, and
 * anyone rendering untrusted markdown needs DOMPurify or similar.
 *
 * That warning is about marked.parse(), which returns an HTML STRING you then
 * inject. This app never calls it. It uses marked.lexer() and builds React
 * elements from the tokens, so there is no HTML string and no injection point --
 * React escapes every text child, and no element is created that Markdown.tsx
 * does not construct itself.
 *
 * Two things must stay true for that to hold, and both are tested here:
 *   1. an href only becomes a live link if it is http(s)
 *   2. an `html` token is shown as literal text, never interpreted
 *
 * The input really is hostile: it is model output quoting pages the agent
 * fetched from the open web.
 */

/** Every href the lexer finds, at any depth. */
function hrefs(markdown: string): string[] {
  const out: string[] = [];
  const walk = (tokens: any[]) => {
    for (const t of tokens ?? []) {
      if (t.type === "link") out.push(t.href);
      if (t.tokens) walk(t.tokens);
      if (t.items) for (const i of t.items) walk(i.tokens);
      if (t.header) for (const c of t.header) walk(c.tokens);
      if (t.rows) for (const r of t.rows) for (const c of r) walk(c.tokens);
    }
  };
  walk(marked.lexer(markdown, { gfm: true, breaks: true }));
  return out;
}

const HOSTILE = [
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](java&#115;cript:alert(1))",
  "[click](  javascript:alert(1))",
  "[click](vbscript:msgbox(1))",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[click](file:///etc/passwd)",
  "<javascript:alert(1)>",
  "| a | b |\n| --- | --- |\n| [x](javascript:alert(1)) | y |",
  "- [x](javascript:alert(1))",
  "> [x](javascript:alert(1))",
];

test("no hostile scheme survives as a clickable link", () => {
  for (const markdown of HOSTILE) {
    for (const href of hrefs(markdown)) {
      assert.equal(isSafeExternalUrl(href), false, `${markdown} produced a live link to ${href}`);
    }
  }
});

test("ordinary links still work, at any nesting depth", () => {
  assert.deepEqual(hrefs("[ok](https://example.com/a)").filter(isSafeExternalUrl).length, 1);
  assert.equal(hrefs("| a |\n| --- |\n| [k](https://example.com/t) |").filter(isSafeExternalUrl).length, 1);
  assert.equal(hrefs("- [k](http://example.com/l)").filter(isSafeExternalUrl).length, 1);
});

test("the rule is an allowlist, not a scheme denylist", () => {
  // A denylist loses to the next encoding trick; this must reject by default.
  assert.equal(isSafeExternalUrl("gopher://x"), false);
  assert.equal(isSafeExternalUrl("//evil.example.com"), false);
  assert.equal(isSafeExternalUrl("/local/path"), false);
  assert.equal(isSafeExternalUrl("ftp://x"), false);
  assert.equal(isSafeExternalUrl("HTTPS://example.com"), true, "scheme is case-insensitive");
});

test("non-strings and empty hrefs are refused rather than thrown on", () => {
  for (const bad of [undefined, null, 42, {}, [], "", "https://", "http://"]) {
    assert.equal(isSafeExternalUrl(bad), false);
  }
});

test("inline HTML stays a token to be printed, never an element to be run", () => {
  // Markdown.tsx renders `html` tokens as text children, which React escapes.
  for (const markdown of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<a href="javascript:alert(1)">c</a>']) {
    const tokens = marked.lexer(markdown, { gfm: true, breaks: true });
    const flat = JSON.stringify(tokens);
    assert.match(flat, /"type":"html"/, `${markdown} should lex as html, and so be printed literally`);
    assert.equal(hrefs(markdown).length, 0, `${markdown} must not yield a link token`);
  }
});
