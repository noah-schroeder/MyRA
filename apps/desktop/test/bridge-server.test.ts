/**
 * Tests the host end of the link. BridgeServer deliberately imports nothing from
 * Electron, so it can be exercised directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { BridgeServer } from "../src/main/bridge-server.ts";

const TOKEN = "correct-horse-battery-staple";

async function withServer(
  overrides: Partial<Parameters<typeof makeOpts>[0]> = {},
  fn: (port: number, server: BridgeServer, seen: any[]) => Promise<void>,
): Promise<void> {
  const port = 19000 + Math.floor(Math.random() * 3000);
  const seen: any[] = [];
  const server = new BridgeServer(makeOpts({ port, seen, ...overrides }) as any);
  await server.start();
  try {
    await fn(port, server, seen);
  } finally {
    await server.stop();
  }
}

function makeOpts(o: any) {
  return {
    port: o.port,
    getToken: async () => TOKEN,
    getAck: async () => ({ protocolVersion: 1, mode: "guarded", workspaceRoot: "/ws" }),
    getSecrets: async () => ({ KAREN_LLM_KEY: "secret-value" }),
    onRpcFrame: (f: any) => o.seen.push({ kind: "rpc", f }),
    onAction: o.onAction ?? (async () => ({ ok: true })),
    onStatusChange: (c: boolean) => o.seen.push({ kind: "status", c }),
  };
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

function nextMsg(ws: WebSocket, timeout = 5000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), timeout);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
  });
}

test("accepts a bridge presenting the correct token", async () => {
  await withServer({}, async (port, server) => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
      args: { protocolVersion: 1, token: TOKEN, bridgeVersion: "test" } }));
    const ack = await nextMsg(ws);
    assert.equal(ack.ok, true);
    assert.equal(ack.result.mode, "guarded");
    assert.equal(server.connected, true);
    ws.close();
  });
});

test("rejects a bad token and closes the connection", async () => {
  await withServer({}, async (port, server) => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
      args: { protocolVersion: 1, token: "wrong", bridgeVersion: "test" } }));
    const res = await nextMsg(ws);
    assert.equal(res.ok, false);
    assert.match(res.error, /bad token/);
    assert.equal(server.connected, false);
  });
});

test("rejects a protocol version mismatch", async () => {
  await withServer({}, async (port) => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
      args: { protocolVersion: 999, token: TOKEN, bridgeVersion: "test" } }));
    const res = await nextMsg(ws);
    assert.equal(res.ok, false);
    assert.match(res.error, /protocol mismatch/);
  });
});

test("refuses to act on anything before the handshake", async () => {
  await withServer({}, async (port, _server, seen) => {
    const ws = await connect(port);
    // Try to jump straight to an action without authenticating.
    ws.send(JSON.stringify({ ch: "action", id: "a1", verb: "notify", args: {} }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.filter((s) => s.kind === "rpc").length, 0);
    assert.equal(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING, true);
  });
});

test("delivers secrets only after authentication", async () => {
  await withServer({}, async (port) => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
      args: { protocolVersion: 1, token: TOKEN, bridgeVersion: "test" } }));
    await nextMsg(ws); // ack
    ws.send(JSON.stringify({ ch: "ctl", id: "s1", op: "secrets" }));
    const secrets = await nextMsg(ws);
    assert.equal(secrets.ok, true);
    assert.equal(secrets.result.env.KAREN_LLM_KEY, "secret-value");
    ws.close();
  });
});

test("routes an action to the broker and returns its result", async () => {
  const calls: any[] = [];
  await withServer(
    { onAction: async (f: any) => { calls.push(f); return { notified: true }; } },
    async (port) => {
      const ws = await connect(port);
      ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
        args: { protocolVersion: 1, token: TOKEN, bridgeVersion: "test" } }));
      await nextMsg(ws);
      ws.send(JSON.stringify({ ch: "action", id: "a1", verb: "notify", args: { title: "hi" } }));
      const res = await nextMsg(ws);
      assert.equal(res.ok, true);
      assert.deepEqual(res.result, { notified: true });
      assert.equal(calls[0].verb, "notify");
      ws.close();
    },
  );
});

test("surfaces a broker refusal as an error, not a crash", async () => {
  await withServer(
    { onAction: async () => { throw new Error("denied by user: planify.propose"); } },
    async (port) => {
      const ws = await connect(port);
      ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello",
        args: { protocolVersion: 1, token: TOKEN, bridgeVersion: "test" } }));
      await nextMsg(ws);
      ws.send(JSON.stringify({ ch: "action", id: "a2", verb: "planify.propose", args: {} }));
      const res = await nextMsg(ws);
      assert.equal(res.ok, false);
      assert.match(res.error, /denied by user/);
      ws.close();
    },
  );
});

/* ---- the app's own outbound calls ---- */

test("the app's own fetches are decided by the allowlist, not exempt from it", async () => {
  // The gap this closes: the egress filter hooks session.webRequest, which only
  // sees Chromium's stack. Verified empirically -- with the filter cancelling
  // every request, a main-process fetch still returned 200 and was never seen.
  const { EgressFilter } = await import("../src/main/egress.ts");
  const { appFetch, useEgressFilter, EgressBlocked } = await import("../src/main/appFetch.ts");

  const filter = new EgressFilter({ allowLoopback: false });
  filter.setAllowedEndpoints(["https://whisper.example.com/v1"]);
  useEgressFilter(filter);

  await assert.rejects(() => appFetch("https://telemetry.example.com/collect"), EgressBlocked);
  await assert.rejects(() => appFetch("http://169.254.169.254/latest/meta-data/"), EgressBlocked);

  // And a blocked call is in the activity log, which is what makes the panel
  // able to claim it shows everything.
  const log = filter.activity;
  assert.equal(log.length, 2);
  assert.ok(log.every((entry) => !entry.allowed));
  assert.ok(log.every((entry) => entry.reason.startsWith("app:")));
});

test("with no filter installed, nothing goes out", async () => {
  const { appFetch, EgressBlocked } = await import("../src/main/appFetch.ts");
  const fresh = await import(`../src/main/appFetch.ts?fresh=${Date.now()}`);
  // A startup path that forgot to install a filter must fail loudly rather than
  // quietly making unfiltered requests.
  await assert.rejects(() => fresh.appFetch("https://anywhere.example.com"), fresh.EgressBlocked);
  void appFetch;
  void EgressBlocked;
});
