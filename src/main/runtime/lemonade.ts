/**
 * Running `lemond` as a child of this app.
 *
 * Modelled closely on the llama-server supervisor it replaces, because the
 * hard-won parts of that file are not about llama.cpp: a child that outlives
 * the app is the complaint people make about local-model tools, and a process
 * that exists but is not yet serving looks exactly like one that is broken.
 *
 * What is genuinely different is the lifecycle. llama-server WAS the model, so
 * starting it and loading a model were one act. `lemond` is a manager: it comes
 * up once, holds no model, and Karen loads and unloads through its API. So this
 * supervisor knows nothing about models, and "ready" means the daemon is
 * answering -- seconds, not the minutes a 30 GB mmap took.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  apiBase, CONFIG_FILE, lemondArgs, mergeConfig, openAiBase, parseHealth, pinnedConfig,
  type LemonadeHealth,
} from "../../core/runtime/lemonade.ts";
import { makePrivateDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { launchSpec } from "./loader.ts";
import { freePort } from "./server.ts";

export type LemonadeState = "stopped" | "starting" | "ready" | "failed";

/* `?: T | undefined` throughout: clearing a field by assigning undefined --
   which is what "no longer failed" and "no longer running" mean -- is a type
   error under exactOptionalPropertyTypes otherwise. */
export interface LemonadeStatus {
  state: LemonadeState;
  /** OpenAI-compatible base, which is what Karen's clients speak. */
  baseUrl?: string | undefined;
  /** Lemonade's own management base, for devices, backends and models. */
  adminUrl?: string | undefined;
  health?: LemonadeHealth | undefined;
  error?: string | undefined;
  /** The tail of the daemon's output, for the log panel in Settings. */
  log: string[];
  pid?: number | undefined;
}

export interface LemonadeStartOptions {
  /** Path to the `lemond` executable. */
  binary: string;
  cacheDir: string;
  configDir: string;
  /** Karen's existing model library, which the daemon should also list. */
  modelsDir?: string;
}

const LOG_LINES = 400;
/* Generous next to the daemon's real start time (about a second measured), but
   it also covers a cold filesystem and a first run that has state to write. */
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 250;

export class LemonadeServer {
  #child: ChildProcess | undefined;
  #status: LemonadeStatus = { state: "stopped", log: [] };
  #apiKey = "";
  #port = 0;
  #listeners = new Set<(s: LemonadeStatus) => void>();
  #restarts = 0;
  #stopping = false;

  get status(): LemonadeStatus {
    return this.#status;
  }

  /** The key callers must present. Never leaves the main process. */
  get apiKey(): string {
    return this.#apiKey;
  }

  get port(): number {
    return this.#port;
  }

  onChange(fn: (s: LemonadeStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(patch: Partial<LemonadeStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const fn of this.#listeners) fn(this.#status);
  }

  #log(line: string): void {
    this.#set({ log: [...this.#status.log, line].slice(-LOG_LINES) });
  }

  /** Headers for an authenticated call to the daemon. */
  authHeaders(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }

  async start(opts: LemonadeStartOptions): Promise<LemonadeStatus> {
    await this.stop();
    this.#stopping = false;

    await makePrivateDir(opts.cacheDir);
    await makePrivateDir(opts.configDir);
    await this.#pinConfig(opts.configDir, opts.modelsDir);

    const port = await freePort();
    this.#port = port;
    this.#apiKey = randomBytes(24).toString("hex");

    this.#set({
      state: "starting",
      baseUrl: openAiBase(port),
      adminUrl: apiBase(port),
      log: [],
      error: undefined,
      health: undefined,
    });

    /*
     * Through launchSpec so a bundled C runtime is used when one is present.
     * The daemon requires GLIBC_2.38 -- it is built on Ubuntu 24.04 -- which no
     * Ubuntu 22.04 or Debian 12 machine has, so on those it runs through the
     * loader Karen ships beside it. See core/runtime/libc.ts for why the loader
     * must be BESIDE the binary: lemond finds its `resources/` directory
     * relative to /proc/self/exe, which under a bundled loader is the loader.
     */
    const launch = launchSpec(opts.binary, lemondArgs({
      port, cacheDir: opts.cacheDir, configDir: opts.configDir,
    }));

    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Not detached: this process must remain our child so that closing the
      // app can find and kill it.
      windowsHide: true,
      cwd: dirname(opts.binary),
      /*
       * The key goes in the environment, not in argv, for the same reason it
       * did with llama-server: a process's command line is world-readable on
       * Linux via /proc/<pid>/cmdline, while /proc/<pid>/environ is owner-only.
       */
      env: { ...process.env, ...launch.env, LEMONADE_API_KEY: this.#apiKey },
    });
    this.#child = child;
    this.#set({ pid: child.pid ?? undefined });

    const capture = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) this.#log(line);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (err) => {
      this.#set({ state: "failed", error: `could not start Lemonade: ${err.message}` });
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
        this.#log(`Lemonade stopped unexpectedly (${why}); restarting once.`);
        void this.start(opts);
        return;
      }
      this.#set({
        state: "failed",
        pid: undefined,
        error: `Lemonade stopped (${why}). The log below is what it said.`,
      });
    });

    await this.#waitForReady(port);
    return this.#status;
  }

  /**
   * Write the settings Karen will not leave to a default.
   *
   * Done before every start rather than once at install, because the file IS
   * the daemon's own and it does rewrite it: measured, it rewrote config.json
   * at startup adding `config_version` -- keeping the values written here, but
   * with its own permissions (664, where this writes 600). A privacy setting
   * that holds only until something else touches the file is not one worth
   * having, so it is reasserted on every start. Anything else in the file is
   * preserved; see mergeConfig.
   *
   * The directory, not the file, is what keeps this private: `makePrivateDir`
   * makes it owner-only, so the daemon's 664 is unreachable by other users
   * anyway. That matters more than it looks, because Lemonade stores cloud
   * provider credentials in this directory via its own API.
   */
  async #pinConfig(configDir: string, modelsDir?: string): Promise<void> {
    const path = join(configDir, CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      /* Absent on first run, and a file we cannot parse is one we should not
         preserve -- overwriting it restores a known-good state. */
    }
    try {
      await writeFile(path, `${JSON.stringify(mergeConfig(existing, pinnedConfig(modelsDir)), null, 2)}\n`, {
        mode: OWNER_ONLY_FILE,
      });
    } catch (err) {
      // Not fatal: --no-broadcast still holds on the command line, and the
      // remaining settings are already the defaults. Worth saying, though.
      this.#log(`could not write Lemonade config: ${(err as Error).message}`);
    }
  }

  /**
   * Poll until the daemon answers.
   *
   * **Authenticated, and that is not optional.** llama-server leaves `/health`
   * open so a supervisor can poll it; Lemonade does not -- with
   * `LEMONADE_API_KEY` set it answers `401 GET /api/v1/health`. Probing without
   * the key therefore never sees a 200, and the daemon is killed for failing to
   * start while it sits there serving perfectly. Measured, after exactly that
   * happened.
   */
  async #waitForReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.#child) return; // Exited; the exit handler has set the state.
      try {
        const res = await fetch(`${apiBase(port)}/health`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          this.#restarts = 0;
          this.#set({
            state: "ready",
            error: undefined,
            health: parseHealth(await res.json().catch(() => ({}))),
          });
          return;
        }
      } catch {
        // Not listening yet, which is expected for the first second or two.
      }
      await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
    }
    await this.stop();
    this.#set({ state: "failed", error: "Lemonade did not start in time." });
  }

  /**
   * Re-read what the daemon has loaded.
   *
   * Health is captured once at startup, but what is loaded changes underneath
   * that -- and chat routing depends on it, so a stale answer means requests
   * going to a server with no model. Called after anything that loads or
   * unloads rather than polled, because those are the only things that change
   * it.
   */
  async refreshHealth(): Promise<void> {
    if (this.#status.state !== "ready") return;
    try {
      const res = await fetch(`${apiBase(this.#port)}/health`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) this.#set({ health: parseHealth(await res.json().catch(() => ({}))) });
    } catch {
      // Leave the last known answer; the supervisor's own state says whether
      // the daemon is up, and that has not changed here.
    }
  }

  /**
   * Stop, and mean it.
   *
   * `taskkill /T` on Windows because a terminated parent does not take its
   * children with it there -- and lemond has children of its own, since the
   * backends it manages are separate processes. SIGTERM then SIGKILL elsewhere,
   * with a grace period so a loaded model is released cleanly.
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
    this.#set({ state: "stopped", pid: undefined, baseUrl: undefined, adminUrl: undefined });
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
