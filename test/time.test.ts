/**
 * Local calendar days: the one place the system's timezone is read, and the
 * arithmetic that must never need to read it again.
 *
 * Every test here passes `zone` explicitly, on purpose: a test that let these
 * functions default to the machine's own timezone would pass on whatever
 * machine wrote it and be silently wrong on any other -- exactly the bug this
 * module exists to make impossible.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { addDays, dayKeyOf, daysBetween, monthGrid, normaliseDay, todayKey } from "../src/core/time.ts";

describe("dayKeyOf", () => {
  it("reads the calendar day in the given zone, not UTC", () => {
    // 21:30 UTC is 23:30 in Berlin (UTC+2 in September) -- still the 15th in
    // both, which is the boring case a UTC-slice implementation also gets
    // right by accident.
    const ms = Date.UTC(2026, 8, 15, 21, 30);
    assert.equal(dayKeyOf(ms, "Europe/Berlin"), "2026-09-15");
    assert.equal(dayKeyOf(ms, "America/New_York"), "2026-09-15");
  });

  it("an evening UTC instant has already rolled over east of Greenwich", () => {
    // 23:00 UTC is already 11am on the 16th in Auckland (UTC+12/+13) -- the
    // concrete case `toISOString().slice(0, 10)` gets backwards, and the one
    // this app's least represented users would have hit first.
    const ms = Date.UTC(2026, 8, 15, 23, 0);
    assert.equal(dayKeyOf(ms, "Pacific/Auckland"), "2026-09-16");
    assert.equal(dayKeyOf(ms, "UTC"), "2026-09-15");
  });
});

describe("addDays / daysBetween", () => {
  it("adds across month boundaries in both directions", () => {
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  it("is pure calendar arithmetic -- a DST boundary changes nothing", () => {
    // Europe/Berlin springs forward the night of 2026-03-29. A day-key add
    // must land on the 30th regardless: there is no time-of-day here to lose
    // an hour from, which is the whole point of keeping this a string
    // operation rather than routing it through a zoned instant.
    assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  });

  it("counts the days between two keys, signed", () => {
    assert.equal(daysBetween("2026-09-15", "2026-09-16"), 1);
    assert.equal(daysBetween("2026-09-16", "2026-09-15"), -1);
    assert.equal(daysBetween("2026-09-15", "2026-09-15"), 0);
  });
});

describe("normaliseDay", () => {
  const zone = "Europe/Berlin";

  it("resolves today and tomorrow against the given clock and zone", () => {
    const now = new Date(Date.UTC(2026, 8, 15, 10, 0)); // midday in Berlin
    assert.equal(normaliseDay("today", now, zone), "2026-09-15");
    assert.equal(normaliseDay("tomorrow", now, zone), "2026-09-16");
    // Case- and whitespace-insensitive: a model's own phrasing varies.
    assert.equal(normaliseDay("  Tomorrow  ", now, zone), "2026-09-16");
  });

  it("does not roll over at UTC midnight when the zone has not reached it yet", () => {
    // 23:30 UTC on the 15th is still only 19:30 on the 15th in New York --
    // "today" must not flip just because UTC's date already has, and must
    // flip in a zone that is genuinely ahead of it.
    const now = new Date(Date.UTC(2026, 8, 15, 23, 30));
    assert.equal(normaliseDay("today", now, "America/New_York"), "2026-09-15");
    assert.equal(normaliseDay("today", now, "Pacific/Auckland"), "2026-09-16");
  });

  it("accepts a literal YYYY-MM-DD and refuses one that only looks like it", () => {
    const now = new Date(Date.UTC(2026, 8, 15));
    assert.equal(normaliseDay("2026-09-16", now, zone), "2026-09-16");
    for (const bad of ["2026-13-01", "2026-02-30", "next thursday", "16/09/2026", ""]) {
      assert.equal(normaliseDay(bad, now, zone), undefined, bad);
    }
  });

  it("uses the real day of the given clock, not today's date read at test time", () => {
    // Pinned to a fixed `now` throughout: this file has no reason to depend
    // on the day it happens to run, and asserting against `todayKey` at all
    // is only meaningful because both sides take an explicit clock.
    const now = new Date(Date.UTC(2026, 8, 15, 10, 0));
    assert.equal(todayKey(now, zone), "2026-09-15");
  });
});

describe("monthGrid", () => {
  // Every fixture below was checked against a real calendar (`date -d`)
  // rather than derived from the implementation, so a bug that drops or
  // duplicates the first or last day of a month has something to be wrong
  // against.

  it("a month whose first and last day fall mid-week (Sept 2026, Tue-Wed)", () => {
    const grid = monthGrid("2026-09-16");
    assert.equal(grid.length, 35);
    assert.equal(grid[0], "2026-08-30");
    assert.equal(grid.at(-1), "2026-10-03");
  });

  it("does not lose the year boundary (Dec 2026, Tue-Thu)", () => {
    const grid = monthGrid("2026-12-01");
    assert.equal(grid.length, 35);
    assert.equal(grid[0], "2026-11-29");
    assert.equal(grid.at(-1), "2027-01-02");
  });

  it("keeps the 29th on a leap February (2028, Tue-Tue)", () => {
    const grid = monthGrid("2028-02-10");
    assert.equal(grid.length, 35);
    assert.equal(grid[0], "2028-01-30");
    assert.equal(grid.at(-1), "2028-03-04");
    assert.ok(grid.includes("2028-02-29"));
  });

  it("a month that needs a sixth week (Aug 2026, Sat-Mon)", () => {
    const grid = monthGrid("2026-08-01");
    assert.equal(grid.length, 42);
    assert.equal(grid[0], "2026-07-26");
    assert.equal(grid.at(-1), "2026-09-05");
  });

  it("reads only the year and month -- any day in the month gives the same grid", () => {
    assert.deepEqual(monthGrid("2026-09-01"), monthGrid("2026-09-30"));
  });

  it("is always a whole number of seven-day weeks", () => {
    for (const day of ["2026-01-15", "2026-02-15", "2026-04-15", "2026-11-15"]) {
      assert.equal(monthGrid(day).length % 7, 0, day);
    }
  });
});
