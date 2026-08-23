/**
 * A local unix socket that pi extensions use to request host actions.
 *
 * Why a socket rather than something in-band: extensions run inside the pi
 * process, whose stdout IS the RPC stream. Anything an extension wrote there
 * would corrupt framing. So host actions travel out of band -- extension ->
 * this socket -> bridge -> host broker -> back again.
 *
 * The socket is created 0600 in the user's runtime directory, so it is reachable
 * only by this user inside the VM. It grants no authority of its own: every
 * request still faces the host broker's verb allowlist and permission policy.
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { JsonlSplitter, encodeJsonl, parseJsonlLine } from "@karen/protocol";
import { log } from "./logger.ts";

export interface ActionRequest {
  id: string;
  verb: string;
  args: Record<string, unknown>;
}

export interface ActionServerOptions {
  socketPath: string;
  /** Forwards to the host and resolves with the broker's result. */
  dispatch: (verb: string, args: Record<string, unknown>) => Promise<unknown>;
}

export class ActionServer {
  #server: Server | undefined;
  readonly #opts: ActionServerOptions;

  constructor(opts: ActionServerOptions) {
    this.#opts = opts;
  }

  async start(): Promise<void> {
    const path = this.#opts.socketPath;
    await mkdir(dirname(path), { recursive: true });
    // Clear a stale socket left by an unclean shutdown.
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    await chmod(path, 0o600);
    log.info("action socket listening", { path });
  }

  #onConnection(socket: Socket): void {
    const splitter = new JsonlSplitter({ maxLineBytes: 8 * 1024 * 1024 });

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch (err) {
        log.warn("action framing error", { err: String(err) });
        socket.destroy();
        return;
      }
      for (const line of lines) void this.#handleLine(socket, line);
    });

    socket.on("error", (err) => log.debug("action socket error", { err: String(err) }));
  }

  async #handleLine(socket: Socket, line: string): Promise<void> {
    const parsed = parseJsonlLine<ActionRequest>(line);
    if (!parsed.ok || !parsed.value) {
      socket.write(encodeJsonl({ id: null, ok: false, error: "malformed request" }));
      return;
    }
    const { id, verb, args } = parsed.value;

    try {
      const result = await this.#opts.dispatch(verb, args ?? {});
      socket.write(encodeJsonl({ id, ok: true, result }));
    } catch (err) {
      socket.write(encodeJsonl({ id, ok: false, error: (err as Error).message }));
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.#opts.socketPath).catch(() => undefined);
    this.#server = undefined;
  }
}
