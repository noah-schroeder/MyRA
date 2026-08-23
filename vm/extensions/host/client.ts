/**
 * The VM's end of the host action channel.
 *
 * Extensions run inside the pi process, whose stdout IS the RPC stream, so
 * anything written there would corrupt framing. Host actions therefore travel
 * out of band over a unix socket the bridge owns:
 *
 *   this client -> $XDG_RUNTIME_DIR/karen-bridge.sock -> bridge -> host broker
 *
 * This module grants no authority. Every request still meets the broker's verb
 * allowlist, its mode x risk policy, its path jail and its audit log. A verb
 * spelled wrong here is rejected there, not interpreted.
 */

import { connect } from "node:net";

/** The bridge is not running, or the socket has gone away. */
export class HostUnavailableError extends Error {
  override readonly name = "HostUnavailableError";
}

/** The broker refused, or the action failed on the host. */
export class HostActionError extends Error {
  override readonly name = "HostActionError";
}

export function actionSocketPath(): string {
  const runtime = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return `${runtime}/karen-bridge.sock`;
}

/*
 * No wall-clock deadline by default.
 *
 * Several of these verbs require the user to click Approve, and a person may
 * take a while to notice the dialog. A timeout here would cancel the request
 * while the prompt is still on screen, leaving the user approving something
 * that no longer has anywhere to return to. The caller's AbortSignal -- which
 * pi supplies, and which fires when the user stops the agent -- is the correct
 * way out.
 */
export interface HostActionOptions {
  signal?: AbortSignal;
  /** Milliseconds to wait for the socket itself to accept a connection. */
  connectTimeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 5_000;
let nextId = 1;

export async function hostAction<T = unknown>(
  verb: string,
  args: Record<string, unknown> = {},
  opts: HostActionOptions = {},
): Promise<T> {
  const path = actionSocketPath();
  const id = `x${nextId++}`;

  return new Promise<T>((resolve, reject) => {
    const socket = connect(path);
    let settled = false;
    // LF only. The project's framing rule is that records split on \n
    // and nothing else. Carriage returns, form feeds and U+2028 are DATA on
    // this stream, which is exactly why Node's readline cannot be used here.
    let buffer = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      fn();
    };

    const onAbort = () =>
      finish(() => reject(new HostActionError(`${verb} was cancelled`)));

    const cleanup = () => {
      clearTimeout(connectTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const connectTimer = setTimeout(
      () =>
        finish(() =>
          reject(new HostUnavailableError(`timed out connecting to the bridge at ${path}`)),
        ),
      opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );

    if (opts.signal?.aborted) {
      finish(() => reject(new HostActionError(`${verb} was cancelled`)));
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      socket.write(JSON.stringify({ id, verb, args }) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at === -1) return;
      const line = buffer.slice(0, at);
      let reply: { id?: string; ok?: boolean; result?: unknown; error?: string };
      try {
        reply = JSON.parse(line);
      } catch {
        finish(() => reject(new HostActionError("the bridge sent a malformed reply")));
        return;
      }
      // One request per connection, so a mismatched id means the channel is
      // confused; fail loudly rather than returning another call's answer.
      if (reply.id !== id) {
        finish(() => reject(new HostActionError("the bridge replied to a different request")));
        return;
      }
      if (reply.ok) finish(() => resolve(reply.result as T));
      else finish(() => reject(new HostActionError(reply.error ?? `${verb} failed`)));
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      const why =
        err.code === "ENOENT"
          ? `the Karen bridge is not running (no socket at ${path})`
          : err.code === "ECONNREFUSED"
            ? `the Karen bridge is not accepting connections at ${path}`
            : err.message;
      finish(() => reject(new HostUnavailableError(why)));
    });

    socket.on("close", () => {
      finish(() =>
        reject(new HostUnavailableError("the bridge closed the connection before replying")),
      );
    });
  });
}
