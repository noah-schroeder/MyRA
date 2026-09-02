/**
 * How wide the document panel may be.
 *
 * Separated from the component for the same reason as turnText: a `.tsx` is
 * invisible to the test runner, and the bounds are the part worth pinning.
 */

/** Remembered between launches; a reading width is not a per-document choice. */
export const WIDTH_KEY = "karen.artifactWidth";

/** What it was before the edge could be dragged. */
export const DEFAULT_WIDTH = 400;

/** Below this the document is a column of hyphenated fragments. */
export const MIN_WIDTH = 280;

/** Past this the conversation is confetti and the panel has simply won. */
export const MAX_FRACTION = 0.7;

/**
 * Clamped against the WINDOW, not against a constant.
 *
 * A width stored on a wide monitor and restored on a laptop would otherwise
 * come back larger than the screen, leaving a conversation a few pixels across
 * and a grip somewhere off the right-hand edge -- unreadable, and unfixable
 * with the control that caused it.
 */
export function clampWidth(px: number, windowWidth: number): number {
  const max = Math.max(MIN_WIDTH, Math.round(windowWidth * MAX_FRACTION));
  /* Total, for any input. A clamp that can return NaN is not a clamp: the value
     goes straight into a grid template, where NaN is not an error but a rule
     the browser silently discards -- so a corrupt stored width would leave a
     panel that ignores every drag with nothing anywhere saying why. */
  if (!Number.isFinite(px)) return Math.min(DEFAULT_WIDTH, max);
  return Math.min(Math.max(Math.round(px), MIN_WIDTH), max);
}
