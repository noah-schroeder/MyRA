/**
 * Supervises a `pi --mode rpc` child process.
 *
 * Two things here are load-bearing:
 *
 * 1. Framing uses JsonlSplitter, never readline. pi's own spec calls this out:
 *    readline splits on U+2028/U+2029, which are legal inside JSON strings and
 *    appear in real model output, so it would silently desync the stream.
 *
 * 2. Secrets are passed via the child's environment ONLY. They are never
 *    written to disk, which is what keeps the VM free of credentials at rest.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonlSplitter, encodeJsonl, parseJsonlLine } from "@karen/protocol";
import type { PiFrame, PiOutbound, PiResponse } from "@karen/protocol";
import { log, redact } from "./logger.ts";

export interface PiProcessOptions {
  sessionDir: string;
  cwd: string;
  /** Injected into the child environment only. Never persisted. */
  secretEnv: Record<string, string>;
  onFrame: (frame: PiFrame) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface Pending {
  resolve: (r: PiResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Bounded so a pi that will not start cannot grow the queue without limit. */
const MAX_QUEUED_COMMANDS = 50;

export class PiProcess {
  #child: ChildProcessWithoutNullStreams | undefined;
  #splitter = new JsonlSplitter();
  #pending = new Map<string, Pending>();
  #stopping = false;
  #resumeSession: string | undefined;
  /** Commands that arrived while pi was down, replayed once it is up. */
  #outbox: PiOutbound[] = [];
  readonly #opts: PiProcessOptions;

  constructor(opts: PiProcessOptions) {
    this.#opts = opts;
  }

  /**
   * Resume this session file on the NEXT spawn.
   *
   * pi caches its model catalogue at startup, so changing models.json means
   * respawning it. Without this the conversation would silently restart every
   * time the user edited the model list.
   */
  setResumeSession(sessionFile: string | undefined): void {
    this.#resumeSession = sessionFile;
  }

  /** Replace the environment used for the NEXT spawn. Never persisted. */
  updateSecrets(secretEnv: Record<string, string>): void {
    (this.#opts as { secretEnv: Record<string, string> }).secretEnv = secretEnv;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    this.#stopping = false;
    this.#splitter.reset();

    const args = [
      "--mode", "rpc",
      // No startup network operations: pi otherwise refreshes model catalogues,
      // which is exactly the kind of unasked-for egress this project forbids.
      "--offline",
      "--session-dir", this.#opts.sessionDir,
      ...(this.#resumeSession ? ["--session", this.#resumeSession] : []),
    ];
    // One-shot: a later crash-restart should not silently reopen an old session.
    this.#resumeSession = undefined;

    log.info("spawning pi", { args: args.join(" ") });

    const child = spawn("pi", args, {
      cwd: this.#opts.cwd,
      env: { ...process.env, ...this.#opts.secretEnv, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#child !== child) return; // ignore output from a superseded child
      this.#onStdout(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = redact(chunk.toString("utf8").trimEnd());
      if (text) log.warn("pi stderr", { text });
    });

    child.on("error", (err) => log.error("pi spawn failed", { err: String(err) }));

    // Anything that arrived while pi was restarting goes in now, in order.
    if (this.#outbox.length > 0) {
      const queued = this.#outbox;
      this.#outbox = [];
      log.info("replaying commands queued while pi was down", { count: queued.length });
      for (const command of queued) child.stdin.write(encodeJsonl(command));
    }

    child.on("exit", (code, signal) => {
      // A restart spawns the replacement before the old process finishes dying,
      // so this handler can fire for a child we have already replaced. Acting on
      // it would clear the reference to the LIVE child -- orphaning it (it keeps
      // running with nothing pointing at it) and making `running` report false,
      // which then spawns yet another. Ignore exits from superseded children.
      if (this.#child !== child) {
        log.debug("superseded pi exited", { code, signal, pid: child.pid });
        return;
      }
      log.warn("pi exited", { code, signal, pid: child.pid });
      this.#failAllPending(new Error(`pi exited (code=${code}, signal=${signal})`));
      this.#child = undefined;
      if (!this.#stopping) this.#opts.onExit(code, signal);
    });
  }

  #onStdout(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.#splitter.push(chunk);
    } catch (err) {
      log.error("framing error; restarting pi", { err: String(err) });
      void this.restart();
      return;
    }

    for (const line of lines) {
      const parsed = parseJsonlLine<PiFrame>(line);
      if (!parsed.ok || !parsed.value) {
        // One bad frame must not kill the stream.
        log.warn("dropping malformed frame", { err: parsed.error?.message });
        continue;
      }
      const frame = parsed.value;
      this.#settlePending(frame);
      this.#opts.onFrame(frame);
    }
  }

  #settlePending(frame: PiFrame): void {
    if (frame.type !== "response") return;
    const res = frame as PiResponse;
    const id = res.id;
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(res);
  }

  #failAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * Fire-and-forget send. Used for frames the host originated.
   *
   * When pi is down the command is held rather than dropped. Dropping it left
   * the caller waiting on a reply that could never come -- the UI simply hung,
   * with nothing in the log to say why.
   */
  send(command: PiOutbound): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      if (this.#outbox.length >= MAX_QUEUED_COMMANDS) {
        log.warn("outbox full; dropping oldest command");
        this.#outbox.shift();
      }
      this.#outbox.push(command);
      log.info("pi is down; queued command", { type: (command as { type?: string }).type });
      return;
    }
    child.stdin.write(encodeJsonl(command));
  }

  /** Send and await the correlated response. Used for the bridge's own queries. */
  request(command: PiOutbound, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PiResponse> {
    const id = randomUUID();
    const withId = { ...command, id } as PiOutbound;

    return new Promise<PiResponse>((resolve, reject) => {
      const child = this.#child;
      if (!child || child.exitCode !== null) {
        reject(new Error("pi is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(encodeJsonl(withId));
    });
  }

  /**
   * Stop, wait for the process to actually die, then start again.
   *
   * The wait is load-bearing. A replacement that resumes the same session file
   * while its predecessor is still flushing has two pi processes writing one
   * JSONL -- the new one then failed to start, intermittently and silently.
   */
  async restart(): Promise<void> {
    await this.stopAndWait();
    this.start();
  }

  /** stop(), plus a wait for the child to leave. */
  async stopAndWait(timeoutMs = 6_000): Promise<void> {
    const child = this.#child;
    this.stop(); // sends SIGTERM and escalates on its own timer
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn("pi did not exit in time; continuing", { pid: child.pid });
        resolve();
      }, timeoutMs);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#failAllPending(new Error("pi stopping"));
    const child = this.#child;
    if (!child) return;
    // Drop the reference first so `running` is immediately false, then make sure
    // the process actually dies -- the closure keeps hold of it for escalation.
    this.#child = undefined;
    log.info("stopping pi", { pid: child.pid });
    child.stdin.end();
    child.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (child.exitCode === null) {
        log.warn("pi ignored SIGTERM; sending SIGKILL", { pid: child.pid });
        child.kill("SIGKILL");
      }
    }, 5_000);
    escalate.unref();
  }
}
