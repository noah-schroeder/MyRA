/**
 * Making a registry README readable, without making it dangerous.
 *
 * The card that motivated all of this is `unsloth/Qwen3-8B-GGUF`: 20 KB, eleven
 * lines of YAML front matter, and prose that opens inside a `<div>` full of
 * inline styles. `Markdown.tsx` renders an `html` token as the literal text of
 * the tag -- deliberately, because it builds React elements and never markup --
 * so handed that unprepared it is correct and unreadable.
 *
 * These fix the reduction: what survives (text, links, table rows), what does
 * not (scripts, styles, images), and what must never be touched (fenced code,
 * which is where a card documents HTML on purpose).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  CARD_LIMIT, prepareCard, readCardMeta, readFrontMatter, splitFrontMatter, tidyMarkdown,
  unwrapHtml,
} from "../src/core/runtime/modelCard.ts";

/* The real head of that card, trimmed. Kept verbatim rather than idealised:
   the `style` attribute, the unclosed layout and the nested `<strong>` inside
   the link are all things that were actually on screen. */
const REAL = `---
base_model: Qwen/Qwen3-8B
language:
- en
library_name: transformers
license_link: https://huggingface.co/Qwen/Qwen3-8B/blob/main/LICENSE
license: apache-2.0
tags:
- qwen3
- unsloth
---
<div>
  <p style="margin-bottom: 0; margin-top: 0;">
    <strong>See <a href="https://huggingface.co/collections/unsloth/qwen3">our collection</a> for all versions</strong>
  </p>
  <img src="https://example.invalid/logo.png" alt="logo">
</div>

# Qwen3-8B

Qwen3 is the latest generation.
`;

describe("front matter", () => {
  it("takes the block only when it opens the file", () => {
    const { front, body } = splitFrontMatter(REAL);
    assert.match(front, /license: apache-2\.0/);
    assert.equal(body.startsWith("<div>"), true);
  });

  it("leaves a horizontal rule alone", () => {
    /* `---` further down is a rule, and eating from there to the next one
       would silently swallow the first section of the card. */
    const text = "# Title\n\nSome prose.\n\n---\n\nMore prose.\n";
    const { front, body } = splitFrontMatter(text);
    assert.equal(front, "");
    assert.equal(body, text);
  });

  it("reads scalars and lists, and skips what it cannot", () => {
    const fields = readFrontMatter(
      "license: mit\nlanguage:\n- en\n- fr\nmodel-index:\n  name: x\n  results: []\ntags:\n- a\n",
    );
    assert.deepEqual(fields.get("license"), ["mit"]);
    assert.deepEqual(fields.get("language"), ["en", "fr"]);
    assert.deepEqual(fields.get("tags"), ["a"]);
    // The nested map yields no value rather than a wrong one.
    assert.deepEqual(fields.get("model-index"), []);
  });

  it("pulls out the licence, which is the fact this exists for", () => {
    const meta = readCardMeta(splitFrontMatter(REAL).front);
    assert.equal(meta.license, "apache-2.0");
    assert.equal(meta.licenseLink, "https://huggingface.co/Qwen/Qwen3-8B/blob/main/LICENSE");
    assert.equal(meta.baseModel, "Qwen/Qwen3-8B");
    assert.deepEqual(meta.languages, ["en"]);
  });

  it("unquotes and drops trailing comments", () => {
    const fields = readFrontMatter(`license: "apache-2.0"  # SPDX\nname: 'x'\n`);
    assert.deepEqual(fields.get("license"), ["apache-2.0"]);
    assert.deepEqual(fields.get("name"), ["x"]);
  });
});

describe("unwrapping HTML", () => {
  it("keeps the sentence and the link, and drops the tags", () => {
    const out = unwrapHtml(splitFrontMatter(REAL).body);
    assert.equal(out.includes("<div>"), false);
    assert.equal(out.includes("style="), false);
    assert.match(out, /See \[our collection\]\(https:\/\/huggingface\.co\/collections\/unsloth\/qwen3\) for all versions/);
    assert.match(out, /# Qwen3-8B/);
  });

  it("drops images entirely", () => {
    /* The window is default-deny on the network and its policy allows no
       remote images, so the request would be refused; the alt text of a
       decorative badge is noise. */
    const out = unwrapHtml(REAL);
    assert.equal(/logo/.test(out), false);
  });

  it("loses the contents of script and style, not just their tags", () => {
    const out = unwrapHtml("a<script>alert(1)</script>b<style>.x{color:red}</style>c");
    assert.equal(out, "abc");
  });

  it("closes over an unterminated script", () => {
    // A truncated card can end mid-tag; leaving it alone prints the rest as prose.
    assert.equal(unwrapHtml("before<script>tail that never ends").trim(), "before");
  });

  it("keeps a table legible instead of flattening it to a run of words", () => {
    const out = unwrapHtml("<table><tr><td>Q4_K_M</td><td>4.9 GB</td></tr><tr><td>Q8_0</td><td>8.7 GB</td></tr></table>");
    assert.match(out, /Q4_K_M · 4\.9 GB/);
    assert.match(out, /Q8_0 · 8\.7 GB/);
  });

  it("dedents what came out of HTML, so a link is not read as code", () => {
    /*
     * The rendering this fixes. HTML in a card is indented for readability, and
     * four leading spaces after a blank line is an indented code block -- so
     * the link rebuilt on the line below came out on screen as the literal text
     * `[Read our Guide](https://…)`. Seen on
     * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`.
     */
    const out = unwrapHtml(
      '<div>\n  <p style="x">\n    <em>Learn this - <a href="https://docs.example.com/g">Read our Guide</a>.</em>\n  </p>\n</div>\n',
    );
    for (const line of out.split("\n")) {
      assert.equal(/^\s{4}/.test(line), false, `indented: ${JSON.stringify(line)}`);
    }
    assert.match(out, /Learn this - \[Read our Guide\]\(https:\/\/docs\.example\.com\/g\)\./);
  });

  it("leaves genuine markdown indentation alone", () => {
    /* The reason the dedent is per-line rather than blanket: two- and
       four-space indents are how nested lists are written. */
    const text = "- outer\n  - inner\n    - deeper\n";
    assert.equal(unwrapHtml(text), text);
  });

  it("closes a block properly, so what follows is its own block", () => {
    /* A single newline is not a block boundary: `</ul>` followed by a table row
       leaves the table lazily continuing the last list item, and the whole
       thing renders as one line of pipes. */
    const out = unwrapHtml("<ul><li>one</li><li>two</li></ul>| a | b |\n|---|---|\n");
    assert.match(out, /- one\n- two\n\n\| a \| b \|/);
  });

  it("never touches fenced code", () => {
    /* The one place a card shows HTML on purpose, and exactly the text this
       would otherwise eat. */
    const text = 'Use this:\n\n```html\n<div class="x">hello</div>\n```\n\nDone.\n';
    assert.equal(unwrapHtml(text), text);
  });

  it("does not turn a non-http link into a link", () => {
    const out = unwrapHtml(`<a href="javascript:alert(1)">click</a>`);
    assert.equal(out.trim(), "click");
  });

  it("decodes the entities a card actually uses", () => {
    assert.equal(unwrapHtml("a &amp; b &lt;c&gt; &#39;d&#39;").trim(), "a & b <c> 'd'");
  });
});

describe("the conventions a card uses that a renderer does not", () => {
  it("turns a GitHub alert into a word instead of leaving [!NOTE] on screen", () => {
    /* GitHub and Hugging Face render this as a callout; everything else prints
       the marker, which is what was on the card for granite-4.1-8b. */
    assert.equal(tidyMarkdown("> [!NOTE]\n> Includes fixes\n"), "> **Note**\n> Includes fixes\n");
    assert.equal(tidyMarkdown("> [!WARNING]\n").trim(), "> **Warning**");
  });

  it("leaves an alert inside fenced code alone", () => {
    const text = "```md\n> [!NOTE]\n```\n";
    assert.equal(tidyMarkdown(text), text);
  });

  it("drops badges, including the link they are usually wrapped in", () => {
    /* Cards open with rows of shields.io images whose alt text is things like
       `mof-class3-qualified`. Nothing fetches them, so an image can only become
       its alt, and a line of decorative alt text is noise. */
    assert.equal(
      tidyMarkdown("[![mof-class3](https://img.shields.io/x.svg)](https://example.com) text").trim(),
      "text",
    );
    assert.equal(tidyMarkdown("![logo](https://example.com/l.png)").trim(), "");
  });

  it("does not eat an image inside fenced code", () => {
    const text = "```\n![alt](x.png)\n```\n";
    assert.equal(tidyMarkdown(text), text);
  });
});

describe("preparing a whole card", () => {
  it("returns the licence and prose together", () => {
    const card = prepareCard(REAL);
    assert.equal(card.meta.license, "apache-2.0");
    assert.equal(card.truncated, false);
    assert.equal(card.body.startsWith("---"), false);
  });

  it("cuts a very long card at a paragraph boundary and says so", () => {
    const card = prepareCard(`para\n\n${"x".repeat(CARD_LIMIT)}\n\ntail`);
    assert.equal(card.truncated, true);
    assert.ok(card.body.length <= CARD_LIMIT);
  });

  it("survives a card that is nothing but front matter", () => {
    const card = prepareCard("---\nlicense: mit\n---\n");
    assert.equal(card.meta.license, "mit");
    assert.equal(card.body, "");
  });
});
