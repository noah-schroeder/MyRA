/**
 * Reopening a conversation.
 *
 * The risk being tested for is not a crash — it is a thread that comes back
 * looking plausible but wrong: a tool card marked done that never finished, or
 * prose full of [3] markers pointing at nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreThread, harvestSources, type StoredMessage } from "../src/renderer/restore.ts";

const SEARCH_OUTPUT = [
  "[1] Pedagogical agents and learning outcomes",
  "    https://doi.org/10.1234/abc",
  "    Smith, Jones. Computers & Education. A meta-analysis of 42 studies.",
  "",
  "[2] Do animated agents help?",
  "    https://arxiv.org/abs/2401.00001",
  "    Lee et al. A randomised trial.",
].join("\n");

test("a finished tool call comes back as a finished card", () => {
  const { items } = restoreThread([
    { role: "system", content: "you are MyRA" },
    { role: "user", content: "find me some papers" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "web_search", arguments: '{"query":"agents"}' } }],
    },
    { role: "tool", content: SEARCH_OUTPUT, tool_call_id: "c1", name: "web_search" },
    { role: "assistant", content: "Two studies are relevant [1], [2]." },
  ]);

  assert.deepEqual(items.map((i) => i.kind), ["user", "tool", "assistant"]);

  const card = items[1]!;
  assert.equal(card.kind, "tool");
  if (card.kind !== "tool") return;
  assert.equal(card.name, "web_search");
  assert.equal(card.status, "ok");
  assert.deepEqual(card.args, { query: "agents" });
  assert.equal(card.output, SEARCH_OUTPUT);
});

test("the system prompt is never shown back to the user", () => {
  // It is ours, not the conversation's, and it is wording the user never wrote.
  const { items } = restoreThread([
    { role: "system", content: "you are MyRA, and here are your instructions" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "user");
});

test("citations survive the round trip", () => {
  // The [n] markers live in the assistant's prose, but the sources they point
  // at were only ever in the tool output. Without harvesting them a reopened
  // conversation shows numbered markers that resolve to nothing.
  const { sources } = restoreThread([
    { role: "user", content: "find me some papers" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "web_search", arguments: "{}" } }],
    },
    { role: "tool", content: SEARCH_OUTPUT, tool_call_id: "c1" },
    { role: "assistant", content: "Two studies are relevant [1], [2]." },
  ]);

  assert.equal(sources.size, 2);
  assert.equal(sources.get(1)!.url, "https://doi.org/10.1234/abc");
  assert.equal(sources.get(1)!.title, "Pedagogical agents and learning outcomes");
  assert.equal(sources.get(2)!.url, "https://arxiv.org/abs/2401.00001");
});

test("a call whose result never arrived is not reported as done", () => {
  // The app closed mid-turn. Marking this "ok" would claim an outcome that
  // never happened, which is exactly the failure that made rebuilding the
  // thread worth doing properly rather than approximately.
  const { items } = restoreThread([
    { role: "user", content: "search" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c9", function: { name: "deep_research", arguments: "{}" } }],
    },
  ]);

  const card = items.at(-1)!;
  assert.equal(card.kind, "tool");
  if (card.kind !== "tool") return;
  assert.equal(card.status, "error");
  assert.match(card.output, /did not finish/);
});

test("a failure that was fed back to the model still reads as a failure", () => {
  // Failures were returned as ordinary tool results rather than thrown, so
  // nothing in the stored form marks them. They must not come back green.
  const failures = [
    'There is no tool named "bash". Available: web_search',
    "The arguments were not valid JSON (Unexpected token). Try again.",
    "fetch_page failed: HTTP 404 Not Found",
    'The tool "deep_research" is not enabled in the current settings.',
  ];

  for (const [i, output] of failures.entries()) {
    const { items } = restoreThread([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `f${i}`, function: { name: "web_search", arguments: "{}" } }],
      },
      { role: "tool", content: output, tool_call_id: `f${i}` },
    ]);
    const card = items.at(-1)!;
    assert.equal(card.kind, "tool");
    if (card.kind !== "tool") return;
    assert.equal(card.status, "error", `not marked as a failure: ${output}`);
  }
});

test("a successful result that merely mentions failure is left alone", () => {
  // A paper about why interventions fail is a successful search.
  const { items } = restoreThread([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "web_search", arguments: "{}" } }],
    },
    {
      role: "tool",
      content: "[1] Why educational technology interventions failed: a review\n    https://x.test/a\n    Summary.",
      tool_call_id: "c1",
    },
  ]);
  const card = items.at(-1)!;
  assert.equal(card.kind, "tool");
  if (card.kind !== "tool") return;
  assert.equal(card.status, "ok");
});

test("several calls in one turn keep their order and their own results", () => {
  const { items } = restoreThread([
    { role: "user", content: "compare them" },
    {
      role: "assistant",
      content: "Let me look at both.",
      tool_calls: [
        { id: "a", function: { name: "fetch_page", arguments: '{"url":"https://x.test/1"}' } },
        { id: "b", function: { name: "fetch_page", arguments: '{"url":"https://x.test/2"}' } },
      ],
    },
    { role: "tool", content: "first page", tool_call_id: "a" },
    { role: "tool", content: "second page", tool_call_id: "b" },
  ]);

  // The assistant's own words come before the cards it opened.
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant", "tool", "tool"]);
  const [first, second] = [items[2]!, items[3]!];
  assert.equal(first.kind === "tool" && first.output, "first page");
  assert.equal(second.kind === "tool" && second.output, "second page");
});

test("malformed stored arguments lose the parameters, not the card", () => {
  const { items } = restoreThread([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "web_search", arguments: "{not json" } }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1" },
  ]);
  const card = items.at(-1)!;
  assert.equal(card.kind, "tool");
  if (card.kind !== "tool") return;
  assert.deepEqual(card.args, {});
  assert.equal(card.name, "web_search", "the card must still say what ran");
});

test("an image-only turn -- no caption at all -- survives a reopen", () => {
  // content is empty for a message that is only an attachment; the guard used
  // to be `if (m.content?.trim())` alone, which dropped the entire turn --
  // not just the chip -- so a reopened conversation showed the assistant's
  // reply answering what looked like nothing.
  const { items } = restoreThread([
    { role: "user", content: "", attachments: [{ kind: "image", name: "scan.png" }] },
    { role: "assistant", content: "That looks like a receipt." },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant"]);
  const user = items[0]!;
  assert.equal(user.kind, "user");
  if (user.kind !== "user") return;
  assert.equal(user.text, "");
});

test("an attachment chip comes back on reopen, not just the caption", () => {
  const { items } = restoreThread([
    {
      role: "user",
      content: "What does this say?",
      attachments: [{ kind: "image", name: "scan.png" }],
    },
  ]);
  const user = items[0]!;
  assert.equal(user.kind, "user");
  if (user.kind !== "user") return;
  assert.equal(user.text, "What does this say?");
  assert.deepEqual(user.attachments, [{ kind: "image", name: "scan.png" }]);
});

test("a plain message with no attachments carries none back", () => {
  const { items } = restoreThread([{ role: "user", content: "hi" }]);
  const user = items[0]!;
  assert.equal(user.kind, "user");
  if (user.kind !== "user") return;
  assert.equal(user.attachments, undefined);
});

test("harvesting is shared with the live path, so numbering cannot drift", () => {
  // If these two ever diverge, reopening a conversation silently renumbers it.
  assert.deepEqual(
    harvestSources(SEARCH_OUTPUT).map((s) => s.n),
    [1, 2],
  );
  assert.deepEqual(harvestSources(undefined), []);
  assert.deepEqual(harvestSources("no citations here"), []);
});
