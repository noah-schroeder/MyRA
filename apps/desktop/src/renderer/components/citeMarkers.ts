/**
 * Finding IEEE-style citation markers in prose.
 *
 * Kept apart from the rendering so it can be tested directly: the guards below
 * are the whole reason this is not a one-line regex, and they are exactly the
 * kind of thing that silently regresses.
 */

/**
 * The largest plausible citation number, and the widest plausible range.
 *
 * Prose contains "[1990-2020]" and reading that as thirty-one citations would
 * invent references out of an ordinary year span. Mirrors the same guards the
 * VM's citation audit uses.
 */
const MAX_CITATION = 999;
const MAX_RANGE_SPAN = 30;

/** Matches [1], [2, 5] and [7-9] -- the forms IEEE-style prose actually uses. */
export const MARKER = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;

/** The numbers a marker's body refers to, or none if it is not a citation. */
export function markerNumbers(body: string): number[] {
  const out: number[] = [];
  for (const part of body.split(",")) {
    const range = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > MAX_RANGE_SPAN || from < 1 || to > MAX_CITATION) return [];
      for (let i = from; i <= to; i++) out.push(i);
      continue;
    }
    const one = Number(part.trim());
    if (!Number.isInteger(one) || one < 1 || one > MAX_CITATION) return [];
    out.push(one);
  }
  return out;
}
