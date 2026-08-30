/**
 * Printing token counts without rounding them into fiction.
 *
 * `k` notation is convenient and, done carelessly, wrong: dividing by 1024 and
 * rounding turns a 32,000-token window into "31k" and a 6,144-token one into
 * "6k", and a person reading a context size is entitled to the real figure.
 *
 * So `k` is used only when it is exact -- when the count is a whole number of
 * 1024s, which every power-of-two window is -- and anything else is printed in
 * full with separators. `4096` is exactly `4k`; `32000` is `32,000`, not `31k`.
 */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const whole = Math.round(n);
  if (whole < 1024) return String(whole);
  if (whole % 1024 === 0) return `${whole / 1024}k`;
  return whole.toLocaleString("en-GB");
}
