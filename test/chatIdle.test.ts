/**
 * The timeout counts silence, not duration.
 *
 * Driven against a real HTTP server rather than a mocked fetch, because the bug
 * this replaces lived in the interaction between a signal and a response body:
 * `AbortSignal.timeout` handed to `fetch` tears down the BODY as well as the
 * wait for headers, so a model that was streaming happily had its answer cut
 * off. Nothing short of a real stream demonstrates that.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chat, LlmError } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";

/** What the next request should do. Set per test. */
let behaviour: (write: (chunk: string) => void, end: () => void) => void = () => {};
let server: Server;
let baseUrl = "";

const frame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    behaviour(
      (chunk) => res.write(chunk),
      () => res.end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const endpoint = (timeoutMs: number): EndpointSettings => ({
  baseUrl,
  envVar: "KAREN_LLM_KEY",
  timeoutMs,
});

describe("a slow but living stream", () => {
  it("is not cut off, even when it runs far past the timeout", async () => {
    /*
     * Eight frames, 40ms apart, against a 100ms timeout: total elapsed is well
     * over three times the deadline, and every individual gap is under it. The
     * old total-duration timeout failed this at frame three.
     */
    behaviour = (write, end) => {
      let n = 0;
      const tick = setInterval(() => {
        if (n === 8) {
          clearInterval(tick);
          write("data: [DONE]\n\n");
          end();
          return;
        }
        write(frame(`tok${n} `));
        n += 1;
      }, 40);
    };

    const seen: string[] = [];
    const result = await chat({
      endpoint: endpoint(100),
      messages: [{ role: "user", content: "hello" }],
      onDelta: (d) => seen.push(d),
    });

    assert.equal(seen.length, 8);
    assert.match(result.text, /^tok0 tok1 .*tok7 $/);
  });
});

describe("a stream that stops sending", () => {
  it("fails at the deadline, and says the reply was cut off", async () => {
    // Two frames, then nothing at all — a wedged server, which is what the
    // timeout genuinely exists to catch.
    behaviour = (write) => {
      write(frame("start"));
      setTimeout(() => write(frame(" of something")), 20);
    };

    await assert.rejects(
      () =>
        chat({
          endpoint: endpoint(150),
          messages: [{ role: "user", content: "hello" }],
          onDelta: () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof LlmError, `got ${(err as Error).name}`);
        assert.match((err as Error).message, /stopped producing output for 0\.15s/);
        return true;
      },
    );
  });
});

describe("stopping deliberately", () => {
  it("is reported as an abort, not as a timeout", async () => {
    /* Pressing stop and a model hanging are different events and must not
       produce the same sentence -- one is the user's own doing. */
    behaviour = (write) => {
      write(frame("thinking"));
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await assert.rejects(
      () =>
        chat({
          endpoint: endpoint(10_000),
          messages: [{ role: "user", content: "hello" }],
          signal: controller.signal,
          onDelta: () => {},
        }),
      (err: unknown) => {
        assert.doesNotMatch(String((err as Error).message), /stopped producing output/);
        return true;
      },
    );
  });
});
