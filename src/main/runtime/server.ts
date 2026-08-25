/**
 * Running llama-server as a child of this app.
 *
 * The part most likely to generate bug reports, so it is the part written most
 * carefully. Four things matter more than they look:
 *
 *   - **It must die when we do.** On Windows a terminated parent does *not*
 *     take its children with it, so a naive `child.kill()` leaves a process
 *     holding eight gigabytes after the app has closed. That behaviour is
 *     exactly what people complain about in other local-model apps.
 *   - **It must not be reachable by anything else.** Loopback only, plus a
 *     random per-session API key. Without the key, every process on the machine
 *     can use the model; on a shared or work laptop that is a real hole, and it
 *     costs one flag.
 *   - **Loading is not starting.** A 30 GB model takes real time to map, and a
 *     chat box that silently fails to answer looks broken. The UI is gated on
 *     `/health` rather than on the process existing.
 *   - **stderr is the diagnosis.** When a GPU backend fails it fails loudly on
 *     stderr and says nothing anywhere else, so it is captured and shown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export type ServerState = "stopped" | "starting" | "ready" | "failed";

/* The optionals are written `?: T | undefined` deliberately: under
 * exactOptionalPropertyTypes, clearing a field by assigning undefined -- which
 * is what "no longer failed" and "no longer running" mean here -- is otherwise
 * a type error. */
export interface ServerStatus {
  state: ServerState;
  /** Where the OpenAI-compatible API is, once ready. */
  baseUrl?: string | undefined;
  modelPath?: string | undefined;
  error?: string | undefined;
  /** The tail of stderr, for the log panel in Settings. */
  log: string[];
  pid?: number | undefined;
}

export interface StartOptions {
  binary: string;
  modelPath: string;
  /** 0 lets llama.cpp take the model's own trained context. */
  contextSize?: number;
  /** "auto" is upstream's default and is usually right. */
  gpuLayers?: number | "auto";
  /**
   * Concurrent request slots. Pinned rather than left at upstream's -1 (auto):
   * the research pipeline issues concurrent stage calls, and slot exhaustion
   * presents as a hang, which is the worst way for it to present.
   */
  parallel?: number;
  extraArgs?: string[];
}

const LOG_LINES = 400;
const HEALTH_TIMEOUT_MS = 15 * 60_000; // A very large model on a slow disk.
const HEALTH_INTERVAL_MS = 500;

/** An unused port, obtained by letting the OS pick one and handing it back. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("could not obtain a port"))));
    });
  });
}

export class LlamaServer {
  #child: ChildProcess | undefined;
  #status: ServerStatus = { state: "stopped", log: [] };
  #apiKey = "";
  #listeners = new Set<(s: ServerStatus) => void>();
  #restarts = 0;
  #stopping = false;

  get status(): ServerStatus {
    return this.#status;
  }

  /** The key callers must present. Never leaves the main process. */
  get apiKey(): string {
    return this.#apiKey;
  }

  onChange(fn: (s: ServerStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(patch: Partial<ServerStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const fn of this.#listeners) fn(this.#status);
  }

  #log(line: string): void {
    const log = [...this.#status.log, line].slice(-LOG_LINES);
    this.#set({ log });
  }

  async start(opts: StartOptions): Promise<ServerStatus> {
    await this.stop();
    this.#stopping = false;

    const port = await freePort();
    this.#apiKey = randomBytes(24).toString("hex");
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const args = [
      "-m", opts.modelPath,
      "--host", "127.0.0.1",
      "--port", String(port),
      // Required for tool calling; upstream enables it by default but being
      // explicit means a future default change cannot quietly break tools.
      "--jinja",
      "-np", String(opts.parallel ?? 2),
      "-c", String(opts.contextSize ?? 0),
    ];
    if (opts.gpuLayers !== undefined && opts.gpuLayers !== "auto") {
      args.push("-ngl", String(opts.gpuLayers));
    }
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    this.#set({ state: "starting", baseUrl, modelPath: opts.modelPath, log: [], error: undefined });

    const child = spawn(opts.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Not detached: this process must remain our child so that closing the
      // app can find and kill it.
      windowsHide: true,
      /*
       * The key goes in the environment, not in argv.
       *
       * `--api-key` works, but a process's command line is world-readable on
       * Linux -- `/proc/<pid>/cmdline` -- so every other user on the machine
       * could read the key straight out of the process list. `/proc/<pid>/environ`
       * is owner-only, which is the boundary we can actually enforce. Upstream
       * documents LLAMA_API_KEY as the environment form of the same flag.
       */
      env: { ...process.env, LLAMA_API_KEY: this.#apiKey },
    });
    this.#child = child;
    this.#set({ pid: child.pid ?? undefined });

    const capture = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.#log(line);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (err) => {
      this.#set({ state: "failed", error: `could not start llama-server: ${err.message}` });
    });

    child.on("exit", (code, signal) => {
      this.#child = undefined;
      if (this.#stopping) {
        this.#set({ state: "stopped", pid: undefined });
        return;
      }
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      // Restart once. Twice would be a loop, and a loop hides the reason.
      if (this.#restarts === 0 && this.#status.state === "ready") {
        this.#restarts++;
        this.#log(`llama-server stopped unexpectedly (${why}); restarting once.`);
        void this.start(opts);
        return;
      }
      this.#set({
        state: "failed",
        pid: undefined,
        error: `llama-server stopped (${why}). The log below is what it said.`,
      });
    });

    await this.#waitForHealth(port);
    return this.#status;
  }

  /**
   * Poll `/health` until the model is loaded.
   *
   * llama-server answers 503 while loading and 200 when ready, so this
   * distinguishes "still mapping a 30 GB file" from "not listening at all".
   */
  async #waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.#child) return; // Exited; the exit handler has set the state.
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          this.#restarts = 0;
          this.#set({ state: "ready", error: undefined });
          return;
        }
      } catch {
        // Not listening yet, which is expected for the first few seconds.
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    await this.stop();
    this.#set({ state: "failed", error: "the model did not finish loading in time." });
  }

  /**
   * Stop, and mean it.
   *
   * `taskkill /T` on Windows because that is the only way to take the whole
   * process tree; SIGTERM then SIGKILL elsewhere, with a grace period so the
   * server can release the model file cleanly.
   */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      this.#child = undefined;
      this.#set({ state: "stopped", pid: undefined });
      return;
    }
    this.#stopping = true;

    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#child && process.platform !== "win32") child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.#child = undefined;
    this.#set({ state: "stopped", pid: undefined, baseUrl: undefined });
  }

  /** Synchronous best effort, for `before-quit` where nothing can be awaited. */
  killNow(): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    this.#stopping = true;
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Ask a build which devices it can see.
 *
 * The step that turns the vendor-id guess into a fact. A build that reports no
 * accelerator is a build we should not be using, and finding that out here --
 * before a model is downloaded -- is the entire reason the runtime is installed
 * before the model is chosen.
 */
export async function listDevices(binary: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(binary, ["--list-devices"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const done = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (out += b.toString()));
    // A build that cannot run at all -- a missing driver library, say -- is a
    // failed probe, not a crash. The caller falls back to CPU.
    child.on("error", () => {
      clearTimeout(done);
      resolve(out);
    });
    child.on("close", () => {
      clearTimeout(done);
      resolve(out);
    });
  });
}
