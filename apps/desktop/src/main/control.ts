/**
 * The control socket: how a keypress reaches a running Karen.
 *
 * The GNOME keybinding runs `karen-ctl dictate-toggle`, a process with no idea
 * where the app is. It writes one line here and exits. That indirection is what
 * makes a global hotkey work on Wayland at all.
 *
 * The socket lives in $XDG_RUNTIME_DIR, which is 0700 and per-user, and is
 * itself chmod 0600. It carries no authority beyond what a user sitting at the
 * machine already has -- it can start and stop dictation, nothing else. There
 * is deliberately no verb here that touches the agent, the vault or the host
 * broker: those all have their own, audited paths.
 */

import { createServer, type Server } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type ControlCommand = "dictate-toggle" | "dictate-start" | "dictate-stop" | "ping";

const COMMANDS = new Set<string>(["dictate-toggle", "dictate-start", "dictate-stop", "ping"]);

export function controlSocketPath(): string {
  const runtime = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return `${runtime}/karen.sock`;
}

export interface ControlServerOptions {
  socketPath?: string;
  handle: (command: ControlCommand) => Promise<string> | string;
}

export class ControlServer {
  #server: Server | undefined;
  readonly #opts: ControlServerOptions;
  readonly #path: string;

  constructor(opts: ControlServerOptions) {
    this.#opts = opts;
    this.#path = opts.socketPath ?? controlSocketPath();
  }

  get path(): string {
    return this.#path;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    // A socket left by an unclean shutdown would make listen() fail with
    // EADDRINUSE even though nothing is listening.
    await unlink(this.#path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });

    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", async (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        // LF only, matching every other framed stream in this project.
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          if (!COMMANDS.has(line)) {
            socket.write(`error: unknown command ${line}\n`);
            continue;
          }
          try {
            socket.write(`${await this.#opts.handle(line as ControlCommand)}\n`);
          } catch (err) {
            socket.write(`error: ${(err as Error).message}\n`);
          }
        }
      });
      socket.on("error", () => socket.destroy());
    });

    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(this.#path, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.#path).catch(() => undefined);
    this.#server = undefined;
  }
}
