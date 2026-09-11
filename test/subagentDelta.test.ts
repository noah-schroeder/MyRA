/**
 * A stage can tell the model's thinking from its answer while it streams.
 *
 * `chat` has always separated the two -- both the inline `<think>` spelling and
 * the `reasoning_content` field beside the content -- and passed the kind to its
 * own `onDelta`. `runSubagent` then relabelled every frame as `"text"` on the
 * way out, so no caller of it could take the distinction. documents/draft.ts has
 * branched on `kind === "thinking"` since it was written and could never once
 * have entered that branch.
 *
 * It matters now because the paper drafter shows a model's reasoning live and
 * must never write it into the draft. Driven against a real streaming server,
 * because the thing under test is what arrives frame by frame.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { runSubagent } from "../src/core/llm/chat.ts";
import type { EndpointSettings } from "../src/core/config.ts";

let frames: string[] = [];
let server: Server;
let baseUrl = "";

const content = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

const reasoning = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;

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

function endpoint(): EndpointSettings {
  return { baseUrl, envVar: "MYRA_LLM_KEY", model: "test", timeoutMs: 5_000 };
}

async function run(): Promise<{ seen: [string, string][]; text: string }> {
  const seen: [string, string][] = [];
  const result = await runSubagent({
    model: "test",
    endpoint: endpoint(),
    prompt: "write it",
    onDelta: (delta, kind) => seen.push([kind, delta]),
  });
  return { seen, text: result.text };
}

describe("streaming a stage", () => {
  it("reports reasoning as reasoning and prose as prose", async () => {
    frames = [reasoning("weighing "), reasoning("it up"), content("The prose.")];
    const { seen, text } = await run();

    assert.deepEqual(
      seen.filter(([kind]) => kind === "thinking").map(([, d]) => d).join(""),
      "weighing it up",
    );
    assert.equal(seen.filter(([kind]) => kind === "text").map(([, d]) => d).join(""), "The prose.");
    /* And the answer is still only the answer. This is what keeps a model's
       working-out out of a draft that gets saved. */
    assert.equal(text, "The prose.");
  });

  it("does the same for a model that writes its thinking inline", async () => {
    frames = [content("<think>hmm</think>"), content("The prose.")];
    const { seen, text } = await run();

    assert.equal(
      seen.filter(([kind]) => kind === "thinking").map(([, d]) => d).join(""),
      "hmm",
    );
    assert.equal(text, "The prose.");
  });

  it("says nothing about thinking when the model did none", async () => {
    frames = [content("Just "), content("prose.")];
    const { seen, text } = await run();

    assert.equal(seen.some(([kind]) => kind === "thinking"), false);
    assert.equal(text, "Just prose.");
  });
});
