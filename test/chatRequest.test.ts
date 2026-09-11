/**
 * What actually reaches the wire, versus what the stored message carries.
 *
 * `ChatMessage` grows MyRA's own bookkeeping over time -- speed stats, an
 * attachment reference -- and each one is a field a strict server has never
 * heard of. `buildRequest` is where that bookkeeping is stripped back off
 * before the request leaves, so this pins that it actually happens rather
 * than trusting the spread to have done it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildRequest, type ChatMessage } from "../src/core/llm/chat.ts";

test("a message's speed stats never reach the request body", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: "The sample size was 214.",
      meta: { promptTokens: 512, completionTokens: 12, totalMs: 900, measured: true },
    },
  ];
  const body = buildRequest({ messages });
  assert.deepEqual(body.messages, [{ role: "assistant", content: "The sample size was 214." }]);
  assert.ok(!("meta" in body.messages[0]!));
});

test("a message with no stats round-trips with nothing extra added", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];
  const body = buildRequest({ messages });
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
});

test("an image attachment is expanded into content parts, and the reference itself never reaches the wire", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "What does this say?",
      attachments: [{ id: "img1", kind: "image", name: "scan.png", mime: "image/png" }],
    },
  ];
  const body = buildRequest({ messages, resolveImage: (id) => `data:image/png;base64,${id}` });
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "What does this say?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,img1" } },
      ],
    },
  ]);
  assert.ok(!("attachments" in body.messages[0]!));
});

test("without a resolveImage callback, an attachment is left as plain text -- no half-built request", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "Hi", attachments: [{ id: "img1", kind: "image", name: "x.png" }] },
  ];
  const body = buildRequest({ messages });
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
});
