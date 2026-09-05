/**
 * A Hugging Face model card, made readable.
 *
 * A README from the registry is not markdown in the way the rest of the app
 * means it. Measured on `unsloth/Qwen3-8B-GGUF` -- 20 KB, and it opens with
 * eleven lines of YAML front matter followed by
 *
 *     <div>
 *       <p style="margin-bottom: 0; margin-top: 0;">
 *         <strong>See <a href="…">our collection</a> for all versions
 *
 * [Markdown.tsx](../../renderer/components/Markdown.tsx) renders an `html`
 * token as the literal text of the tag, on purpose: it builds React elements
 * and never markup, which is what makes it safe to point at anything a model
 * or a stranger wrote. Handed a card unprepared it is therefore correct and
 * useless -- a screen of angle brackets.
 *
 * So the preparation happens here instead, before the lexer, and it is a
 * reduction rather than a rendering: tags become the text they wrapped, links
 * become markdown links, and everything else goes. Nothing here can widen what
 * the renderer will emit, because the renderer still emits only elements it
 * constructs itself. This file changes legibility, not the trust boundary.
 *
 * The front matter is not thrown away -- it carries the licence, which for an
 * academic user deciding whether they may use a model at all is the single
 * most important fact on the page, and Hugging Face's own API reports it only
 * for repositories that filled it in.
 */

/**
 * How much of a card is worth carrying into the window.
 *
 * Cards run to tens of kilobytes and a few run to hundreds; the tail of a long
 * one is release notes and benchmark tables. This is generous enough that no
 * ordinary card is touched and small enough that a pathological one cannot
 * push a megabyte of someone else's text through IPC.
 */
export const CARD_LIMIT = 120_000;

export interface CardMeta {
  /** SPDX-ish id as the publisher wrote it: `apache-2.0`, `llama3.1`, `other`. */
  license?: string | undefined;
  /** Where the publisher says the full terms are. */
  licenseLink?: string | undefined;
  /** The unquantised model this was built from, when it says. */
  baseModel?: string | undefined;
  languages: string[];
}

export interface PreparedCard {
  meta: CardMeta;
  /** The prose, with the front matter removed and the HTML unwrapped. */
  body: string;
  /** Whether `CARD_LIMIT` cut it short, so the screen can say so. */
  truncated: boolean;
}

/**
 * Split a leading `---` block off the top of a document.
 *
 * Only a block that starts on the very first line counts. A `---` further down
 * is a horizontal rule, and treating one as front matter would silently eat
 * the first section of the card.
 */
export function splitFrontMatter(text: string): { front: string; body: string } {
  const normalised = text.replace(/^﻿/, "");
  if (!/^---[ \t]*\r?\n/.test(normalised)) return { front: "", body: normalised };
  const end = normalised.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (end === -1) return { front: "", body: normalised };
  const front = normalised.slice(normalised.indexOf("\n") + 1, end);
  const rest = normalised.slice(end + 1).replace(/^---[ \t]*(\r?\n)?/, "");
  return { front, body: rest };
}

/**
 * The scalars and string lists at the top level of a front matter block.
 *
 * Deliberately not a YAML parser. Only three things are wanted from here and
 * all three are written the same way in every card on the registry:
 *
 *     license: apache-2.0
 *     base_model: Qwen/Qwen3-8B
 *     language:
 *     - en
 *
 * Nested maps (`model-index:`, `widget:`) are skipped by indentation rather
 * than parsed, so an unusual card yields fewer facts instead of wrong ones.
 * Adding a dependency to read the rest would be a supply-chain decision taken
 * for a licence string.
 */
export function readFrontMatter(front: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = front.split(/\r?\n/);
  let key: string | undefined;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const list = /^\s*-\s+(.*)$/.exec(line);
    if (list && key) {
      const value = unquote(list[1] ?? "");
      if (value) out.get(key)?.push(value);
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!pair) {
      // An indented line under a key we are not reading. Stay out of it.
      if (/^\s/.test(line)) continue;
      key = undefined;
      continue;
    }
    key = pair[1] ?? "";
    const value = unquote(pair[2] ?? "");
    out.set(key, value ? [value] : []);
  }
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? (quoted[2] ?? "") : trimmed).trim();
}

export function readCardMeta(front: string): CardMeta {
  const fields = readFrontMatter(front);
  const one = (key: string): string | undefined => fields.get(key)?.[0];
  return {
    ...(one("license") ? { license: one("license") } : {}),
    ...(one("license_link") ? { licenseLink: one("license_link") } : {}),
    ...(one("base_model") ? { baseModel: one("base_model") } : {}),
    languages: fields.get("language") ?? fields.get("languages") ?? [],
  };
}

/* ------------------------------------------------------------------ HTML -- */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `href="x"` / `href='x'` / `href=x`, from an opening tag. */
function attribute(tag: string, name: string): string | undefined {
  const quoted = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (quoted) return decodeEntities(quoted[2] ?? quoted[3] ?? "");
  const bare = new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, "i").exec(tag);
  return bare ? decodeEntities(bare[1] ?? "") : undefined;
}

/**
 * Reduce embedded HTML to the text and links it was wrapping.
 *
 * Every rule here exists because a real card needed it:
 *
 *   - `<script>` and `<style>` lose their contents as well as their tags. They
 *     are the only elements whose text is not text, and printing a stylesheet
 *     into the middle of a description is worse than printing the tags.
 *   - `<a>` survives as a markdown link, because "See our collection" with the
 *     link removed is a sentence that no longer says anything.
 *   - `<img>` goes entirely. The window is default-deny on the network and its
 *     policy allows no remote images, so the request would be refused and the
 *     alt text of a decorative badge is noise.
 *   - `<tr>` and `<td>` become line and cell separators. HTML tables appear in
 *     perhaps one card in ten and flattening one into a run of words makes a
 *     benchmark table unreadable in a way that a row per line does not.
 *
 * Fenced code is copied through untouched: a card that documents an HTML
 * template must show it, and that is exactly the text this would otherwise eat.
 */
export function unwrapHtml(markdown: string): string {
  return outsideFences(markdown, unwrapSegment);
}

/**
 * Apply a transformation everywhere except inside fenced code.
 *
 * Fenced code is the one place a card shows markup on purpose -- a template, a
 * shell line, a chat format -- and it is exactly the text every rule below
 * would otherwise eat.
 */
function outsideFences(markdown: string, fn: (segment: string) => string): string {
  /* The delimiter is kept as its own segment by the capture group. */
  const parts = markdown.split(/(^[ \t]*(?:```|~~~)[^\n]*$)/m);
  let inFence = false;
  let out = "";

  for (const part of parts) {
    if (/^[ \t]*(?:```|~~~)/.test(part)) {
      inFence = !inFence;
      out += part;
      continue;
    }
    out += inFence ? part : fn(part);
  }
  return out;
}

/**
 * The two markdown conventions a registry card uses that a renderer does not.
 *
 * **GitHub alerts.** `> [!NOTE]` on the first line of a blockquote is rendered
 * as a callout by GitHub and by Hugging Face, and as the literal text `[!NOTE]`
 * by everything else -- which is what it looked like here. Turned into a bold
 * word, so the blockquote keeps its meaning without this file having to invent
 * a callout element.
 *
 * **Badges.** Cards open with rows of shields.io images whose alt text is
 * things like `mof-class3-qualified`. The window fetches no remote images by
 * policy, so an image can only ever become its alt -- and a line of decorative
 * alt text is noise rather than information. They are dropped, and the heading
 * above the card says the pictures are not shown, so nothing disappears
 * silently.
 */
export function tidyMarkdown(markdown: string): string {
  return outsideFences(markdown, (segment) =>
    segment
      .replace(
        /^(\s*>\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gim,
        (_whole, quote: string, kind: string) =>
          `${quote}**${kind.charAt(0)}${kind.slice(1).toLowerCase()}**`,
      )
      /* A linked badge first -- `[![alt](img)](href)` is the idiom -- so the
         link it was wrapped in goes with it rather than being left empty. */
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      /* Lines that held nothing but badges are now blank, and a run of them is
         a gap markdown does not distinguish from one. */
      .replace(/^[ \t]+$/gm, ""),
  );
}

/**
 * A private marker for "this text had a tag on it".
 *
 * The reason it is needed is subtle and cost a rendering. HTML in a card is
 * indented for readability:
 *
 *     <div>
 *       <p style="…">
 *         <strong>Learn to run this - <a href="…">Read our Guide</a>.</strong>
 *
 * Strip the tags and the third line keeps its four leading spaces, and four
 * leading spaces after a blank line is an **indented code block**. Marked then
 * refuses to parse anything inside it, so the link that had just been rebuilt
 * came out on screen as the literal text `[Read our Guide](https://…)`.
 *
 * Blanket dedenting is not the fix: two- and four-space indents are how nested
 * lists are written, and flattening those would break every list in every card.
 * So each removed tag leaves this behind, and only the lines carrying one are
 * dedented -- which is exactly the set of lines that came out of HTML.
 */
const MARK = "\u0001";

function unwrapSegment(text: string): string {
  let out = text;
  out = out.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  /* Unclosed too: a truncated card can end mid-<script>, and leaving the tag
     alone would print the rest of the file as prose. */
  out = out.replace(/<(script|style)\b[\s\S]*$/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, MARK);
  out = out.replace(/<img\b[^>]*>/gi, MARK);
  out = out.replace(/<br\s*\/?>/gi, `${MARK}\n`);

  /*
   * Block tags become blank lines, not single ones.
   *
   * A single newline is not a block boundary in markdown: a `</ul>` followed
   * immediately by a `|` row leaves the table lazily continuing the last list
   * item, and the whole table renders as one line of pipes. Measured on
   * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`, which puts a comparison table
   * straight after an HTML list.
   *
   * `</li>` is the exception and stays a single newline, because a blank line
   * between items is a different list, not a different block.
   */
  const BLOCK = "p|div|h[1-6]|ul|ol|blockquote|table|thead|tbody|details|summary|section|center";
  out = out.replace(new RegExp(`</(?:${BLOCK})\\s*>`, "gi"), `${MARK}\n\n`);
  out = out.replace(new RegExp(`<(?:${BLOCK})\\b[^>]*>`, "gi"), `\n\n${MARK}`);
  out = out.replace(/<li\b[^>]*>/gi, `\n${MARK}- `);
  /* No newline of its own: the next `<li>` starts one, and adding a second
     turns every HTML list into a loose one with a blank line between items. */
  out = out.replace(/<\/li\s*>/gi, MARK);
  out = out.replace(/<\/tr\s*>/gi, `${MARK}\n`);
  out = out.replace(/<\/t[dh]\s*>/gi, `${MARK} · `);

  /* Links last of the element rules, so the text inside one has already had
     its own tags removed and `[**Qwen3**](…)` still reads as a link. */
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
    const label = unwrapSegment(inner).replace(/\s+/g, " ").replace(new RegExp(MARK, "g"), "").trim();
    const href = attribute(attrs, "href");
    if (!label) return MARK;
    /* Only http(s) becomes a link. The renderer refuses anything else anyway;
       not writing it as a link avoids inviting the click at all. */
    return href && /^https?:\/\//i.test(href) ? `${MARK}[${label}](${href})` : `${MARK}${label}`;
  });

  out = out.replace(/<\/?[A-Za-z][^>]*>/g, MARK);
  out = decodeEntities(out);

  // See MARK: only the lines that carried a tag lose their indentation.
  out = out
    .split("\n")
    .map((line) => (line.includes(MARK) ? line.replace(/^[ \t]+/, "") : line))
    .join("\n")
    .replace(new RegExp(MARK, "g"), "");

  /* Unwrapping leaves runs of blank lines where the nesting was. Three or more
     newlines is a gap markdown does not distinguish from two anyway. */
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * A card as it should reach the screen.
 *
 * Truncation is by character count and then backed up to the last blank line,
 * so a card never ends in the middle of a sentence or, worse, inside an
 * unterminated code fence that would swallow everything the screen draws after
 * it.
 */
export function prepareCard(readme: string): PreparedCard {
  const { front, body } = splitFrontMatter(readme);
  const meta = readCardMeta(front);
  const unwrapped = tidyMarkdown(unwrapHtml(body)).replace(/\n{3,}/g, "\n\n").trim();

  if (unwrapped.length <= CARD_LIMIT) return { meta, body: unwrapped, truncated: false };
  const cut = unwrapped.slice(0, CARD_LIMIT);
  const gap = cut.lastIndexOf("\n\n");
  return { meta, body: (gap > CARD_LIMIT / 2 ? cut.slice(0, gap) : cut).trim(), truncated: true };
}
