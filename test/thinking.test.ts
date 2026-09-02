/**
 * Splitting `<think>` out of a stream, one frame at a time.
 *
 * The awkward cases are all about frame boundaries: a tag arrives in pieces,
 * and text that merely starts with `<` must not be held hostage waiting for a
 * tag that is never going to come.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { splitThinking, type DeltaKind } from "../src/core/llm/thinking.ts";

function run(frames: string[]): { text: string; thinking: string; events: number } {
  let text = "";
  let thinking = "";
  let events = 0;
  const split = splitThinking((s: string, kind: DeltaKind) => {
    events++;
    if (kind === "thinking") thinking += s;
    else text += s;
  });
  for (const f of frames) split.push(f);
  split.flush();
  return { text, thinking, events };
}

test("a whole think block in one frame is separated from the answer", () => {
  const out = run(["<think>weighing it up</think>The sky is blue."]);
  assert.equal(out.thinking, "weighing it up");
  assert.equal(out.text, "The sky is blue.");
});

test("a tag split across frames is still found", () => {
  const out = run(["<th", "ink>be", "cause", "</thi", "nk>Blue."]);
  assert.equal(out.thinking, "because");
  assert.equal(out.text, "Blue.");
});

test("a tag split character by character is still found", () => {
  const out = run([..."<think>hm</think>done"]);
  assert.equal(out.thinking, "hm");
  assert.equal(out.text, "done");
});

test("text that only looks like a tag is released, not held", () => {
  // `<` is common in prose and in code; holding it until the reply ends would
  // make the answer arrive in stutters.
  const out = run(["a < b and ", "c <= d"]);
  assert.equal(out.text, "a < b and c <= d");
  assert.equal(out.thinking, "");
});

test("an unterminated think block is still reported as thinking", () => {
  // Stopped early, or the model never closed the tag: the words are reasoning
  // either way, and dropping them would hide the whole turn.
  const out = run(["<think>halfway through a thou"]);
  assert.equal(out.thinking, "halfway through a thou");
  assert.equal(out.text, "");
});

test("several blocks in one reply alternate correctly", () => {
  const out = run(["<think>one</think>A<think>two</think>B"]);
  assert.equal(out.thinking, "onetwo");
  assert.equal(out.text, "AB");
});

test("a reply with no tags at all passes straight through", () => {
  const out = run(["Hello ", "there."]);
  assert.equal(out.text, "Hello there.");
  assert.equal(out.thinking, "");
  assert.equal(out.events, 2, "no frame should be buffered when no tag is possible");
});

test("the longer spelling is recognised character by character", () => {
  // The hazard is that `<think` is a prefix of both spellings: releasing it as
  // soon as `<think>` fails to match would print half a tag into the answer.
  const out = run([..."<thinking>hm</thinking>done"]);
  assert.equal(out.thinking, "hm");
  assert.equal(out.text, "done");
});

test("a block is closed by its own tag, not the other one", () => {
  const out = run(["<think>hm</thinking>still thinking</think>done"]);
  assert.equal(out.thinking, "hm</thinking>still thinking");
  assert.equal(out.text, "done");
});
