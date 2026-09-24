/**
 * Every derived number this subsystem can produce, computed here and only
 * here.
 *
 * A mean, a standard deviation, a regression line -- these are the numbers a
 * model would otherwise be tempted to compute in its head and hand back as an
 * ordinary tool argument, which is exactly the transcription risk the whole
 * design exists to close off. So no tool schema in tools/table.ts or
 * tools/chart.ts accepts a derived value as an argument: a caller names a
 * column, and only arithmetic in this file may turn its numbers into a
 * summary statistic or a fit.
 *
 * Every function here is total over the inputs it accepts and honest about
 * the inputs it cannot answer for: too few points returns `NaN` rather than
 * throwing, because "not enough data for a spread" is a fact about the data
 * worth reporting, not a programming error. Callers (the chart tool) decide
 * what to say about a `NaN`; this module never manufactures a number to avoid
 * one.
 */

export function mean(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample standard deviation (divides by n-1). `NaN` below n=2, where a
 *  spread is not a defined quantity. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Standard error of the mean: sd / sqrt(n). */
export function sem(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  return sd(xs) / Math.sqrt(xs.length);
}

export interface Quartiles {
  q1: number;
  median: number;
  q3: number;
  /** Named explicitly because several conventions disagree on where a
   *  quartile falls, and a box plot printed from this must say which one it
   *  drew rather than let a reader assume their own textbook's method. */
  method: string;
}

const QUARTILE_METHOD =
  "exclusive (Tukey hinges): the median of each half, excluding the overall median when n is odd";

/**
 * Quartiles by the exclusive/Tukey-hinges method: split the sorted data at
 * the median, excluding the median itself from either half when n is odd,
 * and take the median of each half.
 *
 * One of several methods a textbook might teach (inclusive, or the several
 * numbered by different statistics packages). This one is picked because it
 * is simple to state exactly, not because it is more correct -- which is why
 * `method` travels with the result rather than being assumed by whatever
 * reads it.
 */
export function quartiles(xs: readonly number[]): Quartiles {
  if (xs.length < 3) {
    return { q1: NaN, median: NaN, q3: NaN, method: QUARTILE_METHOD };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const median = medianOf(sorted);
  const half = Math.floor(n / 2);
  const lower = sorted.slice(0, half);
  const upper = n % 2 === 0 ? sorted.slice(half) : sorted.slice(half + 1);
  return { q1: medianOf(lower), median, q3: medianOf(upper), method: QUARTILE_METHOD };
}

/** The sorted array's own median -- private, because a caller outside this
 *  file has no sorted array to hand it that `quartiles` has not already
 *  produced from unsorted input. */
function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  if (!n) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination. `NaN` when it is not defined (every x or
   *  every y identical), not 0 or 1 -- 0 would claim "no relationship" about
   *  data with no variance to have one in. */
  r2: number;
  n: number;
}

/**
 * Ordinary least squares, `y = slope*x + intercept`.
 *
 * `slope` and `intercept` come back `NaN` when every x value is identical --
 * a vertical scatter has no least-squares line -- and the chart tool checks
 * `Number.isFinite` before drawing anything, rather than plotting a fit
 * through data that does not support one.
 */
export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };

  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: NaN, intercept: NaN, r2: NaN, n };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? NaN : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}
