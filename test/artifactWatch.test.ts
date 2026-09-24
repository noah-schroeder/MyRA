import { strict as assert } from "node:assert";
import { test } from "node:test";

import { makeIdCounter, makeWatcher, maxDrawnId } from "../src/core/agent/tools/artifactWatch.ts";

test("a counter produces an increasing, prefixed sequence", () => {
  const ids = makeIdCounter("chart");
  assert.equal(ids.next(), "chart-1");
  assert.equal(ids.next(), "chart-2");
  assert.equal(ids.next(), "chart-3");
});

test("reset with no argument goes back to the start of the sequence", () => {
  const ids = makeIdCounter("chart");
  ids.next();
  ids.next();
  ids.reset();
  assert.equal(ids.next(), "chart-1");
});

test("reset with a starting point continues the sequence past it", () => {
  const ids = makeIdCounter("chart");
  ids.reset(2);
  assert.equal(ids.next(), "chart-3");
});

test("two counters are independent of each other", () => {
  const a = makeIdCounter("diagram");
  const b = makeIdCounter("table");
  a.next();
  a.next();
  assert.equal(b.next(), "table-1");
});

test("an uninstalled watcher announces to nobody", () => {
  const w = makeWatcher<number>();
  // Nothing to assert beyond "this does not throw" -- the whole point of
  // leaving a watcher uninstalled is that announcing is a safe no-op.
  w.announce(1);
});

test("a watcher delivers to whatever is installed, and to a replacement once set", () => {
  const w = makeWatcher<string>();
  const seenA: string[] = [];
  const seenB: string[] = [];
  w.set((v) => seenA.push(v));
  w.announce("one");
  w.set((v) => seenB.push(v));
  w.announce("two");
  assert.deepEqual(seenA, ["one"]);
  assert.deepEqual(seenB, ["two"]);
});

test("clearing a watcher stops delivery", () => {
  const w = makeWatcher<string>();
  const seen: string[] = [];
  w.set((v) => seen.push(v));
  w.set(undefined);
  w.announce("dropped");
  assert.deepEqual(seen, []);
});

test("maxDrawnId reads the highest matching suffix", () => {
  assert.equal(maxDrawnId("chart", ["chart-1", "chart-3", "chart-2"]), 3);
});

test("maxDrawnId ignores ids with a different prefix", () => {
  assert.equal(maxDrawnId("chart", ["chart-1", "table-9", "diagram-5"]), 1);
});

test("maxDrawnId is 0 for an empty or non-matching list", () => {
  assert.equal(maxDrawnId("chart", []), 0);
  assert.equal(maxDrawnId("chart", ["table-1", "diagram-2"]), 0);
});
