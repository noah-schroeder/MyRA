/**
 * How far along a reply is, while it is still being made.
 *
 * `return_progress` and the `prompt_progress` frame shape were measured
 * against the bundled llama-server b10375 and through lemond 11.8.0, not
 * guessed: one frame per batch, `processed` counting the cached tokens too.
 * Driven against a real streaming server, because the thing under test is
 * what arrives frame by frame -- and what is sent, since asking a server that
 * does not know the field can cost the whole request.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { buildRequest, chat, runSubagent } from "../src/core/llm/chat.ts";
import type { TurnProgress } from "../src/core/llm/progress.ts";
import { describeProgress, formatElapsed, promptFraction } from "../src/core/llm/progress.ts";
import type { EndpointSettings } from "../src/core/config.ts";

let frames: string[] = [];
let bodies: Record<string, unknown>[] = [];
let server: Server;
let baseUrl = "";

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const progress = (processed: number, total = 3000, cache = 0): string =>
  frame({ choices: [{ delta: { role: "assistant", content: null } }], prompt_progress: { total, cache, processed, time_ms: 1 } });
const content = (text: string): string => frame({ choices: [{ delta: { content: text } }] });

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) res.write(f);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const endpoint = (): EndpointSettings => ({ baseUrl, envVar: "", model: "test", timeoutMs: 5_000 });

describe("asking for it", () => {
  it("is sent only when the caller says the server is the bundled runtime, and only when streaming", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    assert.equal(buildRequest({ messages, stream: true })["return_progress"], undefined);
    assert.equal(buildRequest({ messages, stream: true, promptProgress: true })["return_progress"], true);
    assert.equal(buildRequest({ messages, stream: false, promptProgress: true })["return_progress"], undefined);
  });
});

describe("reading it", () => {
  it("reports each prompt batch, then the reply's frames, in order", async () => {
    frames = [progress(0), progress(2048), progress(3000), content("Hel"), content("lo")];
    bodies = [];
    const seen: TurnProgress[] = [];
    const result = await chat({
      endpoint: endpoint(),
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
      onProgress: (p) => seen.push(p),
      promptProgress: true,
    });
    assert.equal(result.text, "Hello");
    assert.equal(bodies[0]?.["return_progress"], true);
    assert.deepEqual(seen.slice(0, 3), [
      { phase: "prompt", total: 3000, cache: 0, processed: 0 },
      { phase: "prompt", total: 3000, cache: 0, processed: 2048 },
      { phase: "prompt", total: 3000, cache: 0, processed: 3000 },
    ]);
    // The first frame of the reply is reported at once; later ones are throttled.
    assert.deepEqual(seen[3], { phase: "writing", tokens: 1 });
  });

  it("counts reasoning and tool-call frames as the reply arriving too", async () => {
    frames = [
      frame({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "x", arguments: "{}" } }] } }] }),
    ];
    const seen: TurnProgress[] = [];
    await chat({ endpoint: endpoint(), messages: [{ role: "user", content: "hi" }], onDelta: () => {}, onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen, [{ phase: "writing", tokens: 1 }]);
  });

  it("reaches a subagent caller, with the fields it asked to send", async () => {
    frames = [progress(10, 10, 4), content("{}")];
    bodies = [];
    const seen: TurnProgress[] = [];
    await runSubagent({
      model: "test",
      endpoint: endpoint(),
      prompt: "json please",
      onDelta: () => {},
      onStreamProgress: (p) => seen.push(p),
      promptProgress: true,
      extra: { chat_template_kwargs: { enable_thinking: true } },
    });
    assert.equal(bodies[0]?.["return_progress"], true);
    assert.deepEqual(bodies[0]?.["chat_template_kwargs"], { enable_thinking: true });
    assert.deepEqual(seen[0], { phase: "prompt", total: 10, cache: 4, processed: 10 });
  });
});

describe("saying it", () => {
  it("measures the bar against the work not already cached", () => {
    assert.equal(promptFraction({ total: 3000, cache: 2900, processed: 2950 }), 0.5);
    assert.equal(promptFraction({ total: 3000, cache: 3000, processed: 3000 }), 1);
    assert.equal(promptFraction({ total: 2000, cache: 0, processed: 0 }), 0);
  });

  it("describes each phase in words, and never prints a count it does not have", () => {
    assert.equal(describeProgress({ phase: "waiting" }), "Waiting for the model");
    // Digit grouping follows the machine's locale, so the separator is left open.
    assert.match(
      describeProgress({ phase: "prompt", total: 3000, cache: 1000, processed: 2024 }),
      /^Reading the conversation — 1.?024 of 2.?000 tokens \(1.?000 already cached\)$/,
    );
    assert.equal(describeProgress({ phase: "writing", tokens: 0 }), "Writing");
    assert.match(describeProgress({ phase: "writing", tokens: 1234 }), /^Writing — ~1.?234 tokens$/);
    assert.equal(describeProgress({ phase: "tool", tool: "web_search" }), "Running web_search");
    assert.equal(describeProgress({ phase: "asking" }), "Waiting for your answer");
  });

  it("formats elapsed time to the second", () => {
    assert.equal(formatElapsed(999), "0s");
    assert.equal(formatElapsed(42_000), "42s");
    assert.equal(formatElapsed(185_000), "3m 05s");
  });
});
