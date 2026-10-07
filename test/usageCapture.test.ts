/**
 * Every model call is counted where it reaches the network, with whatever the
 * server actually reported -- and only that.
 *
 * Driven against a real local server, because what is under test is what
 * arrives on the wire: a usage block in the last stream frame, a usage block
 * that never comes, llama.cpp's `timings`, a 500. The sink is the one main
 * installs; here it only collects.
 */

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chat, runSubagent } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";
import { setUsageSink, withUsage, type UsageEvent, type UsageTags } from "../src/core/usage/context.ts";
import { embedTexts } from "../src/core/research/embed.ts";
import { wavSeconds } from "../src/core/stt.ts";

type Reply = { status?: number; stream?: string[]; json?: unknown };
let reply: Reply = {};
let server: Server;
let baseUrl = "";

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const content = (text: string): string => frame({ choices: [{ delta: { content: text } }] });

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      if (reply.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const f of reply.stream) res.write(f);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let seen: { event: UsageEvent; tags: UsageTags }[] = [];
const collect = (): void => {
  seen = [];
  setUsageSink((event, tags) => seen.push({ event, tags }));
};
afterEach(() => setUsageSink(undefined));

const endpoint = (): EndpointSettings => ({ baseUrl, envVar: "", model: "m-1", timeoutMs: 5_000 });
const user = [{ role: "user" as const, content: "hi" }];

describe("a streamed reply", () => {
  it("is counted with the usage block from its last frame, and its timing", async () => {
    collect();
    reply = {
      stream: [
        content("Hel"),
        content("lo"),
        frame({
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } },
          timings: { prompt_ms: 40, predicted_ms: 70 },
        }),
      ],
    };
    await chat({ endpoint: endpoint(), messages: user, onDelta: () => {} });
    assert.equal(seen.length, 1);
    const { event } = seen[0]!;
    assert.equal(event.kind, "text");
    assert.equal(event.model, "m-1");
    assert.equal(event.baseUrl, baseUrl);
    assert.equal(event.outcome, "ok");
    assert.equal(event.input, 120);
    assert.equal(event.output, 7);
    assert.equal(event.cached, 100);
    assert.equal(event.genMs, 70, "the server's own generation time, not ours");
    assert.ok(event.ms >= 0);
  });

  it("carries NO counts when the server sent no usage -- not zeros", async () => {
    collect();
    reply = { stream: [content("Hello")] };
    const result = await chat({ endpoint: endpoint(), messages: user, onDelta: () => {} });
    // The caller still sees zeros, which the context meter needs...
    assert.equal(result.usage.input, 0);
    // ...and the record sees nothing, which the dashboard needs.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.event.input, undefined);
    assert.equal(seen[0]!.event.output, undefined);
  });

  it("reads llama.cpp's cache_n when usage itemises nothing", async () => {
    collect();
    reply = {
      stream: [
        content("Hi"),
        frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 }, timings: { cache_n: 48 } }),
      ],
    };
    await chat({ endpoint: endpoint(), messages: user, onDelta: () => {} });
    assert.equal(seen[0]!.event.cached, 48);
  });
});

describe("a whole reply", () => {
  it("is counted from the body's usage, with reasoning tokens kept apart", async () => {
    collect();
    reply = {
      json: {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 25 } },
      },
    };
    await chat({ endpoint: endpoint(), messages: user });
    const { event } = seen[0]!;
    assert.equal(event.input, 10);
    assert.equal(event.output, 30);
    assert.equal(event.reasoning, 25);
    assert.equal(event.genMs, undefined, "no stream, no honest generation time");
  });
});

describe("a call that fails", () => {
  it("is counted as an error, and the error still reaches the caller", async () => {
    collect();
    reply = { status: 400 };
    await assert.rejects(chat({ endpoint: endpoint(), messages: user }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.event.outcome, "error");
  });

  it("is counted once per attempt when a stage retries", async () => {
    collect();
    reply = { status: 503 };
    await assert.rejects(runSubagent({ model: "m-1", prompt: "x", endpoint: endpoint() }));
    assert.equal(seen.length, 3, "three attempts, three requests on the wire");
    assert.ok(seen.every((s) => s.event.outcome === "error"));
  });

  it("is counted as cancelled when the caller stopped it", async () => {
    collect();
    reply = { stream: [content("a")] };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(chat({ endpoint: endpoint(), messages: user, onDelta: () => {}, signal: controller.signal }));
    assert.equal(seen[0]!.event.outcome, "cancelled");
  });

  it("is not counted at all when nothing was sent", async () => {
    collect();
    await assert.rejects(chat({ endpoint: { ...endpoint(), baseUrl: "" }, messages: user }));
    assert.equal(seen.length, 0);
  });
});

describe("who it was for", () => {
  it("arrives with the tags in force where the call was made", async () => {
    collect();
    reply = { json: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
    await withUsage({ feature: "review", item: { kind: "review", ref: "r1" } }, () =>
      chat({ endpoint: endpoint(), messages: user }),
    );
    assert.equal(seen[0]!.tags.feature, "review");
    assert.deepEqual(seen[0]!.tags.item, { kind: "review", ref: "r1" });
  });

  it("is untagged rather than dropped when nobody said", async () => {
    collect();
    await chat({ endpoint: endpoint(), messages: user });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.tags.feature, undefined);
  });

  it("never fails the call when the sink throws", async () => {
    setUsageSink(() => {
      throw new Error("disk full");
    });
    const result = await chat({ endpoint: endpoint(), messages: user });
    assert.equal(result.text, "ok");
  });
});

describe("embeddings", () => {
  it("are counted per batch in input tokens", async () => {
    collect();
    reply = { json: { data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 9, total_tokens: 9 } } };
    await embedTexts(["one"], "embedder", { baseUrl, apiKey: "" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.event.kind, "embeddings");
    assert.equal(seen[0]!.event.input, 9);
    assert.equal(seen[0]!.event.model, "embedder");
  });
});

describe("audio length", () => {
  const wav = (seconds: number, rate = 16_000): Buffer => {
    const data = rate * 2 * seconds;
    const b = Buffer.alloc(44 + data);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(36 + data, 4);
    b.write("WAVE", 8, "ascii");
    b.writeUInt32LE(rate * 2, 28);
    return b;
  };

  it("is read off the header MyRA wrote", () => {
    assert.equal(wavSeconds(wav(3)), 3);
    assert.equal(wavSeconds(wav(1, 24_000)), 1);
  });

  it("is nothing for anything that is not a WAV", () => {
    assert.equal(wavSeconds(Buffer.from("ID3 not a wav at all, an mp3 header and then some")), undefined);
    assert.equal(wavSeconds(Buffer.alloc(10)), undefined);
  });
});
