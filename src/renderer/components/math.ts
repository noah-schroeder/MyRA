/**
 * Finding the mathematics inside a paragraph of prose.
 *
 * Academic writing is full of it: "a small overall positive effect
 * ($g^+ = 0.20$)", "$r = .29$", "$\eta^2$". MyRA printed those as the literal
 * dollar signs and backslashes the model wrote, which is not a rendering
 * problem so much as a comprehension one -- a reader has to decode
 * `\eta^2` in their head, and a document exported that way is wrong.
 *
 * Splitting is separated from rendering so this part can be tested as a pure
 * function: given a string, which parts are prose and which are maths. That is
 * where the judgement calls live, and they are all about `$`.
 *
 * THE DOLLAR PROBLEM. `$` is also a currency symbol, and "costs $5 and $10"
 * must not become "costs [5 and ]10" with the middle set in italic serif. The
 * unambiguous delimiters -- `$$…$$`, `\(…\)`, `\[…\]` -- are taken at face
 * value. A single `$…$` has to earn it:
 *
 *   - no whitespace just inside either delimiter, which is what separates
 *     "$x = 1$" from "cost $5 and $10"
 *   - nothing spanning a blank line, so an unmatched `$` cannot swallow half
 *     the answer
 *   - and either a character that only appears in maths (a backslash, ^, _,
 *     braces, a relation) or a short symbol like $d$, $r$, $n$ -- the single
 *     letters effect sizes are actually named with.
 *
 * The failure this guards against is asymmetric. Missing a piece of maths
 * leaves the LaTeX on screen, which is what happens today and is legible.
 * Wrongly claiming prose is maths mangles a sentence.
 */

export interface Segment {
  kind: "text" | "math";
  value: string;
  /** Display maths is centred on its own line; inline sits in the sentence. */
  display?: boolean;
}

/** Openers and their closers, longest first so `$$` beats `$`. */
const PAIRS: readonly { open: string; close: string; display: boolean; strict: boolean }[] = [
  { open: "$$", close: "$$", display: true, strict: false },
  { open: "\\[", close: "\\]", display: true, strict: false },
  { open: "\\(", close: "\\)", display: false, strict: false },
  // `strict` marks the one that has to prove itself.
  { open: "$", close: "$", display: false, strict: true },
];

/** A character that does not turn up in a price. */
const MATHY = /[\\^_{}=<>≤≥≠±∑∏∫√·×÷]/;
/** A bare symbol: the way an effect size or a sample size is written. */
const SYMBOL = /^[A-Za-zα-ωΑ-Ω][A-Za-z0-9']{0,2}$/;

function looksLikeMath(body: string): boolean {
  const inner = body.trim();
  if (!inner) return false;
  if (MATHY.test(inner)) return true;
  return SYMBOL.test(inner);
}

/** Whitespace immediately inside a `$…$` is what a price looks like. */
function tightlyWrapped(body: string): boolean {
  return body.length > 0 && !/^\s/.test(body) && !/\s$/.test(body);
}

/**
 * The longest a piece of inline maths may be.
 *
 * An unmatched `$` in a long answer would otherwise pair with one paragraphs
 * later and typeset everything between them. Display maths is allowed more,
 * because an aligned block legitimately runs long.
 */
const MAX_INLINE = 400;
const MAX_DISPLAY = 4000;

/**
 * One piece of maths starting exactly at `at`, or nothing.
 *
 * The single place the rules live, so the paragraph splitter and marked's
 * tokenizer cannot come to different conclusions about the same `$`.
 */
export function matchMathAt(
  text: string,
  at = 0,
): { raw: string; value: string; display: boolean } | undefined {
  for (const pair of PAIRS) {
    if (!text.startsWith(pair.open, at)) continue;
    const from = at + pair.open.length;
    const end = text.indexOf(pair.close, from);
    if (end === -1) continue;
    const body = text.slice(from, end);
    if (body.length > (pair.display ? MAX_DISPLAY : MAX_INLINE)) continue;
    // Never across a blank line: that is a stray delimiter, not an equation.
    if (/\n\s*\n/.test(body)) continue;
    if (pair.strict && !(tightlyWrapped(body) && looksLikeMath(body))) continue;
    if (!body.trim()) continue;
    return {
      raw: text.slice(at, end + pair.close.length),
      value: body.trim(),
      display: pair.display,
    };
  }
  return undefined;
}

export function splitMath(text: string): Segment[] {
  const out: Segment[] = [];
  let plain = "";
  let i = 0;

  const flush = (): void => {
    if (plain) out.push({ kind: "text", value: plain });
    plain = "";
  };

  while (i < text.length) {
    /* An escaped dollar is a dollar. Emitted as the character itself, so the
       backslash the model wrote to escape it does not survive into the prose. */
    if (text[i] === "\\" && text[i + 1] === "$") {
      plain += "$";
      i += 2;
      continue;
    }

    const found = matchMathAt(text, i);
    if (found) {
      flush();
      out.push({ kind: "math", value: found.value, ...(found.display ? { display: true } : {}) });
      i += found.raw.length;
      continue;
    }

    plain += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** Whether a string has any maths in it, without building the segments. */
export function hasMath(text: string): boolean {
  return splitMath(text).some((s) => s.kind === "math");
}

/**
 * How KaTeX is called, in one place so the test cannot drift from the app.
 *
 * `trust: false` is the security control, and it is not a detail: with it off
 * KaTeX refuses \href, \url and \includegraphics, which are the only commands
 * that can put an attacker-chosen URL into the output. Everything else it
 * produces is spans and escaped text. `maxExpand` bounds macro expansion so a
 * crafted \def cannot spin the renderer. `throwOnError` is off because half an
 * equation is the normal state of a reply that is still arriving.
 */
export const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: false,
  output: "htmlAndMathml",
  maxExpand: 1000,
} as const;
