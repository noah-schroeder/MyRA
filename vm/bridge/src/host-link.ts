/**
 * The VM's outbound link to the host app.
 *
 * The VM always dials the host, never the reverse: under QEMU SLIRP user
 * networking the guest can reach the host at 10.0.2.2, but the host cannot
 * reach the guest without hostfwd. Dialling outward means the whole system
 * works with zero hypervisor reconfiguration.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { HelloAck, HelloPayload, KarenFrame } from "@karen/protocol";
import { PROTOCOL_VERSION } from "@karen/protocol";
import { log } from "./logger.ts";

export interface HostLinkOptions {
  url: string;
  token: string;
  bridgeVersion: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  onFrame: (frame: KarenFrame) => void;
  onConnected: (ack: HelloAck) => void;
  onDisconnected: () => void;
  /** Another bridge owns the link; this one should shut down. */
  onSuperseded?: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 60_000;

export class HostLink {
  #ws: WebSocket | undefined;
  #pending = new Map<string, Pending>();
  #attempt = 0;
  #closed = false;
  #reconnectTimer: NodeJS.Timeout | undefined;
  readonly #opts: HostLinkOptions;

  constructor(opts: HostLinkOptions) {
    this.#opts = opts;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.#closed) return;
    const ws = new WebSocket(this.#opts.url, { handshakeTimeout: 10_000 });
    this.#ws = ws;

    ws.on("open", () => {
      log.info("host link open", { url: this.#opts.url });
      const hello: HelloPayload = {
        protocolVersion: PROTOCOL_VERSION,
        token: this.#opts.token,
        bridgeVersion: this.#opts.bridgeVersion,
      };
      ws.send(JSON.stringify({ ch: "ctl", id: "hello", op: "hello", args: hello }));
    });

    ws.on("message", (data) => this.#onMessage(data));

    ws.on("close", (code, reason) => {
      const why = reason.toString();
      log.warn("host link closed", { code, reason: why });
      this.#failAllPending(new Error("host link closed"));
      this.#opts.onDisconnected();

      /*
       * Stand down rather than fight over the link.
       *
       * The app keeps one bridge connection and closes the previous one as
       * "superseded" when a new one arrives. Two bridges therefore displace
       * each other forever: each reconnects, supersedes the other, and is
       * superseded in turn. Observed at roughly a thousand reconnects a
       * second -- it saturates the app's event loop until it stops answering
       * its sockets at all, and writes a log measured in hundreds of megabytes.
       *
       * Being superseded is not a failure to retry. It means another bridge is
       * already serving this app, and the right response is to leave it to it.
       */
      if (why === "superseded") {
        log.warn("another karen-bridge is already connected; stopping this one");
        this.#closed = true;
        this.#opts.onSuperseded?.();
        return;
      }

      this.#scheduleReconnect();
    });

    ws.on("error", (err) => {
      // A refused connection simply means the app is not running yet; that is
      // an ordinary state, not an error worth shouting about.
      log.debug("host link error", { err: String(err) });
    });
  }

  #onMessage(data: WebSocket.RawData): void {
    let frame: KarenFrame;
    try {
      frame = JSON.parse(data.toString()) as KarenFrame;
    } catch {
      log.warn("dropping unparseable frame from host");
      return;
    }

    // The handshake ack arrives on the reserved "hello" id.
    if (frame.ch === "ctl" && "ok" in frame && frame.id === "hello") {
      if (frame.ok) {
        this.#attempt = 0;
        this.#opts.onConnected(frame.result as HelloAck);
      } else {
        log.error("handshake rejected", { error: frame.error });
        this.#ws?.close();
      }
      return;
    }

    if (this.#settlePending(frame)) return;
    this.#opts.onFrame(frame);
  }

  #settlePending(frame: KarenFrame): boolean {
    const id = (frame as { id?: string }).id;
    if (typeof id !== "string") return false;
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const f = frame as { ok?: boolean; result?: unknown; error?: string };
    if (f.ok === false) pending.reject(new Error(f.error ?? "host rejected the request"));
    else pending.resolve(f.result);
    return true;
  }

  #failAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  send(frame: KarenFrame): void {
    if (!this.connected) {
      log.debug("dropping frame; host link down", { ch: frame.ch });
      return;
    }
    this.#ws!.send(JSON.stringify(frame));
  }

  /** Send a frame carrying an `id` and await the host's correlated reply. */
  request<T = unknown>(build: (id: string) => KarenFrame, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("host link is down"));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`host request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#ws!.send(JSON.stringify(build(id)));
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    const { reconnectMinMs, reconnectMaxMs } = this.#opts;
    const backoff = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.#attempt);
    // Jitter avoids a thundering herd if several components retry together.
    const delay = Math.round(backoff * (0.5 + Math.random() * 0.5));
    this.#attempt = Math.min(this.#attempt + 1, 10);
    log.debug("reconnecting", { delay });
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
    this.#reconnectTimer.unref();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#failAllPending(new Error("bridge shutting down"));
    this.#ws?.close();
  }
}
