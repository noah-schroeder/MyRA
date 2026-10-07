/**
 * Days, buckets and numbers for the usage dashboard.
 *
 * Everything here is in the LOCAL calendar. A record's time is stored in UTC,
 * but "how much did I use on Tuesday" means the Tuesday on the wall, and a late
 * evening session in a timezone west of Greenwich would otherwise be counted
 * into Wednesday. Main and the window run on the same machine, so they agree on
 * what local is.
 *
 * No imports: the window builds its preset ranges and labels from this file and
 * main buckets records with it, and the two must never disagree on where a day
 * ends.
 */

/** Inclusive, as `YYYY-MM-DD` in local time. */
export interface DateRange {
  from: string;
  to: string;
}

export type UsagePreset = "today" | "7d" | "30d" | "month" | "last-month" | "year" | "all";

export const PRESETS: { id: UsagePreset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
];

export type Bucket = "day" | "week" | "month";

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar day a moment falls on. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar month, as the usage log names its files. */
export function localMonth(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** A `YYYY-MM-DD` read as local midnight, or undefined for anything else. */
export function parseDay(day: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return localDay(d) === day ? d : undefined;
}

/** Calendar arithmetic, not milliseconds: a day across a clock change is 23 or 25 hours. */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  if (!d) return day;
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** Days from `from` to `to`, counting both ends. */
export function daysIn(range: DateRange): number {
  const a = parseDay(range.from);
  const b = parseDay(range.to);
  if (!a || !b || b < a) return 0;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000) + 1;
}

/**
 * A preset turned into dates.
 *
 * "All time" starts at the first record there is, when that is known, so the
 * chart is not a year of empty days in front of a week of use.
 */
export function presetRange(preset: UsagePreset, now: Date, earliest?: string): DateRange {
  const today = localDay(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${localMonth(now)}-01`, to: today };
    case "last-month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: localDay(first), to: localDay(last) };
    }
    case "year":
      return { from: `${now.getFullYear()}-01-01`, to: today };
    case "all": {
      const from = earliest && parseDay(earliest) && earliest < today ? earliest : today;
      return { from, to: today };
    }
  }
}

/**
 * How finely to slice a range for the chart.
 *
 * Days up to about two months, weeks up to a year, months beyond: the point at
 * which each would need more bars than the panel has room to draw legibly.
 */
export function bucketFor(range: DateRange): Bucket {
  const days = daysIn(range);
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** The bucket a local day belongs to: itself, its week's Monday, or its month. */
export function bucketKey(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return day.slice(0, 7);
  const d = parseDay(day);
  if (!d) return day;
  const back = (d.getDay() + 6) % 7; // Monday is 0
  d.setDate(d.getDate() - back);
  return localDay(d);
}

/** Every bucket in the range, in order -- including the empty ones, which are data too. */
export function bucketsIn(range: DateRange, bucket: Bucket): string[] {
  const out: string[] = [];
  if (!parseDay(range.from) || !parseDay(range.to) || range.to < range.from) return out;
  let day = range.from;
  let last = "";
  // Bounded by the day count rather than a while(true): a malformed range must not spin.
  for (let i = 0, n = daysIn(range); i < n; i++, day = addDays(day, 1)) {
    const key = bucketKey(day, bucket);
    if (key !== last) {
      out.push(key);
      last = key;
    }
  }
  return out;
}

/** The months a range touches, which is which log files have to be opened. */
export function monthsIn(range: DateRange): string[] {
  return [...new Set(bucketsIn(range, "day").map((d) => d.slice(0, 7)))];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6 Oct", "6 Oct" for a week (its Monday), "Oct 2026" for a month. */
export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === "month") {
    const [y, m] = key.split("-");
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  const [, m, d] = key.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

/**
 * Keep every n-th label and blank the rest, so a month of daily bars does not
 * print thirty dates on top of one another. The first and last are always
 * kept: they are the two a person reads to know what the axis spans.
 */
export function thinLabels(labels: string[], max: number): string[] {
  if (labels.length <= max || max < 2) return labels;
  const step = Math.ceil((labels.length - 1) / (max - 1));
  const last = labels.length - 1;
  const out = labels.map((label, i) => (i % step === 0 || i === last ? label : ""));
  /* The last label is kept, so the regular one just before it is dropped when
     the two would print on top of each other. */
  const before = last - (last % step || step);
  if (before > 0 && last - before < step / 2) out[before] = "";
  return out;
}

/**
 * A large count, short.
 *
 * Three significant figures with a unit -- "1.24M", "18.3k" -- for tiles and
 * table cells where seven digits would not fit; the exact figure goes in the
 * tooltip beside it, so nothing is rounded out of reach. Decimal thousands, not
 * the 1024s `formatTokens` uses, because these are sums rather than window
 * sizes and no one budgets in kibitokens.
 */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const v = n / size;
      const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return `${v.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")}${unit}`;
    }
  }
  return String(Math.round(n));
}

/** The exact figure, grouped, for a tooltip. */
export function exactCount(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}
