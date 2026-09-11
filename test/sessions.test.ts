/**
 * A conversation on disk, and what survives writing it and reading it back.
 *
 * `saveSession` writes `messages_` verbatim -- no field is stripped on the way
 * out or reconstructed on the way in -- which is exactly what makes a
 * message's speed stats and its image references round-trip for free. This
 * pins that they actually do, since nothing else in the test suite reads a
 * session back off disk.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadSession, saveSession, type Session } from "../src/core/sessions.ts";
import type { ChatMessage } from "../src/core/llm/chat.ts";

function session(id: string, messages_: ChatMessage[]): Session {
  const now = new Date().toISOString();
  return { id, title: "Test", createdAt: now, updatedAt: now, messages: messages_.length, messages_ };
}

test("a message's speed stats survive a save and a reopen", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "How fast are you?" },
    {
      role: "assistant",
      content: "Quite.",
      meta: { promptTokens: 12, completionTokens: 4, tokensPerSecond: 42.1, totalMs: 900, measured: true },
    },
  ];
  await saveSession(session("test-stats-roundtrip", messages));
  const loaded = await loadSession("test-stats-roundtrip");
  assert.deepEqual(loaded?.messages_[1]?.meta, {
    promptTokens: 12, completionTokens: 4, tokensPerSecond: 42.1, totalMs: 900, measured: true,
  });
});

test("an image reference survives a save and a reopen", async () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "What does this say?",
      attachments: [{ id: "img1", kind: "image", name: "scan.png", mime: "image/png" }],
    },
  ];
  await saveSession(session("test-attachment-roundtrip", messages));
  const loaded = await loadSession("test-attachment-roundtrip");
  assert.deepEqual(loaded?.messages_[0]?.attachments, [
    { id: "img1", kind: "image", name: "scan.png", mime: "image/png" },
  ]);
  // Content is still plain text -- the image never touched it.
  assert.equal(loaded?.messages_[0]?.content, "What does this say?");
});

test("a plain message with neither carries neither back", async () => {
  await saveSession(session("test-plain-roundtrip", [{ role: "user", content: "Hi" }]));
  const loaded = await loadSession("test-plain-roundtrip");
  assert.equal(loaded?.messages_[0]?.meta, undefined);
  assert.equal(loaded?.messages_[0]?.attachments, undefined);
});
