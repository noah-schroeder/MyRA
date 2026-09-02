/**
 * Reasoning, in every shape a provider actually sends it.
 *
 * Karen read two field names and one inline tag. That was enough for llama.cpp
 * and for DeepSeek, and it silently produced nothing at all against providers
 * using any of the other conventions -- which looks, on screen, exactly like a
 * model that did no reasoning. Driven against a real SSE server for the same
 * reason chatIdle is: the frame-by-frame path is where the bug would live.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chat } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";

/** The SSE frames the next request should receive. Set per test. */
let frames: string[] = [];
let server: Server;
let baseUrl = "";

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(f);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function stream(): Promise<{ text: string; thinking: string; result: Awaited<ReturnType<typeof chat>> }> {
  const endpoint: EndpointSettings = { baseUrl, model: "m", envVar: "", timeoutMs: 5_000 };
  let text = "";
  let thinking = "";
  const result = await chat({
    endpoint,
    messages: [{ role: "user", content: "hello" }],
    onDelta: (d, kind) => {
      if (kind === "thinking") thinking += d;
      else text += d;
    },
  });
  return { text, thinking, result };
}

describe("the field a provider states its reasoning in", () => {
  it("reads reasoning_content, which is llama.cpp's and DeepSeek's", async () => {
    frames = [
      sse({ choices: [{ delta: { reasoning_content: "weighing it" } }] }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "weighing it");
    assert.equal(out.text, "Blue.");
  });

  it("reads reasoning, which is OpenRouter's", async () => {
    frames = [
      sse({ choices: [{ delta: { reasoning: "weighing it" } }] }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "weighing it");
  });

  it("reads reasoning_details, the structured form", async () => {
    frames = [
      sse({
        choices: [
          { delta: { reasoning_details: [{ type: "reasoning.text", text: "weighing it" }] } },
        ],
      }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "weighing it");
  });

  it("reads thinking_blocks, which gateways relaying an Anthropic reply emit", async () => {
    frames = [
      sse({
        choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "weighing it" }] } }],
      }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "weighing it");
  });

  it("keeps the reasoning out of the answer text in every case", async () => {
    frames = [
      sse({ choices: [{ delta: { reasoning: "workings" } }] }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.text, "Blue.");
    assert.equal(out.result.text, "Blue.", "the message history must not carry the reasoning");
    assert.equal(out.result.reasoning, "workings");
  });

  it("invents nothing when the field holds no string", async () => {
    frames = [
      sse({ choices: [{ delta: { reasoning: { signature: "abc" } } }] }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "");
    assert.equal(out.result.reasoning, undefined);
  });
});

describe("reasoning written inline, in tags", () => {
  it("separates <thinking>, which the Claude family writes", async () => {
    frames = [
      sse({ choices: [{ delta: { content: "<thinking>weigh" } }] }),
      sse({ choices: [{ delta: { content: "ing it</thinking>Blue." } }] }),
    ];
    const out = await stream();
    assert.equal(out.thinking, "weighing it");
    assert.equal(out.text, "Blue.");
  });

  it("separates <think>, which most llama.cpp templates write", async () => {
    frames = [sse({ choices: [{ delta: { content: "<think>hm</think>Blue." } }] })];
    const out = await stream();
    assert.equal(out.thinking, "hm");
    assert.equal(out.text, "Blue.");
  });
});

describe("a provider that reasons and does not send it", () => {
  it("reports the count it was told about", async () => {
    frames = [
      sse({ choices: [{ delta: { content: "Blue." } }] }),
      sse({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 500,
          total_tokens: 510,
          completion_tokens_details: { reasoning_tokens: 412 },
        },
      }),
    ];
    const out = await stream();
    assert.equal(out.result.hiddenReasoning, 412);
    // Counted inside completion_tokens already; the meter must not double it.
    assert.equal(out.result.usage.output, 500);
  });

  it("says nothing when the reasoning did arrive", async () => {
    frames = [
      sse({ choices: [{ delta: { reasoning: "workings" } }] }),
      sse({ choices: [{ delta: { content: "Blue." } }] }),
      sse({
        choices: [],
        usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 412 } },
      }),
    ];
    const out = await stream();
    assert.equal(out.result.hiddenReasoning, undefined);
  });
});
