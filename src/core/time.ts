/**
 * Local calendar days: the arithmetic "tomorrow" needs, and nothing more.
 *
 * Narrow on purpose. The repo already has five near-identical local-clock
 * stamp functions -- sessions.ts, papers/paper.ts, images/store.ts,
 * meetings/meeting.ts, review/record.ts -- and none of them belong here. Each
 * bakes a FILENAME format that is on people's disks right now; folding them
 * into this module would change ids to save a handful of lines, for a feature
 * about none of them. This module owns only day-key arithmetic and timezone
 * resolution, neither of which exists anywhere else in the app, because the
 * app has never before had to answer "what day does this fall on in the
 * user's own zone".
 *
 * The single rule that makes the rest of the calendar/task feature safe to
 * test: exactly one function here reads the system's timezone. Every other
 * function takes `zone` as an explicit parameter. Without that discipline the
 * test suite passes under `TZ=UTC` on CI and is silently wrong for a user in
 * any other zone -- and it has to hold from the first line here, rather than
 * be retrofitted once callers already assume a global clock.
 */

/** The one function that reads the machine's own timezone. Called at the
 *  edges -- a tool handler, an IPC handler -- never from a pure function
 *  below it, which takes `zone` instead. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A day, as it reads on a calendar in `zone` -- "2026-09-16".
 *
 * Never derived by slicing an ISO string: `toISOString().slice(0, 10)` reads
 * the UTC day, which lands a late-evening instant on the wrong date for
 * anyone west of Greenwich and an early-morning one on the wrong date for
 * anyone east of it. Built from `Intl.DateTimeFormat`'s own parts rather than
 * from a locale's rendered string, so no locale's date ordering can be
 * mistaken for another's.
 */
export function dayKeyOf(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayKey(now: Date, zone: string): string {
  return dayKeyOf(now.getTime(), zone);
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a "YYYY-MM-DD" string is a real calendar date, not merely shaped
 *  like one -- "2026-13-40" matches DAY_KEY and is not a day. */
function isRealDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * Add or subtract whole days from a day key.
 *
 * Pure string-and-calendar arithmetic, with no timezone or instant involved
 * at any point: a day key has already left the question of "when, exactly"
 * behind, and routing it back through a zoned instant to add one would
 * risk re-introducing the DST hazard this module exists to keep out.
 */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}`;
}

/** How many days from `a` to `b`, positive when `b` is later. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  const ua = Date.UTC(ay, am - 1, ad);
  const ub = Date.UTC(by, bm - 1, bd);
  return Math.round((ub - ua) / 86_400_000);
}

/** 0 (Sunday) to 6 (Saturday) for a day key. Reads no timezone: a day key has
 *  already left "when, exactly" behind, so which weekday it falls on cannot
 *  depend on where the machine sits. */
function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Every day shown on a calendar month grid for the month `day` falls in,
 * Sunday-first -- always a whole number of weeks, so the grid is rectangular
 * even when the month itself is not. Leading and trailing days belong to the
 * adjacent months, exactly as a paper wall calendar shows them.
 *
 * `day` need only fall somewhere in the target month; only its year and
 * month are read; `monthGrid("2026-09-01")` and `monthGrid("2026-09-16")`
 * return the same grid.
 */
export function monthGrid(day: string): string[] {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const first = `${y}-${two(m)}-01`;
  // The last day of month m is day 0 of month m+1 -- Date.UTC normalises
  // that itself, which is what makes this correct for every month length
  // without a leap-year table.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${y}-${two(m)}-${two(daysInMonth)}`;
  const start = addDays(first, -weekdayOf(first));
  const end = addDays(last, 6 - weekdayOf(last));
  const total = daysBetween(start, end) + 1;
  return Array.from({ length: total }, (_, i) => addDays(start, i));
}

/**
 * A day key, "today", "tomorrow", or nothing -- the whole vocabulary a task
 * tool accepts for `due`.
 *
 * Deliberately not a general date parser: a model that means "next Thursday"
 * is expected to work that out itself against the date already in its own
 * instructions and send YYYY-MM-DD, which is what the tool description asks
 * for. Accepting more here would mean silently guessing at English written in
 * some other shape, which fails exactly when it matters -- quietly, on a date
 * nobody checks until the task turns out to be late.
 */
export function normaliseDay(raw: string, now: Date, zone: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "today") return todayKey(now, zone);
  if (lower === "tomorrow") return addDays(todayKey(now, zone), 1);
  if (DAY_KEY.test(trimmed) && isRealDay(trimmed)) return trimmed;
  return undefined;
}
