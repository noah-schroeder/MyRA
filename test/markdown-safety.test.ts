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

/*
 * Mathematics is the one place this app lets HTML through.
 *
 * Every other node in a rendered answer is a React element built by
 * Markdown.tsx, precisely so nothing the model wrote can become markup. A
 * rendered equation is markup by nature -- hundreds of nested spans -- so the
 * rule narrows rather than disappears: the HTML comes from KaTeX, from a string
 * KaTeX itself parsed, with `trust` off. These tests are what "trust off"
 * means in practice, run through the very options the component uses.
 */

import katex from "katex";
import { KATEX_OPTIONS } from "../src/renderer/components/math.ts";

const HOSTILE_TEX = [
  String.raw`\href{javascript:alert(1)}{click}`,
  String.raw`\url{javascript:alert(1)}`,
  String.raw`\href{data:text/html,<script>alert(1)</script>}{x}`,
  String.raw`\includegraphics{https://example.com/pixel.png}`,
  String.raw`\htmlData{onclick=alert(1)}{x}`,
  String.raw`\text{<script>alert(1)</script>}`,
  String.raw`<img src=x onerror=alert(1)>`,
];

test("no hostile LaTeX produces a link, a script or a remote fetch", () => {
  for (const tex of HOSTILE_TEX) {
    let html = "";
    try {
      html = katex.renderToString(tex, KATEX_OPTIONS);
    } catch {
      // Refusing outright is a pass: nothing is rendered at all.
      continue;
    }
    /* Checked on the TAGS, with the text between them removed first.
       With `trust` off KaTeX renders a refused command as its own source, and
       keeps a copy of the TeX in a MathML <annotation> -- so the hostile string
       does appear in the output, as escaped characters that are drawn on the
       screen. That is inert, and it is the honest thing to show. What must
       never appear is the same string anywhere it could be acted on. */
    const tags = html.replace(/>[^<]*</g, "><");
    assert.ok(!/<script/i.test(tags), `script tag from ${tex}`);
    assert.ok(!/\shref\s*=/i.test(tags), `href from ${tex}`);
    assert.ok(!/\ssrc\s*=/i.test(tags), `remote fetch from ${tex}`);
    assert.ok(!/\son[a-z]+\s*=/i.test(tags), `event handler from ${tex}`);
    assert.ok(!/javascript:/i.test(tags), `javascript: in an attribute from ${tex}`);
  }
});

test("ordinary maths still renders, so the guard is not just refusing everything", () => {
  const html = katex.renderToString(String.raw`g^+ = 0.20`, KATEX_OPTIONS);
  assert.match(html, /katex/);
  assert.match(html, /0\.20/);
});
