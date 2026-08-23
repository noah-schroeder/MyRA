/**
 * End-to-end proof of the Phase 0 pipe:
 *   fake host  <-- WebSocket --  karen-bridge  -- stdio JSONL -->  real pi
 *
 * Exercises the handshake, secret delivery, pi spawn, and bidirectional JSONL
 * relay against an actual `pi --mode rpc` child, not a mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

const TOKEN = "test-token-do-not-use";

interface Harness {
  wss: WebSocketServer;
  bridge: ChildProcess;
  socket: Promise<WebSocket>;
  port: number;
  logFile: string;
  cleanup: () => Promise<void>;
}

interface HarnessOptions {
  /** Seed ~/.pi/agent/models.json before the bridge (and therefore pi) starts. */
  models?: unknown;
  /** Extension source dropped into the test HOME before pi starts. */
  extension?: { name: string; source: string };
}

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "karen-test-"));
  const configDir = join(dir, "config");
  const workspace = join(dir, "workspace");
  const sessions = join(dir, "sessions");
  await mkdir(configDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(join(configDir, "token"), TOKEN, { mode: 0o600 });

  // The bridge and pi both resolve ~/.pi from HOME, so give the test its own.
  // Without this a models.json test would overwrite the user's real catalogue.
  const home = join(dir, "home");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  if (opts.models) {
    await writeFile(join(home, ".pi", "agent", "models.json"), JSON.stringify(opts.models, null, 2));
  }
  if (opts.extension) {
    const dir = join(home, ".pi", "agent", "extensions", opts.extension.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), opts.extension.source);
  }

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;

  await writeFile(
    join(configDir, "bridge.json"),
    JSON.stringify({
      hostUrl: `ws://127.0.0.1:${port}`,
      workspaceRoot: workspace,
      sessionDir: sessions,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    }),
  );

  // Answer the handshake and the secrets request the way the real host would.
  const socket = new Promise<WebSocket>((resolve) => {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.ch === "ctl" && frame.op === "hello") {
          assert.equal(frame.args.token, TOKEN, "bridge must present the shared token");
          ws.send(JSON.stringify({
            ch: "ctl", id: "hello", ok: true,
            result: { protocolVersion: 1, mode: "guarded", workspaceRoot: workspace },
          }));
          return;
        }
        if (frame.ch === "ctl" && frame.op === "secrets") {
          // pi silently drops any provider whose apiKey env var is unset, so a
          // key must be supplied or every model test sees an empty catalogue.
          ws.send(JSON.stringify({
            ch: "ctl", id: frame.id, ok: true,
            result: { env: { KAREN_LLM_KEY: "test-key-never-sent-anywhere" } },
          }));
          resolve(ws);
        }
      });
    });
  });

  const bridge = spawn(process.execPath, ["src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, KAREN_CONFIG_DIR: configDir, KAREN_LOG_LEVEL: process.env["KAREN_TEST_LOG"] ?? "error",
           XDG_RUNTIME_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Always drain the child's pipes. An undrained pipe fills at 64KB and blocks
  // the bridge mid-write, which looks exactly like a hang.
  const logFile = join(dir, "bridge.log");
  const sink = (c: Buffer) => {
    appendFileSync(logFile, c);
    if (process.env["KAREN_TEST_ECHO"]) process.stderr.write(`[bridge] ${c}`);
  };
  bridge.stdout?.on("data", sink);
  bridge.stderr?.on("data", sink);

  return {
    wss, bridge, socket, port,
    logFile,
    cleanup: async () => {
      bridge.kill("SIGKILL");
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

/** Wait for a frame from the bridge matching a predicate. */
function waitFor(ws: WebSocket, match: (f: any) => boolean, ms = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), ms);
    const onMsg = (raw: any) => {
      const frame = JSON.parse(raw.toString());
      if (match(frame)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(frame);
      }
    };
    ws.on("message", onMsg);
  });
}

test("bridge dials the host, authenticates, spawns pi, and relays RPC", async (t) => {
  const h = await startHarness();
  t.after(() => h.cleanup());

  const ws = await h.socket;

  // Round-trip a real RPC command through the bridge into pi and back.
  ws.send(JSON.stringify({ ch: "rpc", payload: { id: "probe-1", type: "get_state" } }));

  const reply = await waitFor(
    ws,
    (f) => f.ch === "rpc" && f.payload?.type === "response" && f.payload?.id === "probe-1",
  );

  assert.equal(reply.payload.command, "get_state");
  assert.equal(reply.payload.success, true);
  assert.ok(reply.payload.data.sessionId, "pi should report a session id");
});

test("bridge rejects nothing it cannot parse and stays alive", async (t) => {
  const h = await startHarness();
  t.after(() => h.cleanup());
  const ws = await h.socket;

  ws.send("this is not json");
  ws.send(JSON.stringify({ ch: "nonsense" }));
  ws.send(JSON.stringify({ ch: "rpc", payload: { id: "probe-2", type: "get_state" } }));

  const reply = await waitFor(ws, (f) => f.ch === "rpc" && f.payload?.id === "probe-2");
  assert.equal(reply.payload.success, true, "bridge survived malformed input");
});

/* ------------------------------------------------------------------ *
 * Model catalogue                                                     *
 * ------------------------------------------------------------------ */

/** Build a models.json with the given ids, in the shape the GUI writes. */
function catalogue(ids: string[]) {
  return {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:9/v1", // never contacted; --offline
        api: "openai-completions",
        apiKey: "$KAREN_LLM_KEY",
        models: ids.map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 32000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };
}

/** Issue a ctl op and wait for its reply. */
async function ctl(ws: WebSocket, op: string, args?: unknown): Promise<any> {
  const id = `ctl-${Math.random().toString(36).slice(2)}`;
  const reply = waitFor(ws, (f) => f.ch === "ctl" && f.id === id);
  ws.send(JSON.stringify({ ch: "ctl", id, op, ...(args ? { args } : {}) }));
  return reply;
}

/**
 * The bug this pins: pi caches models.json at spawn and never re-reads it.
 *
 * Its docs say the file "reloads each time you open /model" -- but that is the
 * TUI picker, which does not exist in RPC mode. Asking pi what models exist
 * therefore returned the catalogue from spawn time, so the dropdown showed a
 * model the user had never selected. get_models must read the file instead.
 */
test("get_models reports the file, not the catalogue pi cached at spawn", async (t) => {
  const h = await startHarness({ models: catalogue(["alpha/one"]) });
  t.after(() => h.cleanup());
  const ws = await h.socket;

  const before = await ctl(ws, "get_models");
  assert.deepEqual(before.result.models.map((m: any) => m.id), ["alpha/one"]);

  // Exactly what Settings does when the user ticks two more models.
  const written = await ctl(ws, "write_models", { config: catalogue(["alpha/one", "beta/two", "gamma/three"]) });
  assert.equal(written.ok, true);

  const after = await ctl(ws, "get_models");
  assert.deepEqual(
    after.result.models.map((m: any) => m.id).sort(),
    ["alpha/one", "beta/two", "gamma/three"],
    "the dropdown must reflect the file the user just saved",
  );
  assert.equal(after.result.piInSync, true, "pi should have been respawned onto the new catalogue");
});

/**
 * The second half: pi must actually be respawned, not merely reported around.
 * set_model against a model added after pi started fails with "Model not found"
 * unless the bridge respawned it -- so this is the load-bearing assertion.
 */
test("a model added after pi started can be selected", async (t) => {
  const h = await startHarness({ models: catalogue(["alpha/one"]) });
  t.after(() => h.cleanup());
  const ws = await h.socket;

  await ctl(ws, "get_models");
  await ctl(ws, "write_models", { config: catalogue(["alpha/one", "beta/two"]) });

  ws.send(JSON.stringify({
    ch: "rpc",
    payload: { id: "switch-1", type: "set_model", provider: "local", modelId: "beta/two" },
  }));
  const reply = await waitFor(ws, (f) => f.ch === "rpc" && f.payload?.id === "switch-1");

  assert.equal(reply.payload.success, true, `set_model failed: ${reply.payload.error}`);
  assert.equal(reply.payload.data.id, "beta/two");
});

/** Editing which models are AVAILABLE must not change which one is ACTIVE. */
test("the active model survives a catalogue edit", async (t) => {
  const h = await startHarness({ models: catalogue(["alpha/one", "beta/two"]) });
  t.after(() => h.cleanup());
  const ws = await h.socket;

  ws.send(JSON.stringify({
    ch: "rpc",
    payload: { id: "switch-2", type: "set_model", provider: "local", modelId: "beta/two" },
  }));
  await waitFor(ws, (f) => f.ch === "rpc" && f.payload?.id === "switch-2");

  // Add a third model. pi respawns, and would otherwise default to the first.
  await ctl(ws, "write_models", { config: catalogue(["alpha/one", "beta/two", "gamma/three"]) });

  const state = await ctl(ws, "get_state");
  assert.equal(state.result.model.id, "beta/two", "the user's active model must be restored");
});

/**
 * A blocking UI dialog must reach the host and its answer must reach back.
 *
 * This is the exact shape of a real failure: the research pipeline asked a
 * scoping question, the request left pi, and nothing on the host answered it —
 * so the extension sat inside `pi.ui.input()` forever with no error anywhere.
 * A dialog frame that goes unanswered is not a missing feature, it is a hung
 * agent, so the round trip is worth pinning down.
 */
test("a blocking UI dialog completes its round trip through the host", async () => {
  const harness = await startHarness({
    extension: {
      name: "dialog-probe",
      source: `
        export default function (pi) {
          pi.registerCommand("probe", {
            description: "ask one question",
            handler: async (_args, ctx) => {
              const answer = await ctx.ui.input("What timeframe?", "e.g. since 2020");
              ctx.ui.notify("got: " + String(answer));
            },
          });
        }
      `,
    },
  });
  try {
    const ws = await harness.socket;

    // Drive the command the way the app does: a prompt beginning with "/".
    ws.send(JSON.stringify({ ch: "rpc", payload: { type: "prompt", message: "/probe" } }));

    const request = await waitFor(
      ws,
      (f) => f.ch === "rpc" && f.payload?.type === "extension_ui_request" && f.payload?.method === "input",
      45_000,
    );
    assert.equal(request.payload.title, "What timeframe?");
    assert.ok(request.payload.id, "the request must carry an id to answer on");

    // Answer exactly as the renderer's UiDialog does.
    ws.send(JSON.stringify({
      ch: "rpc",
      payload: { type: "extension_ui_response", id: request.payload.id, value: "since 2015" },
    }));

    // The extension only reaches notify() if the answer actually unblocked it.
    const notified = await waitFor(
      ws,
      (f) => f.ch === "rpc" && f.payload?.type === "extension_ui_request" && f.payload?.method === "notify",
      30_000,
    );
    assert.match(String(notified.payload.message), /since 2015/);
  } finally {
    await harness.cleanup();
  }
});
