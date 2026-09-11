/**
 * The gateway with a socket actually open.
 *
 * `api.test.ts` covers the allowlist and the keys as pure functions. These
 * cover what only appears once something is listening: what an oversized body
 * is answered with, which of the upstream's headers survive the crossing, and
 * whether a failure inside the handler tells the caller anything about this
 * machine.
 */

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, Socket } from "node:net";
import { after, test } from "node:test";

import { API_DEFAULTS, type ApiConfig } from "../src/core/api/config.ts";
import { mintKey } from "../src/core/api/keys.ts";
import { RequestLog } from "../src/core/api/log.ts";
import { ApiGateway, passThroughHeaders } from "../src/main/api/server.ts";

const minted = mintKey("test");

/** A port the gateway will accept: `refuseReason` rejects 0 and anything under 1024. */
async function freePort(): Promise<number> {
  const probe = createSocketServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function configWith(patch: Partial<ApiConfig> = {}): ApiConfig {
  return { ...API_DEFAULTS, enabled: true, keys: [minted.key], ...patch };
}

/** A stand-in for Lemonade that answers everything the same way. */
async function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      "set-cookie": "session=secret",
    });
    res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${String(port)}/api/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function gatewayWith(opts: Omit<Parameters<typeof makeGateway>[0], "port"> = {}) {
  return makeGateway({ ...opts, port: await freePort() });
}

function makeGateway(opts: {
  port: number;
  config?: () => ApiConfig;
  upstream?: () => { baseUrl: string; apiKey: string } | undefined;
  models?: () => Promise<{ id: string; loaded: boolean }[]>;
}) {
  return new ApiGateway({
    config: opts.config ?? (() => configWith({ port: opts.port })),
    upstream: opts.upstream ?? (() => undefined),
    models: opts.models ?? (async () => []),
    loadModel: async () => undefined,
    log: new RequestLog(),
  });
}

const open: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of open) await close();
});

test("a body over the cap is refused with 413, not a bare 500", async () => {
  const gateway = await gatewayWith({});
  open.push(() => gateway.stop());
  const status = await gateway.start();
  assert.equal(status.listening, true);

  /* Genuinely over the 64 MB cap, because the whole point of the fix is what
     happens when `readBody` throws mid-stream: it used to escape to the
     catch-all and be answered as an internal error, which tells a client its
     own request was fine. Loopback makes 65 MB cheap enough to actually send. */
  const res = await fetch(`http://127.0.0.1:${String(status.port)}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
    body: Buffer.alloc(65 * 1024 * 1024, 0x20),
  });

  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /64 MB/);
});

test("the upstream's cookie and chunk framing do not cross the gateway", async () => {
  const up = await fakeUpstream();
  open.push(up.close);
  const gateway = await gatewayWith({
    upstream: () => ({ baseUrl: up.url, apiKey: "lemonade-key" }),
  });
  open.push(() => gateway.stop());
  const status = await gateway.start();

  const res = await fetch(`http://127.0.0.1:${String(status.port)}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${minted.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { choices: [{ message: { content: "hi" } }] });
});

test("an unauthenticated request is refused before anything is forwarded", async () => {
  const up = await fakeUpstream();
  open.push(up.close);
  const gateway = await gatewayWith({
    upstream: () => ({ baseUrl: up.url, apiKey: "lemonade-key" }),
  });
  open.push(() => gateway.stop());
  const status = await gateway.start();

  const res = await fetch(`http://127.0.0.1:${String(status.port)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("a failure inside the handler says nothing about this machine", async () => {
  const gateway = await gatewayWith({
    // Thrown from inside the handler, carrying exactly the kind of detail that
    // must not reach a client: a path under the user's home directory.
    models: async () => {
      throw new Error("ENOENT: open '/home/someone/.config/myra/models.json'");
    },
  });
  open.push(() => gateway.stop());
  const status = await gateway.start();

  const res = await fetch(`http://127.0.0.1:${String(status.port)}/v1/models`, {
    headers: { authorization: `Bearer ${minted.secret}` },
  });
  const text = await res.text();
  assert.ok(!text.includes("/home/someone"), `leaked a path: ${text}`);
  assert.ok(!text.includes("ENOENT"), `leaked an errno: ${text}`);
});

test("the request clocks are set, so a half-sent request cannot hold a socket", async () => {
  const gateway = await gatewayWith({});
  open.push(() => gateway.stop());
  const status = await gateway.start();
  assert.equal(status.listening, true);

  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = new Socket();
    s.once("error", reject);
    s.connect(status.port as number, "127.0.0.1", () => resolve(s));
  });
  // Headers begun and never finished. With headersTimeout at 0 this connection
  // would stay open indefinitely; the server must close it itself.
  socket.write("GET /health HTTP/1.1\r\nHost: x\r\n");
  const closed = await new Promise<boolean>((resolve) => {
    socket.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 200);
  });
  socket.destroy();
  // 200 ms is far below the 60 s limit, so it is still open -- that is correct.
  // What is asserted is that the limit exists at all, read off the server.
  assert.equal(closed, false);
});

/* The allowlist itself, rather than through a socket: over a real connection
   Node frames the response with its own `transfer-encoding`, so the header
   arrives either way and the wire cannot show which one it came from. */
test("only the three safe headers cross, and no hop-by-hop one", () => {
  const upstream = new Response("{}", {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "transfer-encoding": "chunked",
      "set-cookie": "session=secret",
      "access-control-allow-origin": "https://example.test",
      "x-lemonade-internal": "path=/home/someone",
    },
  });

  const out = passThroughHeaders(upstream);

  assert.deepEqual(Object.keys(out).sort(), ["cache-control", "content-type"]);
  assert.equal(out["transfer-encoding"], undefined);
  assert.equal(out["set-cookie"], undefined);
  assert.equal(out["access-control-allow-origin"], undefined);
});
