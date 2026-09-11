/**
 * Making room without corrupting the conversation.
 *
 * The dangerous case is the tool pair. A `tool` message whose `tool_call_id`
 * points at an assistant message that is no longer in the request is a protocol
 * error, and servers reject the whole request rather than the stray message --
 * so a compaction that split one would turn "running low on context" into "the
 * conversation stopped working", which is far worse than the problem it set out
 * to solve.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateFixedTokens, estimateTokens, needsCompaction, planCompaction, summaryMessage,
  transcriptFor, COMPACT_AT,
} from "../src/core/agent/compact.ts";
import type { ChatMessage } from "../src/core/llm/chat.ts";

const user = (t: string): ChatMessage => ({ role: "user", content: t });
const bot = (t: string): ChatMessage => ({ role: "assistant", content: t });

function withTools(id: string): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "web_search", arguments: "{}" } }],
    },
    { role: "tool", content: "a result", tool_call_id: id, name: "web_search" },
  ];
}

/* ------------------------------------------------------------- threshold -- */

test("nothing happens without a known window", () => {
  // A remote endpoint whose context Karen cannot know must never trigger this:
  // guessing a limit and summarising against it would destroy a conversation
  // that was nowhere near full.
  assert.equal(needsCompaction(999_999, undefined), false);
  assert.equal(needsCompaction(999_999, 0), false);
});

test("the threshold is a share of the window, not a fixed number", () => {
  assert.equal(needsCompaction(3000, 8192), false);
  assert.equal(needsCompaction(8192 * COMPACT_AT, 8192), true);
  assert.equal(needsCompaction(150_000, 262_144), false);
  assert.equal(needsCompaction(200_000, 262_144), true);
});

/* ----------------------------------------------------------- the split --- */

test("a short conversation is left alone", () => {
  assert.equal(planCompaction([user("hi"), bot("hello")], 4000), undefined);
});

test("a few enormous messages are compactable, not just many small ones", () => {
  /*
   * The case that broke the first version, found by running it: three long
   * pastes filled a 2048-token window between them, a "keep the last six
   * messages" rule found nothing it was allowed to summarise, and the
   * conversation died at the limit with the feature meant to prevent it
   * looking on. Measured in tokens, the same rule handles both shapes.
   */
  const huge = [user("x".repeat(8000)), bot("ok"), user("y".repeat(8000)), bot("ok"), user("z".repeat(400))];
  const plan = planCompaction(huge, Math.floor(2048 * 0.4));
  assert.ok(plan, "should have found something to summarise");
  assert.ok(plan.summarise.length >= 1);
  assert.ok(plan.keep.length >= 2, "the last exchange stays verbatim");
  assert.ok(estimateTokens(plan.keep) < estimateTokens(huge));
});

test("recent messages are kept word for word", () => {
  const messages = [...Array(12)].map((_, i) => (i % 2 ? bot(`a${i}`) : user(`q${i}`)));
  // Each message is a handful of tokens, so a small budget keeps a few of them.
  const plan = planCompaction(messages, 30);
  assert.ok(plan);
  assert.deepEqual(plan.keep, messages.slice(-plan.keep.length));
  assert.equal(plan.summarise.length + plan.keep.length, messages.length);
  assert.ok(plan.keep.length >= 2 && plan.keep.length < messages.length);
});

test("a tool result is never separated from the call that made it", () => {
  // The split would naturally land between the assistant's tool_calls and the
  // tool result answering them.
  const messages = [
    user("q1"), bot("a1"), user("q2"), bot("a2"),
    ...withTools("call_1"),
    bot("final"),
  ];
  const plan = planCompaction(messages, 20);
  assert.ok(plan);

  const ids = new Set(
    plan.keep.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []),
  );
  for (const m of plan.keep) {
    if (m.role === "tool") {
      assert.ok(ids.has(m.tool_call_id!), `orphaned result for ${m.tool_call_id}`);
    }
  }
});

test("an assistant message with unanswered calls is not the last thing kept", () => {
  const messages = [user("q"), bot("a"), user("q2"), ...withTools("call_9")];
  const plan = planCompaction(messages, 10);
  if (plan) {
    const last = plan.summarise.at(-1);
    assert.ok(!last?.tool_calls?.length, "kept a call whose result was summarised away");
  }
});

test("a conversation that is one indivisible exchange is refused", () => {
  const plan = planCompaction([...withTools("c1"), ...withTools("c2")], 10);
  // Either it declines, or whatever it keeps is still internally consistent.
  if (plan) assert.notEqual(plan.summarise.length, 0);
});

/* ------------------------------------------------------------ the prompt -- */

test("tool output is excerpted, not re-sent whole", () => {
  const huge = "x".repeat(50_000);
  const text = transcriptFor([{ role: "tool", content: huge, tool_call_id: "c", name: "fetch" }]);
  assert.ok(text.length < 1000, `${text.length} characters is not an excerpt`);
  assert.match(text, /result of fetch/);
});

test("the transcript names who said what", () => {
  const text = transcriptFor([user("find the paper"), bot("done")]);
  assert.match(text, /User: find the paper/);
  assert.match(text, /Assistant: done/);
});

test("the summary is labelled as a summary and says how much it replaced", () => {
  const m = summaryMessage("They discussed pedagogical agents.", 14);
  // A `user` message, not a second `system` one: mid-conversation system
  // messages are handled inconsistently and some templates drop all but the
  // first.
  assert.equal(m.role, "user");
  assert.match(m.content!, /14 earlier messages/);
  assert.match(m.content!, /pedagogical agents/);
});

/* ------------------------------------------------------------- estimate -- */

test("the estimate sees the message about to be sent, not just the reply", () => {
  // The bug this exists for: occupancy reported by the last reply cannot
  // include the message the user has just typed, so a conversation that was
  // comfortably inside the window one turn ago is refused on this one -- and
  // by the time the reply says so, the request has already failed.
  const short = [user("hi")];
  const long = [user("x".repeat(40_000))];
  assert.ok(estimateTokens(long) > estimateTokens(short) * 100);
  assert.ok(needsCompaction(estimateTokens(long), 8192));
  assert.ok(!needsCompaction(estimateTokens(short), 8192));
});

test("the estimate errs high rather than low", () => {
  // A real measurement: 40,563 characters of English notes counted 10,836
  // tokens on SmolLM2's tokeniser, which is 3.74 characters per token. The
  // estimate must not come in under that, because under-counting is what lets
  // an over-long request through.
  const measured = 10_836;
  const estimate = estimateTokens([user("x".repeat(40_563))]);
  assert.ok(estimate >= measured, `${estimate} must not undercount ${measured}`);
});

test("tool call arguments are counted, not just prose", () => {
  const withArgs: ChatMessage = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: "x".repeat(4000) } }],
  };
  assert.ok(estimateTokens([withArgs]) > 900, "a 4000-character argument list is not free");
});

test("an attached image is not free -- content stays a string, so it has no characters to count", () => {
  const bare: ChatMessage = { role: "user", content: "What does this say?" };
  const withImage: ChatMessage = {
    ...bare,
    attachments: [{ id: "img1", kind: "image", name: "scan.png", mime: "image/png" }],
  };
  assert.ok(
    estimateTokens([withImage]) > estimateTokens([bare]) + 1000,
    "an image attachment must cost real tokens, not ride along for free",
  );
});

test("a document attachment does not double-count -- its text is already in content by the time it is stored", () => {
  const withDoc: ChatMessage = {
    role: "user",
    content: "Some inlined paper text.",
    attachments: [{ id: "doc1", kind: "document", name: "paper.pdf", words: 500 }],
  };
  const sameTextNoAttachment: ChatMessage = { role: "user", content: "Some inlined paper text." };
  assert.equal(estimateTokens([withDoc]), estimateTokens([sameTextNoAttachment]));
});

test("a summary covers messages counted against the real transcript", () => {
  // `upTo` indexes the caller's untouched history. Getting this wrong by
  // measuring against the already-compacted list would drop real messages every
  // time the summary was reused, silently, one turn at a time.
  const history = [...Array(20)].map((_, i) => (i % 2 ? bot(`a${i}`) : user(`q${i}`)));
  const plan = planCompaction(history, 40);
  assert.ok(plan);
  const upTo = history.length - plan.keep.length;
  assert.deepEqual(history.slice(upTo), plan.keep);
  assert.equal(upTo, plan.summarise.length);
});

test("the tool schemas count against the window", () => {
  /*
   * Measured: Karen's seven tools serialise to about a thousand tokens, sent
   * with every request. Omitting them made compaction fire roughly twelve
   * hundred tokens late — found by watching an already-compacted request still
   * exceed a 2,048-token window by more than its messages could account for.
   */
  const tools = [...Array(7)].map((_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: "d".repeat(200),
      parameters: { type: "object", properties: { q: { type: "string", description: "p".repeat(200) } } },
    },
  }));
  const fixed = estimateFixedTokens(tools);
  assert.ok(fixed > 500, `${fixed} tokens is not a plausible seven-tool schema`);
  assert.equal(estimateFixedTokens(undefined), 0);

  // With the schemas counted, a conversation that looked comfortable is not.
  const messages = [user("x".repeat(3000))];
  assert.equal(needsCompaction(estimateTokens(messages), 2048), false);
  assert.equal(needsCompaction(estimateTokens(messages) + fixed, 2048), true);
});

test("the summary message itself pluralises", () => {
  assert.match(summaryMessage("s", 1).content!, /1 earlier message[^s]/);
  assert.match(summaryMessage("s", 4).content!, /4 earlier messages/);
});

test("one enormous reply does not get to sink the request", () => {
  /*
   * Observed against a 4,096-token window: three messages summarised and the
   * request still offered 6,498 tokens, because the rule insisted on keeping
   * the last *exchange* and the assistant's previous reply was on its own
   * larger than the window. Keeping the message the user is waiting on an
   * answer to is a floor worth having; keeping the one before it is not.
   */
  const messages = [user("a"), bot("b"), user("c"), bot("x".repeat(30_000)), user("and now?")];
  const plan = planCompaction(messages, Math.floor(4096 * 0.4));
  assert.ok(plan);
  assert.deepEqual(plan.keep, [messages.at(-1)], "only the newest message survives");
  assert.ok(plan.summarise.includes(messages[3]!), "the enormous reply is summarised");
});

test("a conversation that fits is not summarised at all", () => {
  // Reached only when something says the window is tight, but the plan still
  // has to be able to answer "nothing here would help".
  assert.equal(planCompaction([user("hi"), bot("hello")], 4000), undefined);
  assert.equal(planCompaction([user("hi"), bot("hello"), user("more")], 4000), undefined);
});
