/**
 * The agent loop, against a stub endpoint.
 *
 * These assert the properties that make the loop safe to hand a tool set:
 * an invented name cannot execute anything, a failing tool does not kill the
 * turn, and a model that will not stop is stopped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTurn, parseArguments, DEFAULT_MAX_STEPS, type AgentEvent } from "../src/core/agent/loop.ts";
import { ToolRegistry, type ToolDef } from "../src/core/agent/registry.ts";

/** A stub chat endpoint that replies with a scripted sequence. */
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
      const reply = replies[Math.min(turn++, replies.length - 1)];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
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

function says(text: string) {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}

function calls(name: string, args: unknown, id = "c1") {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function echoTool(calls: { params: Record<string, unknown> }[]): ToolDef {
  return {
    name: "echo",
    description: "echo",
    risk: "safe",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: async (params) => {
      calls.push({ params });
      return { content: `echoed: ${String(params["text"])}` };
    },
  };
}

test("a tool call runs and its result comes back to the model", async () => {
  const seen: { params: Record<string, unknown> }[] = [];
  const registry = new ToolRegistry();
  registry.register(echoTool(seen));

  await withServer([calls("echo", { text: "hi" }), says("It said hi.")], async (endpoint, requests) => {
    const result = await runTurn({
      registry,
      endpoint,
      messages: [{ role: "user", content: "use echo" }],
    });

    assert.equal(result.text, "It said hi.");
    assert.deepEqual(seen, [{ params: { text: "hi" } }]);
    assert.equal(result.steps, 1);
    assert.equal(result.exhausted, false);

    // The tool result must reach the model as a `tool` message tied to the call.
    const second = requests[1] as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "no tool message was sent back");
    assert.equal(toolMsg.tool_call_id, "c1");
    assert.equal(toolMsg.content, "echoed: hi");
  });
});

test("the tool schemas are offered, and an empty set is omitted entirely", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool([]));
  await withServer([says("done")], async (endpoint, requests) => {
    await runTurn({ registry, endpoint, messages: [{ role: "user", content: "hi" }] });
    const req = requests[0] as { tools?: { function: { name: string } }[] };
    assert.deepEqual(req.tools?.map((t) => t.function.name), ["echo"]);
  });

  await withServer([says("done")], async (endpoint, requests) => {
    await runTurn({ registry: new ToolRegistry(), endpoint, messages: [{ role: "user", content: "hi" }] });
    const req = requests[0] as { tools?: unknown; tool_choice?: unknown };
    // Some OpenAI-compatible servers reject `tools: []` rather than reading it
    // as "no tools", so the field must be absent, not empty.
    assert.equal("tools" in req, false, "an empty tool list must not be sent");
    assert.equal("tool_choice" in req, false);
  });
});

test("a tool name the model invented comes back as a result, not a crash", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool([]));

  await withServer(
    [calls("bash", { command: "rm -rf /" }), says("I cannot do that.")],
    async (endpoint, requests) => {
      const result = await runTurn({
        registry,
        endpoint,
        messages: [{ role: "user", content: "delete everything" }],
      });
      assert.equal(result.text, "I cannot do that.");

      const second = requests[1] as { messages: { role: string; content: string }[] };
      const toolMsg = second.messages.find((m) => m.role === "tool");
      assert.match(toolMsg!.content, /no tool named "bash"/);
      // The reply names what IS available, because that is what lets the model
      // recover on the next step instead of guessing again.
      assert.match(toolMsg!.content, /echo/);
    },
  );
});

test("a tool that throws does not end the turn", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "broken",
    description: "always fails",
    risk: "safe",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("the endpoint refused the connection");
    },
  });

  await withServer([calls("broken", {}), says("That tool is down.")], async (endpoint, requests) => {
    const result = await runTurn({ registry, endpoint, messages: [{ role: "user", content: "go" }] });
    assert.equal(result.text, "That tool is down.");
    const second = requests[1] as { messages: { role: string; content: string }[] };
    assert.match(second.messages.find((m) => m.role === "tool")!.content, /refused the connection/);
  });
});

test("malformed arguments are handed back rather than thrown", () => {
  assert.deepEqual(parseArguments(""), { ok: true, value: {} });
  assert.deepEqual(parseArguments('{"a":1}'), { ok: true, value: { a: 1 } });
  // A model that writes a trailing comma can fix it on the next step; failing
  // the whole turn would throw away everything it had already done.
  assert.equal(parseArguments('{"a":1,}').ok, false);
  assert.equal(parseArguments("[1,2]").ok, false, "a bare array is not a parameter object");
  assert.equal(parseArguments("null").ok, false);
});

test("a model that will not stop is stopped, and told so", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool([]));

  // Always replies with another tool call: the loop must end this itself.
  await withServer([calls("echo", { text: "again" })], async (endpoint) => {
    const result = await runTurn({
      registry,
      endpoint,
      messages: [{ role: "user", content: "loop forever" }],
      maxSteps: 3,
    });
    assert.equal(result.exhausted, true);
    assert.equal(result.steps, 4, "one step past the budget is what ends it");
    const last = result.messages.at(-1)!;
    assert.equal(last.role, "tool");
    assert.match(last.content, /limit of 3 tool steps/);
  });
});

test("the default step budget is finite", () => {
  assert.ok(DEFAULT_MAX_STEPS > 0 && DEFAULT_MAX_STEPS <= 50);
});

/**
 * `onEvent` is what wires `chat()`'s `onDelta`, which switches it from
 * reading a whole JSON body (what `withServer` above serves) to the real
 * SSE frame-by-frame reader -- so a test that passes `onEvent` needs an
 * actual `text/event-stream` server, not `withServer`'s plain JSON.
 */
async function withSseServer<T>(
  turns: string[][],
  body: (endpoint: { baseUrl: string; envVar: string; timeoutMs: number }) => Promise<T>,
): Promise<T> {
  let turn = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of turns[Math.min(turn++, turns.length - 1)] ?? []) res.write(frame);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    return await body({ baseUrl: `http://127.0.0.1:${port}/v1`, envVar: "K", timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function sseCallsTurn(name: string, args: unknown, id = "c1"): string[] {
  return [
    sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    sseFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ];
}

function sseSaysTurn(text: string): string[] {
  return [
    sseFrame({ choices: [{ delta: { content: text } }] }),
    sseFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ];
}

test("a tool's ToolResult.detail rides the tool_end event, for the UI rather than the model", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "draw",
    description: "draw",
    risk: "safe",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ content: "Drew it.", detail: { id: "diagram-1" } }),
  });
  const events: AgentEvent[] = [];

  await withSseServer([sseCallsTurn("draw", {}), sseSaysTurn("done")], async (endpoint) => {
    await runTurn({
      registry, endpoint,
      messages: [{ role: "user", content: "draw something" }],
      onEvent: (e) => events.push(e),
    });
  });

  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.deepEqual(toolEnd?.detail, { id: "diagram-1" });
  // The model-facing text is untouched by detail's presence.
  assert.equal(toolEnd?.result, "Drew it.");
});

test("a tool with no detail leaves tool_end's detail unset, not present-and-undefined", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool([]));
  const events: AgentEvent[] = [];

  await withSseServer([sseCallsTurn("echo", { text: "hi" }), sseSaysTurn("done")], async (endpoint) => {
    await runTurn({
      registry, endpoint,
      messages: [{ role: "user", content: "use echo" }],
      onEvent: (e) => events.push(e),
    });
  });

  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.equal("detail" in (toolEnd ?? {}), false);
});

test("usage is summed across every step of the turn", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool([]));
  const withUsage = (reply: Record<string, unknown>) => ({
    ...reply,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  await withServer(
    [withUsage(calls("echo", { text: "x" })), withUsage(says("done"))],
    async (endpoint) => {
      const result = await runTurn({ registry, endpoint, messages: [{ role: "user", content: "go" }] });
      assert.deepEqual(result.usage, { input: 20, output: 10, total: 30 });
    },
  );
});
