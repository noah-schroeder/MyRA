/**
 * The review record: the id that becomes a path, and the file read back.
 *
 * The same two hazards the paper record meets, plus one of its own.
 *
 * The id comes back from a sandboxed window to be joined onto the reviews root
 * and then read and deleted -- the journey `assertPaperId`, `assertImageId` and
 * `assertRunId` all exist for.
 *
 * The file sits in a folder the user is invited to open, so one of them will
 * eventually be edited by hand or synced half-written, and a list that throws on
 * the fifth of twenty reviews is worse than one that skips it.
 *
 * And the third: a record left saying `running` by a process that died is not
 * running. Read back as such, it would give the list a spinner that never
 * resolves and a Stop button attached to nothing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assertReviewId, byNewest, newReview, reviewId, summaryOf, type Review,
} from "../src/core/review/record.ts";
import { idOfFile, parseRecord, reviewFileName } from "../src/core/review/store.ts";

const made = (over: Partial<Review> = {}): Review => ({
  ...newReview({
    title: "Working memory training and fluid intelligence",
    fileName: "nguyen-final-FINAL-v3.pdf",
    words: 8412,
    studyTypeId: "experimental",
    studyLabel: "Experimental / intervention study",
    prompt: "House rules.",
    note: "",
    reviewers: 3,
    now: new Date(2026, 8, 9, 14, 31),
  }),
  ...over,
});

describe("a review id", () => {
  it("is legible, and dated by the clock the file manager prints", () => {
    const id = reviewId("Working memory training", new Date(2026, 8, 9, 14, 31));
    assert.equal(id, "20260909-1431-working-memory-training");
  });

  it("survives a title made entirely of punctuation", () => {
    assert.match(reviewId("!!! ???", new Date(2026, 0, 1, 9, 0)), /^20260101-0900-review$/);
  });

  it("refuses anything that is not one", () => {
    for (const bad of ["../secrets", "a/b", ".", "..", "", "with space"]) {
      assert.throws(() => assertReviewId(bad), /no review named/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(assertReviewId("20260909-1431-a_b.c-d"), "20260909-1431-a_b.c-d");
  });

  it("recognises its own filenames and nothing else", () => {
    assert.equal(idOfFile(reviewFileName("20260909-1431-x")), "20260909-1431-x");
    assert.equal(idOfFile("notes.txt"), undefined);
    assert.equal(idOfFile("../escape.json"), undefined);
    assert.equal(idOfFile("..json"), undefined);
  });
});

describe("reading a review back", () => {
  it("keeps the word count and never expects the manuscript", () => {
    const parsed = parseRecord(JSON.parse(JSON.stringify(made())), "id-1");
    assert.equal(parsed?.words, 8412);
    /* The point of the whole record: there is no field for the text, so no
       version of this can quietly start keeping somebody else's manuscript. */
    assert.equal("manuscript" in (parsed as unknown as Record<string, unknown>), false);
  });

  it("reads a run that died as stopped, not as still running", () => {
    const parsed = parseRecord({ ...made(), status: "running" }, "id-1");
    assert.equal(parsed?.status, "stopped");
  });

  it("keeps the reviewers it can read and drops the ones it cannot", () => {
    const parsed = parseRecord(
      {
        ...made(),
        reports: [
          { reviewerId: "theory", label: "Reviewer 1", text: "Solid framing." },
          { label: "Reviewer 2", text: "   " },
          "not a report",
          { label: "Reviewer 3", text: "The analysis needs work." },
        ],
      },
      "id-1",
    );
    assert.equal(parsed?.reports.length, 2);
    assert.equal(parsed?.reports[1]?.label, "Reviewer 3");
    /* A report that lost its id still gets one, numbered by where it sat in the
       file rather than by where it ended up: two survivors of a damaged record
       must not be renumbered into ids that belonged to the ones that went. */
    assert.equal(parsed?.reports[1]?.reviewerId, "reviewer-4");
  });

  it("refuses what is not a record at all", () => {
    for (const bad of [undefined, null, 4, "text", []]) {
      assert.equal(parseRecord(bad, "id-1"), undefined);
    }
  });

  it("falls back to the reports it has when the panel size is missing", () => {
    const { reviewers: _drop, ...without } = made();
    const parsed = parseRecord(
      { ...without, reports: [{ label: "Reviewer 1", text: "Fine." }] },
      "id-1",
    );
    assert.equal(summaryOf(parsed!).total, 1);
  });
});

describe("what the list shows", () => {
  it("counts finished reviewers against the panel that was asked for", () => {
    const review = made({
      reports: [{ reviewerId: "theory", label: "Reviewer 1", text: "Solid." }],
      status: "stopped",
    });
    const summary = summaryOf(review);
    assert.equal(summary.done, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.status, "stopped");
  });

  it("puts the most recently written first", () => {
    const rows = [
      summaryOf(made({ id: "a", updatedAt: "2026-09-01T10:00:00.000Z" })),
      summaryOf(made({ id: "b", updatedAt: "2026-09-09T10:00:00.000Z" })),
    ].sort(byNewest);
    assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
  });
});
