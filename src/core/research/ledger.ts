/**
 * One numbering for every citation in a conversation.
 *
 * `[1]` has to mean one thing for as long as a conversation lasts. It did not:
 * `formatHits` numbered from one on every call, and the renderer stores sources
 * in a map keyed by that number, so a second search overwrote the first's
 * entries. The prose above kept saying [1] and [1] had quietly become a
 * different paper — a wrong citation, rendered as a working link, with nothing
 * anywhere indicating it had changed. Of all the ways this app can fail, that
 * is the one it is least allowed to.
 *
 * So numbers are issued here and nowhere else, and two rules make them mean
 * something:
 *
 *   - Issued once per SOURCE, not per result. The same paper found by two
 *     different searches keeps its first number, which is what makes a marker
 *     in an earlier paragraph still correct after a later search.
 *   - Never reissued. A number is spent for the rest of the conversation.
 *
 * Reset when a conversation is, and only then.
 */

const MAX_CITATION = 999;
const MAX_RANGE_SPAN = 30;

/** Identity of a source: its URL, which is what the renderer resolves against. */
const issued = new Map<string, number>();
let high = 0;

/** The numbers for these sources, in order. Repeats keep their first number. */
export function cite(keys: string[]): number[] {
  return keys.map((key) => {
    const already = issued.get(key);
    if (already !== undefined) return already;
    const n = ++high;
    issued.set(key, n);
    return n;
  });
}

/** How many numbers have been spent. */
export function citedSoFar(): number {
  return high;
}

/**
 * Take a block of numbers without naming what they point at.
 *
 * For a deep run, which numbers its own report and bibliography together as one
 * self-consistent document. MyRA does not renumber that document; it moves it
 * clear of everything already cited, and records that those numbers are gone.
 */
export function reserve(count: number): number {
  const from = high;
  high += Math.max(0, count);
  return from;
}

export function resetCitations(): void {
  issued.clear();
  high = 0;
}

/**
 * Restart the numbering above everything a reopened conversation already used.
 *
 * A stored thread carries its tool output verbatim, markers and all, and the
 * renderer rebuilds its source table from that text. If the ledger started
 * again from one, the first search after reopening would hand out numbers that
 * are already on screen, pointing at other papers — the same corruption the
 * ledger exists to prevent, arriving by a different door.
 *
 * The sources themselves are deliberately NOT re-registered: their URLs are not
 * all recoverable from the text, and a number that is merely spent is safe,
 * while a number wrongly reused is not.
 */
export function resumeCitations(storedOutput: string[]): void {
  resetCitations();
  for (const text of storedOutput) {
    for (const m of text.matchAll(/^\[(\d+)\]\s/gm)) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > high && n <= MAX_CITATION) high = n;
    }
  }
}

/**
 * Matches [1], [2, 5] and [7-9].
 *
 * A hand-kept copy of the renderer's `citeMarkers.ts`, which cannot be imported
 * from here — the renderer does not share modules with core. They must agree:
 * this shifts the markers that one renders, and a form matched by one and not
 * the other is a marker that moves without its source, or a source that moves
 * without its marker.
 */
const MARKER = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;

/**
 * Move a self-numbered document clear of the numbers already spent.
 *
 * A deep run writes its report and its bibliography against one table starting
 * at [1]. Dropped into a conversation that has already cited eight sources,
 * every one of its markers would land on somebody else's paper. Shifting both
 * halves by the same amount keeps the document internally consistent, which is
 * the only property that has to hold.
 *
 * Anything that is not a citation is left alone: "[1990-2020]" is a year span,
 * and the guards here are the same ones the renderer applies before it will
 * draw a marker as a link.
 */
export function shiftCitations(text: string, by: number): string {
  if (by <= 0) return text;
  return text.replace(MARKER, (whole, body: string) => {
    const shifted = shiftBody(body, by);
    return shifted === undefined ? whole : `[${shifted}]`;
  });
}

function shiftBody(body: string, by: number): string | undefined {
  const parts: string[] = [];
  for (const part of body.split(",")) {
    const range = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > MAX_RANGE_SPAN || from < 1 || to > MAX_CITATION) return undefined;
      parts.push(`${from + by}-${to + by}`);
      continue;
    }
    const one = Number(part.trim());
    if (!Number.isInteger(one) || one < 1 || one > MAX_CITATION) return undefined;
    parts.push(String(one + by));
  }
  return parts.join(", ");
}
