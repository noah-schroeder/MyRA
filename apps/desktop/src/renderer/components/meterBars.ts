/**
 * How the level becomes bars.
 *
 * Split out of the component because Node's test runner strips types from .ts
 * but does not compile .tsx -- so logic that lives in the component cannot be
 * tested, and this is logic worth testing: an off-by-one in the zone boundaries
 * shows a red "too loud" bar to someone speaking normally.
 */

/** How many bars the meter is drawn from. */
export const SEGMENTS = 16;

/** How many of them are lit at this level. */
export function litSegments(level: number, segments = SEGMENTS): number {
  if (!Number.isFinite(level)) return 0;
  return Math.round(Math.min(1, Math.max(0, level)) * segments);
}

/**
 * The class list for one segment.
 *
 * Clipping lights the top of the scale whether or not the level reached it: a
 * peak that hits full scale between two readings is still distortion, and the
 * average the bar is drawn from will not show it.
 */
export function segmentClass(index: number, lit: number, clipping = false, segments = SEGMENTS): string {
  const classes = ["hud-seg"];
  if (index < lit) classes.push("on");
  if (index >= segments - 2) classes.push("hot");
  else if (index >= segments - 5) classes.push("warm");
  if (clipping && index >= segments - 2) classes.push("clip");
  return classes.join(" ");
}
