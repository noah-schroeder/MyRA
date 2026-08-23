/**
 * The host end of the VM link.
 *
 * The host listens and the VM dials in, because under QEMU SLIRP the guest can
 * reach the host at 10.0.2.2 but the host cannot reach the guest without
 * hostfwd. Binding to loopback keeps the socket off every network interface;
 * SLIRP still forwards the guest's connection to it.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ActionRequestFrame,
  HelloAck,
  HelloPayload,
  KarenFrame,
  PiFrame,
  PiOutbound,
} from "@karen/protocol";
import { PROTOCOL_VERSION } from "@karen/protocol";

export interface BridgeServerOptions {
  port: number;
  /** Resolved fresh per connection so a rotated token takes effect at once. */
  getToken: () => Promise<string>;
  getAck: () => Promise<HelloAck>;
  getSecrets: () => Promise<Record<string, string>>;
  onRpcFrame: (frame: PiFrame) => void;
  onAction: (frame: ActionRequestFrame) => Promise<unknown>;
  onStatusChange: (connected: boolean) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare a fixed-size digest surrogate: unequal lengths would otherwise
  // short-circuit and leak length through timing.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class BridgeServer {
  #wss: WebSocketServer | undefined;
  #socket: WebSocket | undefined;
  #authenticated = false;
  #pending = new Map<string, Pending>();
  readonly #opts: BridgeServerOptions;

  constructor(opts: BridgeServerOptions) {
    this.#opts = opts;
  }

  get connected(): boolean {
    return this.#authenticated && this.#socket?.readyState === 1;
  }

  async start(): Promise<void> {
    await this.stop();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: this.#opts.port });
    this.#wss = wss;
    wss.on("connection", (ws) => this.#onConnection(ws));
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
  }

  #onConnection(ws: WebSocket): void {
    // One bridge at a time; a new one supersedes the old.
    if (this.#socket && this.#socket.readyState === 1) this.#socket.close(1000, "superseded");
    this.#socket = ws;
    this.#authenticated = false;

    // Drop a connection that never authenticates.
    const authTimer = setTimeout(() => {
      if (!this.#authenticated) ws.close(1008, "handshake timeout");
    }, 10_000);

    ws.on("message", (raw) => void this.#onMessage(ws, raw.toString()));

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (this.#socket === ws) {
        this.#socket = undefined;
        this.#authenticated = false;
        this.#failAllPending(new Error("bridge disconnected"));
        this.#opts.onStatusChange(false);
      }
    });

    ws.on("error", () => undefined);
  }

  async #onMessage(ws: WebSocket, text: string): Promise<void> {
    let frame: KarenFrame;
    try {
      frame = JSON.parse(text) as KarenFrame;
    } catch {
      return; // Malformed input must never take the app down.
    }

    // Handshake first: nothing else is honoured until it succeeds.
    if (!this.#authenticated) {
      if (frame.ch === "ctl" && "op" in frame && frame.op === "hello") {
        await this.#handleHello(ws, frame.args as unknown as HelloPayload);
      } else {
        ws.close(1008, "expected hello");
      }
      return;
    }

    switch (frame.ch) {
      case "rpc":
        this.#opts.onRpcFrame(frame.payload as PiFrame);
        break;

      case "action":
        if ("verb" in frame) await this.#handleAction(ws, frame);
        break;

      case "ctl":
        if ("op" in frame) await this.#handleCtl(ws, frame.id, frame.op);
        else this.#settlePending(frame);
        break;
    }
  }

  async #handleHello(ws: WebSocket, hello: HelloPayload | undefined): Promise<void> {
    const fail = (error: string): void => {
      ws.send(JSON.stringify({ ch: "ctl", id: "hello", ok: false, error }));
      ws.close(1008, error);
    };

    if (!hello || typeof hello.token !== "string") return fail("malformed hello");
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      return fail(`protocol mismatch: host ${PROTOCOL_VERSION}, bridge ${hello.protocolVersion}`);
    }

    const expected = await this.#opts.getToken();
    if (!expected || !safeEqual(hello.token, expected)) return fail("bad token");

    this.#authenticated = true;
    const ack = await this.#opts.getAck();
    ws.send(JSON.stringify({ ch: "ctl", id: "hello", ok: true, result: ack }));
    this.#opts.onStatusChange(true);
  }

  async #handleAction(ws: WebSocket, frame: ActionRequestFrame): Promise<void> {
    try {
      const result = await this.#opts.onAction(frame);
      ws.send(JSON.stringify({ ch: "action", id: frame.id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ ch: "action", id: frame.id, ok: false, error: (err as Error).message }));
    }
  }

  async #handleCtl(ws: WebSocket, id: string, op: string): Promise<void> {
    if (op === "secrets") {
      const env = await this.#opts.getSecrets();
      ws.send(JSON.stringify({ ch: "ctl", id, ok: true, result: { env } }));
      return;
    }
    ws.send(JSON.stringify({ ch: "ctl", id, ok: false, error: `unsupported op: ${op}` }));
  }

  #settlePending(frame: KarenFrame): void {
    const id = (frame as { id?: string }).id;
    if (typeof id !== "string") return;
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    const f = frame as { ok?: boolean; result?: unknown; error?: string };
    if (f.ok === false) p.reject(new Error(f.error ?? "bridge rejected the request"));
    else p.resolve(f.result);
  }

  #failAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  /** Forward a command to pi. */
  sendRpc(payload: PiOutbound): void {
    if (!this.connected) return;
    this.#socket!.send(JSON.stringify({ ch: "rpc", payload }));
  }

  /** Ask the bridge to do something and await its reply. */
  ctl<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("the VM bridge is not connected"));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`bridge request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#socket!.send(JSON.stringify({ ch: "ctl", id, op, ...(args ? { args } : {}) }));
    });
  }

  async stop(): Promise<void> {
    this.#failAllPending(new Error("server stopping"));
    this.#socket?.close();
    const wss = this.#wss;
    this.#wss = undefined;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }
}
