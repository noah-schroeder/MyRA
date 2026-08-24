/**
 * The approval hook.
 *
 * Wired because the alternative was a permission mode that changed nothing:
 * `decide()` was never called and every tool's declared risk class was inert.
 * These assert the hook has effect, and that a refusal is a result the model
 * can act on rather than a crashed turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTurn } from "../src/core/agent/loop.ts";
import { ToolRegistry, type ToolDef } from "../src/core/agent/registry.ts";
import { decide, PERMISSION_MODES, FLOOR_CLASSES } from "../src/core/policy.ts";

async function withServer<T>(
  replies: unknown[],
  body: (endpoint: { baseUrl: string; envVar: string; timeoutMs: number }, seen: unknown[]) => Promise<T>,
): Promise<T> {
  const seen: unknown[] = [];
  let turn = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replies[Math.min(turn++, replies.length - 1)]));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    return await body({ baseUrl: `http://127.0.0.1:${port}/v1`, envVar: "K", timeoutMs: 5_000 }, seen);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const says = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
const calls = (name: string, args: unknown) => ({
  choices: [{
    message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: "tool_calls",
  }],
});

function writeTool(ran: string[]): ToolDef {
  return {
    name: "write_document",
    description: "write",
    risk: "write",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    handler: async (params) => {
      ran.push(String(params["name"]));
      return { content: "written" };
    },
  };
}

test("a refused call does not run, and the model is told plainly", async () => {
  const ran: string[] = [];
  const registry = new ToolRegistry();
  registry.register(writeTool(ran));

  await withServer([calls("write_document", { name: "memo.md" }), says("Understood.")], async (endpoint, requests) => {
    const result = await runTurn({
      registry,
      endpoint,
      messages: [{ role: "user", content: "write a memo" }],
      approve: async () => false,
    });

    assert.deepEqual(ran, [], "the handler must not run when the call was refused");
    assert.equal(result.text, "Understood.", "the turn continues rather than failing");

    const second = requests[1] as { messages: { role: string; content: string }[] };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    assert.match(toolMsg!.content, /declined to run write_document/);
  });
});

test("an approved call runs, and the hook sees what it is approving", async () => {
  const ran: string[] = [];
  const seen: { tool: string; params: Record<string, unknown> }[] = [];
  const registry = new ToolRegistry();
  registry.register(writeTool(ran));

  await withServer([calls("write_document", { name: "memo.md" }), says("Done.")], async (endpoint) => {
    await runTurn({
      registry,
      endpoint,
      messages: [{ role: "user", content: "write a memo" }],
      approve: async (tool, params) => {
        seen.push({ tool, params });
        return true;
      },
    });
  });

  assert.deepEqual(ran, ["memo.md"]);
  // The hook must receive the real parameters: approving "write a document"
  // without being told which one is not consent to anything in particular.
  assert.deepEqual(seen, [{ tool: "write_document", params: { name: "memo.md" } }]);
});

test("with no hook installed, nothing is gated", async () => {
  const ran: string[] = [];
  const registry = new ToolRegistry();
  registry.register(writeTool(ran));
  await withServer([calls("write_document", { name: "a.md" }), says("Done.")], async (endpoint) => {
    await runTurn({ registry, endpoint, messages: [{ role: "user", content: "go" }] });
  });
  assert.deepEqual(ran, ["a.md"]);
});

test("the modes differ where it matters, and agree where it does not", () => {
  // Manual means manual: it gates reads too, which makes a research run a
  // wall of prompts. That is a real choice for a cautious user and the
  // settings copy says so plainly rather than implying it is free.
  assert.equal(decide("manual", "safe"), "ask");
  assert.equal(decide("guarded", "safe"), "auto");
  assert.equal(decide("yolo", "safe"), "auto");

  assert.equal(decide("manual", "write"), "ask");
  assert.equal(decide("guarded", "write"), "auto");
  assert.equal(decide("yolo", "write"), "auto");

  // And the floor holds regardless of mode, including "never ask".
  for (const risk of FLOOR_CLASSES) {
    for (const mode of PERMISSION_MODES) assert.equal(decide(mode, risk), "ask", `${risk} in ${mode}`);
  }
});
