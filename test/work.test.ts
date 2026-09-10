/**
 * The lease on long work, and the snapshot a late subscriber gets.
 *
 * Three properties, each of which replaces a bug that was fixed twice.
 *
 * The snapshot is absolute. Both features used to stream append-this frames and
 * carry a `reset` flag for the case where `runSubagent` retried after streaming
 * half a report -- the same fix written into the reviewer and into the drafter,
 * either of which could have been forgotten. With a whole-state snapshot,
 * writing a report twice is not expressible.
 *
 * A page that arrives late gets everything. This is the difference between
 * coming back to a review four minutes into its second reviewer and seeing that
 * reviewer, and seeing an empty page until the third begins -- which is what
 * `karen:research-active`, having no such question, still does.
 *
 * And one job at a time, across both features, because two long generations on
 * one card is the out-of-memory meetings avoids by transcribing serially.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createJobs, WORK_CHANNEL, type JobSnapshot } from "../src/main/work.ts";

/** A window that records what it was sent, in order. */
function spy() {
  const sent: (JobSnapshot | null)[] = [];
  const send = (channel: string, payload?: unknown): void => {
    assert.equal(channel, WORK_CHANNEL);
    sent.push(payload as JobSnapshot | null);
  };
  return { sent, send };
}

const review = { kind: "review" as const, id: "20260909-1431-x", title: "A manuscript", steps: 3 };

describe("the lease", () => {
  it("is held by one job at a time, whichever feature asks", () => {
    const jobs = createJobs(spy().send);
    assert.notEqual(jobs.begin(review), undefined);
    assert.equal(jobs.begin({ kind: "paper", id: "p1", title: "A paper", steps: 1 }), undefined);
    jobs.end();
    assert.notEqual(jobs.begin({ kind: "paper", id: "p1", title: "A paper", steps: 1 }), undefined);
  });

  it("hands back a signal that Stop actually aborts", () => {
    const jobs = createJobs(spy().send);
    const signal = jobs.begin(review)!;
    assert.equal(signal.aborted, false);
    jobs.cancel();
    assert.equal(signal.aborted, true);
  });

  it("ignores a Stop aimed at a job that has already been replaced", () => {
    const jobs = createJobs(spy().send);
    const signal = jobs.begin(review)!;
    /* A page still showing the previous run must not abort the one that took
       its place. */
    jobs.cancel("some-older-review");
    assert.equal(signal.aborted, false);
    jobs.cancel(review.id);
    assert.equal(signal.aborted, true);
  });
});

describe("the snapshot", () => {
  it("is the whole state, so a late subscriber needs no history", () => {
    const jobs = createJobs(spy().send);
    jobs.begin(review);
    jobs.step({ step: 1, label: "Reviewer 2 — Methods" });
    jobs.append("thinking", "weighing the design");
    jobs.append("text", "The sample is ");
    jobs.append("text", "underpowered.");

    const now = jobs.current()!;
    assert.equal(now.step, 1);
    assert.equal(now.steps, 3);
    assert.equal(now.label, "Reviewer 2 — Methods");
    assert.equal(now.text, "The sample is underpowered.");
    assert.equal(now.thinking, "weighing the design");
  });

  it("starts the step again on a retry rather than appending to it", () => {
    const jobs = createJobs(spy().send);
    jobs.begin(review);
    jobs.append("text", "Half a report that died");
    jobs.restart();
    jobs.append("text", "The whole report");
    /* The bug this replaces: the second attempt appended to the first and the
       reviewer watched their summary written twice. */
    assert.equal(jobs.current()?.text, "The whole report");
  });

  it("clears the previous reviewer's reasoning when the next one starts", () => {
    const jobs = createJobs(spy().send);
    jobs.begin(review);
    jobs.append("thinking", "about reviewer one");
    jobs.step({ step: 1, label: "Reviewer 2" });
    /* Left on screen it would be attributed to the reviewer now writing. */
    assert.equal(jobs.current()?.thinking, "");
    assert.equal(jobs.current()?.text, "");
  });

  it("says nothing is running once it ends", () => {
    const jobs = createJobs(spy().send);
    jobs.begin(review);
    jobs.end();
    assert.equal(jobs.current(), undefined);
  });
});

describe("what the window is told", () => {
  it("publishes at once when the step changes, so the wait is explained", () => {
    const { sent, send } = spy();
    const jobs = createJobs(send);
    jobs.begin(review);
    jobs.step({ step: 1, label: "Reviewer 2" });
    jobs.end();
    /* Begin, step, end -- none of them waiting on the throttle, because each is
       a change somebody is looking at the rail for. */
    assert.equal(sent.length, 3);
    assert.equal(sent[1]?.label, "Reviewer 2");
    assert.equal(sent[2], null);
  });

  it("does not publish a frame per token", () => {
    const { sent, send } = spy();
    const jobs = createJobs(send);
    jobs.begin(review);
    for (let i = 0; i < 200; i += 1) jobs.append("text", "word ");
    /* Only the one from `begin`: the text is throttled, and the buffer above is
       what a page reads when it arrives. */
    assert.equal(sent.length, 1);
    assert.equal(jobs.current()?.text.length, 1000);
  });
});
