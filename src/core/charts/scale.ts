/**
 * Axis ticks, chosen the way graphing calculators and plotting libraries
 * have for decades: "nice numbers" at 1, 2 or 5 times a power of ten --
 * Paul Heckbert's algorithm (Graphics Gems I, 1990). Deterministic and
 * simple to state exactly, which is the whole reason it is used here rather
 * than a fancier method (Wilkinson's extended algorithm chooses marginally
 * prettier ranges at several times the code, for a difference nobody reading
 * a scientific figure would notice).
 */

/** The nicest round number near `range`: 1, 2, 5 or 10 times a power of ten. */
function niceNum(range: number, round: boolean): number {
  if (range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  } else {
    niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  }
  return niceFraction * 10 ** exponent;
}

export interface Scale {
  /** The axis's own drawn extent -- always encloses [min, max]. */
  lo: number;
  hi: number;
  ticks: number[];
  step: number;
}

/**
 * A "nice" axis covering [min, max], with around `maxTicks` labelled ticks.
 *
 * `min === max` (a single point, or a column of one repeated value) is
 * nudged open by 1 on each side rather than producing a zero-width axis --
 * an axis has to be drawn somewhere, and a single point centred in a small
 * range reads correctly where a division by zero would not draw at all.
 */
export function niceScale(min: number, max: number, maxTicks = 6): Scale {
  const widened = min === max;
  const lo0 = widened ? min - 1 : min;
  const hi0 = widened ? max + 1 : max;

  const range = niceNum(hi0 - lo0, false);
  const step = niceNum(range / Math.max(1, maxTicks - 1), true);
  const lo = Math.floor(lo0 / step) * step;
  const hi = Math.ceil(hi0 / step) * step;

  // Decimal places to round to, so 0.1 + 0.2-style noise never reaches a
  // tick label -- derived from the step's own magnitude rather than fixed.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 6);
  const round = (v: number): number => Math.round(v * 10 ** decimals) / 10 ** decimals;

  const ticks: number[] = [];
  const count = Math.round((hi - lo) / step);
  for (let i = 0; i <= count; i++) ticks.push(round(lo + i * step));

  return { lo: round(lo), hi: round(hi), ticks, step: round(step) };
}
