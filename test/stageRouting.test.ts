/**
 * Which server a research stage's request actually reaches.
 *
 * This is the bug the per-stage model picker rests on. `runSubagent` used to
 * resolve the endpoint by asking for the CONVERSATION's model and then pasting
 * the stage's model NAME onto it -- so a screener assigned a local model, while
 * the conversation was on a hosted provider, was sent to that provider, with
 * that provider's key, asking for a model it had never heard of.
 *
 * Two real servers, because the whole question is which one is called.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { runSubagent, setEndpointResolver } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";

interface Seen {
  model?: string;
  auth?: string;
  body: Record<string, unknown>;
}

function stub(): { server: Server; url: () => string; seen: () => Seen[] } {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    seen.push({
      model: body["model"] as string,
      auth: req.headers.authorization ?? "",
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen: () => seen,
  };
}

const hosted = stub();
const local = stub();

before(async () => {
  await new Promise<void>((r) => hosted.server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => local.server.listen(0, "127.0.0.1", r));
});

after(async () => {
  setEndpointResolver(undefined);
  await new Promise<void>((r) => hosted.server.close(() => r()));
  await new Promise<void>((r) => local.server.close(() => r()));
});

/** Stands in for the app's resolver: a hosted conversation, a local model too. */
function install(): void {
  setEndpointResolver(async (ref?: string) => {
    const at = (baseUrl: string, model: string): EndpointSettings => ({
      baseUrl, model, envVar: "", timeoutMs: 10_000,
    });
    if (ref === "prov1::big-model") {
      return { endpoint: at(hosted.url(), "big-model"), apiKey: "hosted-key" };
    }
    if (ref === "Qwen3-4B") {
      return {
        endpoint: at(local.url(), "Qwen3-4B"),
        sampling: { temperature: 0.9, top_p: 0.8 },
      };
    }
    // No reference: the conversation's own model, which here is the hosted one.
    return { endpoint: at(hosted.url(), "big-model"), apiKey: "hosted-key" };
  });
}

describe("a stage is resolved from its own model, not the conversation's", () => {
  it("sends a local stage to the local server, with no hosted key attached", async () => {
    install();
    await runSubagent({ prompt: "screen these", model: "Qwen3-4B" });
    const got = local.seen().at(-1)!;
    assert.equal(got.model, "Qwen3-4B");
    assert.equal(got.auth, "", "a local endpoint must not be sent a provider's key");
  });

  it("sends a hosted stage to that provider, with its own key", async () => {
    install();
    await runSubagent({ prompt: "synthesise", model: "prov1::big-model" });
    const got = hosted.seen().at(-1)!;
    assert.equal(got.model, "big-model", "the qualified id is resolved, not sent as a name");
    assert.equal(got.auth, "Bearer hosted-key");
  });

  it("falls back to the conversation's model when a stage names none", async () => {
    install();
    const before = hosted.seen().length;
    await runSubagent({ prompt: "no model named", model: "" });
    assert.equal(hosted.seen().length, before + 1);
  });

  it("still honours a model named on an endpoint the caller supplied itself", async () => {
    install();
    await runSubagent({
      prompt: "explicit endpoint",
      endpoint: { baseUrl: local.url(), model: "ignored", envVar: "", timeoutMs: 10_000 },
      model: "named-by-caller",
    });
    assert.equal(local.seen().at(-1)!.model, "named-by-caller");
  });
});

describe("the tuning a stage inherits", () => {
  it("carries the model's own sampling but not its temperature", async () => {
    install();
    await runSubagent({ prompt: "extract", model: "Qwen3-4B" });
    const body = local.seen().at(-1)!.body;
    assert.equal(body["top_p"], 0.8, "tuning follows the model wherever it answers");
    /* Screening, extraction and verification are not creative tasks. A model
       tuned warm for writing would start inventing at exactly the points this
       pipeline exists to be literal, so the stage default stands. */
    assert.equal(body["temperature"], 0.2);
  });
});
