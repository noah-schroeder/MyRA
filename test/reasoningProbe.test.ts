/**
 * The check that answers "why can't I see the reasoning?".
 *
 * Each test is a real server behaving the way a real provider does, because the
 * whole point of the feature is to report what an endpoint actually did rather
 * than what its documentation says it does.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ASK_FOR_REASONING, describeProbe, probeReasoning, PROBE_PROMPT,
} from "../src/core/llm/reasoningProbe.ts";
import { buildRequest } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";

type Behaviour = (body: Record<string, unknown>) => { status?: number; frames: unknown[] };

let behaviour: Behaviour = () => ({ frames: [] });
let seen: Record<string, unknown> = {};
let server: Server;
let baseUrl = "";

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });

before(async () => {
  server = createServer(async (req, res) => {
    seen = JSON.parse((await read(req)) || "{}") as Record<string, unknown>;
    const { status, frames } = behaviour(seen);
    if (status && status >= 400) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown parameter" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const endpoint = (): EndpointSettings => ({ baseUrl, model: "m", envVar: "", timeoutMs: 5_000 });
const text = (content: string): unknown => ({ choices: [{ delta: { content } }] });

describe("what the check can tell apart", () => {
  it("a provider that sends reasoning in a field Karen reads", async () => {
    behaviour = () => ({
      frames: [{ choices: [{ delta: { reasoning_content: "17 times 23" } }] }, text("391")],
    });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.deepEqual(report.read, ["reasoning_content"]);
    assert.equal(report.chars, 11);
    assert.match(describeProbe(report), /Reasoning arrived in “reasoning_content”/);
  });

  it("a provider that sends it in a field nobody else uses", async () => {
    behaviour = () => ({
      frames: [{ choices: [{ delta: { thought_summary: "carrying the one" } }] }, text("391")],
    });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.deepEqual(report.unread, ["thought_summary"]);
    assert.match(describeProbe(report), /“thought_summary”, which Karen does not read yet/);
  });

  it("a provider that reasons and withholds the chain", async () => {
    behaviour = () => ({
      frames: [
        text("391"),
        { choices: [], usage: { completion_tokens_details: { reasoning_tokens: 412 } } },
      ],
    });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.equal(report.reasoningTokens, 412);
    assert.deepEqual(report.read, []);
    assert.match(describeProbe(report), /412 reasoning tokens and sent none of the text/);
  });

  it("a provider that sends nothing at all", async () => {
    behaviour = () => ({ frames: [text("391")] });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.match(describeProbe(report), /No reasoning of any kind came back/);
  });

  it("reasoning written inline in tags", async () => {
    behaviour = () => ({ frames: [text("<thinking>hm</thinking>391")] });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.equal(report.inline, true);
    assert.match(describeProbe(report), /inline, in <thinking> tags/);
  });

  it("an endpoint that refuses the request says so, and does not read as silence", async () => {
    behaviour = () => ({ status: 400, frames: [] });
    const report = await probeReasoning({ endpoint: endpoint() });
    assert.equal(report.ok, false);
    assert.equal(report.status, 400);
    assert.match(describeProbe(report), /did not answer the test request/);
  });
});

describe("asking for it", () => {
  it("reports when asking is what made the difference", async () => {
    behaviour = (body) =>
      body["reasoning"]
        ? { frames: [{ choices: [{ delta: { reasoning: "because" } }] }, text("391")] }
        : { frames: [text("391")] };

    const plain = await probeReasoning({ endpoint: endpoint() });
    const asked = await probeReasoning({ endpoint: endpoint(), extra: ASK_FOR_REASONING });
    assert.deepEqual(plain.read, []);
    assert.deepEqual(asked.read, ["reasoning"]);
    assert.match(describeProbe(plain, asked), /only when Karen asked for it/);
  });

  it("puts the asking fields in the request and leaves the rest of it alone", () => {
    const body = buildRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      extra: ASK_FOR_REASONING,
    });
    assert.deepEqual(body["reasoning"], { enabled: true });
    assert.equal(body.model, "m", "extras must not be able to displace the model");
    assert.equal(body.stream, true);
    assert.equal(body.messages.length, 1);
  });

  it("cannot be used to rewrite the request", () => {
    const body = buildRequest({
      model: "real",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      extra: { model: "sneaky", messages: [], stream: false },
    });
    assert.equal(body.model, "real");
    assert.equal(body.stream, true);
    assert.equal(body.messages.length, 1);
  });
});

describe("what the check sends", () => {
  it("asks a fixed question and none of the user's conversation", async () => {
    behaviour = () => ({ frames: [text("391")] });
    await probeReasoning({ endpoint: endpoint() });
    const messages = seen["messages"] as { role: string; content: string }[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.content, PROBE_PROMPT);
  });
});
