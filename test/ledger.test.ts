/**
 * One numbering per conversation.
 *
 * `[1]` meaning two different papers in one thread is the worst failure this
 * app has available to it: a wrong citation, rendered as a working link, with
 * nothing on screen saying it changed. It was real -- every search numbered
 * from one and the renderer keys its source table by that number -- so these
 * are the tests that keep it fixed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cite, citedSoFar, reserve, resetCitations, resumeCitations, shiftCitations,
} from "../src/core/research/ledger.ts";

test("a second search does not reuse the first search's numbers", () => {
  resetCitations();
  assert.deepEqual(cite(["https://a", "https://b"]), [1, 2]);
  assert.deepEqual(cite(["https://c", "https://d"]), [3, 4]);
});

test("the same source keeps the number it was first given", () => {
  /* This is what makes a marker in an earlier paragraph still true after a
     later search: the paper it points at has not moved. */
  resetCitations();
  assert.deepEqual(cite(["https://a", "https://b"]), [1, 2]);
  assert.deepEqual(cite(["https://b", "https://e"]), [2, 3]);
  assert.equal(citedSoFar(), 3);
});

test("a deep run is moved clear of what is already cited, in one piece", () => {
  /* Its report and bibliography are numbered together from [1]. Shifting both
     by the same amount is the only property that has to hold. */
  const report = "Training does not transfer [1], though span improves [2, 3].";
  assert.equal(
    shiftCitations(report, 8),
    "Training does not transfer [9], though span improves [10, 11].",
  );
  assert.equal(shiftCitations("A range [1-3] too.", 8), "A range [9-11] too.");
});

test("shifting leaves alone anything that is not a citation", () => {
  // A year span read as thirty-one citations would invent references.
  assert.equal(shiftCitations("Between [1990-2020] the field grew.", 5),
    "Between [1990-2020] the field grew.");
  assert.equal(shiftCitations("Nothing here.", 5), "Nothing here.");
  assert.equal(shiftCitations("[1] stays put", 0), "[1] stays put");
});

test("reserving spends numbers without claiming to know what they point at", () => {
  resetCitations();
  cite(["https://a"]);
  assert.equal(reserve(4), 1, "a deep run starting after one cited source shifts by one");
  assert.equal(citedSoFar(), 5);
  assert.deepEqual(cite(["https://later"]), [6], "the reserved block is not handed out again");
});

test("reopening a conversation resumes above the numbers already on screen", () => {
  /* The renderer rebuilds its source table from stored tool output, so those
     numbers are live the moment a thread opens. Starting again from one would
     hand out numbers that are already visible, pointing at other papers. */
  resumeCitations([
    "[1] A paper\n    https://a\n[2] Another\n    https://b",
    "[7] A later one\n    https://g",
  ]);
  assert.equal(citedSoFar(), 7);
  assert.deepEqual(cite(["https://new"]), [8]);
});

test("resuming ignores bracketed numbers that are not citation lines", () => {
  // Only a marker at the start of a line, the way the tools print them.
  resumeCitations(["a mention of [42] mid-sentence", "[3] Real one\n    https://c"]);
  assert.equal(citedSoFar(), 3);
});

test("a new conversation starts at one again", () => {
  resetCitations();
  cite(["https://a", "https://b"]);
  resetCitations();
  assert.deepEqual(cite(["https://z"]), [1]);
});
