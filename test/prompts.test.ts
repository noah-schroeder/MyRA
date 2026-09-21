/**
 * The questions main asks the window, and who may answer them.
 *
 * `myra:answer-prompt` takes an id and settles whatever is waiting on it. The
 * ids were `p1`, `p2`, `p3`, so anything reaching that channel could answer a
 * question it had never been shown -- including the tool-approval confirm,
 * which is the second line of defence behind the registry. And nothing ever
 * cleared them, so a reload during a question hung the turn forever.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PendingPrompts } from "../src/core/agent/pending.ts";

test("ids are unguessable and never repeat", () => {
  const prompts = new PendingPrompts();
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(prompts.open().id);
  assert.equal(ids.size, 200, "an id was reused");
  for (const id of ids) {
    assert.ok(!/^p\d+$/.test(id), `${id} is a guessable sequence number`);
    assert.ok(id.length >= 32, `${id} is too short to be unguessable`);
  }
});

test("an answer settles its own question and nothing else", async () => {
  const prompts = new PendingPrompts();
  const first = prompts.open();
  const second = prompts.open();

  assert.equal(prompts.answer(first.id, "yes"), true);
  assert.equal(await first.answer, "yes");
  assert.equal(prompts.size, 1, "the other question is still waiting");

  assert.equal(prompts.answer(second.id, undefined), true);
  assert.equal(await second.answer, undefined);
});

test("an unknown or repeated answer does nothing", async () => {
  const prompts = new PendingPrompts();
  assert.equal(prompts.answer("p1", "yes"), false, "the old guessable shape answers nothing");
  assert.equal(prompts.answer(crypto.randomUUID(), "yes"), false);

  const one = prompts.open();
  assert.equal(prompts.answer(one.id, "yes"), true);
  /* Deleted before resolving, so a window that answers twice -- a double
     click, a re-render -- cannot settle a later question by the same id. */
  assert.equal(prompts.answer(one.id, "no"), false);
  assert.equal(await one.answer, "yes");
});

test("a reload declines everything outstanding rather than hanging the turn", async () => {
  const prompts = new PendingPrompts();
  const confirm = prompts.open();
  const question = prompts.open();

  assert.equal(prompts.cancelAll(), 2);
  assert.equal(prompts.size, 0);

  /* `undefined` is the safe answer both callers already expect: approve()
     returns `answer === "yes"`, so this denies. */
  assert.equal(await confirm.answer, undefined);
  assert.equal(await question.answer, undefined);
  assert.equal(prompts.cancelAll(), 0, "cancelling twice is not an error");
});
