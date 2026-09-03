/**
 * Turning an answer into something worth listening to.
 *
 * Speaking raw Markdown is the obvious implementation and it is unusable: a
 * heading is read as "hash hash Findings", a table is read cell by cell with no
 * structure to hold it together, and a fenced code block is thirty seconds of
 * punctuation. Worse, Karen's answers carry citation markers -- "shown in
 * [3]" -- which a voice reads as a number with no referent.
 *
 * So this is not a Markdown renderer with the tags removed. It decides what is
 * WORTH SAYING, which is a different question, and the two rules that follow
 * from it are:
 *
 *   1. Anything whose value is its layout is described rather than read. A code
 *      block becomes "a code block"; a table becomes a count of its rows. The
 *      screen still has the real thing, and the listener is being told it is
 *      there rather than being read its punctuation.
 *   2. Nothing is invented. Where a passage is dropped, what replaces it says
 *      so -- silence would make an answer sound complete when part of it was
 *      never spoken.
 */

/** Rough ceiling on one utterance, in characters. */
export const MAX_SPOKEN_CHARS = 4_000;

function describeCode(body: string): string {
  const lines = body.trim().split("\n").filter((l) => l.trim()).length;
  return lines <= 1 ? " (a line of code, on screen) " : ` (${lines} lines of code, on screen) `;
}

export function speakable(markdown: string): string {
  let text = markdown;

  // Fenced code first, before anything else can see its contents as syntax.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => describeCode(body));
  text = text.replace(/```[^\n]*$/g, " (a code block, on screen) ");

  /* Tables: counted, not read. A markdown table read aloud is a stream of
     pipes and dashes, and there is no arrangement of words that makes a
     six-column row comprehensible through a speaker. */
  text = text.replace(/(?:^\|.*\|[ \t]*\n)+/gm, (block) => {
    const rows = block.trim().split("\n")
      /* The `|---|---|` separator is not a row, and counting it would make
         every table report one row more than it has. */
      .filter((line) => !/^\s*\|[\s:|-]*\|\s*$/.test(line)).length;
    return ` (a table of ${Math.max(1, rows - 1)} rows, on screen) `;
  });

  // Images have nothing to say; their alt text does, when there is any.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
    alt.trim() ? ` (an image: ${alt.trim()}) ` : " (an image, on screen) ");

  // A link is worth its text. The URL read character by character is not.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  /* Citation markers, dropped rather than read.
     "[3]" spoken aloud is a number with no referent -- the listener cannot see
     the reference list it points at. Removed after links, so `[text](url)` has
     already become its text and cannot be mistaken for one. */
  text = text.replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "");

  text = text
    .replace(/^#{1,6}\s+/gm, "")          // Heading marks; the words stay.
    /* `[ \t]*` and never `\s*` at the start of a line: `\s` matches a newline,
       so the bullet rule ate the blank line above a list and ran a heading
       straight into its first item -- and that blank line is the only pause a
       speech engine has between two ideas. */
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")  // Block quotes.
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")  // Bullets: the pause does the work.
    .replace(/^[ \t]*\d+\.[ \t]+/gm, (m) => m.trim() + " ") // Numbered lists keep their number.
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "") // Thematic breaks.
    .replace(/`([^`]+)`/g, "$1")          // Inline code: say the word itself.
    .replace(/(\*\*|__)(.*?)\1/g, "$2")   // Bold.
    .replace(/(?<![\w*])(\*|_)(?!\s)([^*_]+?)(?<!\s)\1(?![\w*])/g, "$2") // Italic.
    .replace(/~~(.*?)~~/g, "$1");         // Struck-through text is still text.

  /* Collapse the blank lines the substitutions leave behind, but keep ONE:
     a paragraph break is the only punctuation a speech engine has for the
     pause between two ideas, and running them together loses it. */
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");

  /* The gap a removed citation marker leaves behind.
     "held in two trials [3]." becomes "held in two trials ." -- which a speech
     engine reads with the pause of a mid-sentence break, in the middle of the
     one word that ends the thought. */
  text = text.replace(/[ \t]+([.,;:!?])/g, "$1");

  text = text.trim();

  if (text.length > MAX_SPOKEN_CHARS) {
    /* Cut at a sentence, and say that it was cut.
       An answer that stops mid-word sounds like a failure; one that ends
       "the rest is on screen" is a summary of what happened. */
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
    text = `${cut.slice(0, at > MAX_SPOKEN_CHARS / 2 ? at + 1 : cut.length).trim()} … The rest of this answer is on screen.`;
  }

  return text;
}
