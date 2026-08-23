#!/usr/bin/env node
/**
 * karen-bridge -- the VM half of Karen.
 *
 * Responsibilities:
 *   - dial the host app (outbound, because SLIRP makes host->guest unroutable)
 *   - receive API keys and hold them in memory only
 *   - supervise `pi --mode rpc` and pump its JSONL both ways
 *   - expose a local socket so pi extensions can request host actions
 *   - own ~/.pi/agent/models.json on the GUI's behalf
 */

import { join } from "node:path";
import { CONFIG_PATHS, loadConfig, type BridgeConfig } from "./config.ts";
import { categoriesFromConfig, type SearxngConfigBody } from "./categories.ts";
import { HostLink } from "./host-link.ts";
import { acquire, lockPath } from "./single-instance.ts";
import { PiProcess } from "./pi-process.ts";
import { ActionServer } from "./action-server.ts";
import { flattenModels, readModels, readModelsSync, writeModels } from "./models.ts";
import { deleteAllSessions, deleteSession, listSessions } from "./sessions.ts";
import { log } from "./logger.ts";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

/** Where research runs live. One definition, used by every op that touches them. */
function researchRootPath(): string {
  return (
    process.env["KAREN_RESEARCH_ROOT"] ?? join(homedir(), "Documents", "karen", "research")
  );
}
import { DEFAULT_RESEARCH } from "@karen/protocol";
import type {
  CtlRequestFrame,
  ResearchConfig,
  HelloAck,
  KarenFrame,
  ModelsConfig,
  PiFrame,
  PolicyConfig,
  PiOutbound,
  SecretsPayload,
} from "@karen/protocol";

const BRIDGE_VERSION = "0.1.0";

function socketPath(): string {
  const runtime = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(runtime, "karen-bridge.sock");
}

/** Long enough for a person to notice a dialog, come back, and read it. */
const ACTION_TIMEOUT_MS = 30 * 60_000;

class Bridge {
  #cfg: BridgeConfig;
  #link: HostLink;
  #pi: PiProcess | undefined;
  #actions: ActionServer;
  #secretEnv: Record<string, string> = {};
  #ack: HelloAck | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  /**
   * The models.json content pi actually read, captured at spawn.
   *
   * pi parses this file once at startup and never re-reads it -- the "reloads
   * on /model" behaviour in its docs belongs to the TUI picker, which does not
   * exist in RPC mode. So the bridge has to notice when the file has moved on
   * from what pi holds, and respawn it.
   */
  #piCatalogue: string | undefined;
  #catalogueStale = false;
  /**
   * Whether credentials have been fetched at least once.
   *
   * pi reads its environment only at spawn, and silently ignores any provider
   * whose apiKey env var is unset -- a pi started before the key arrives has an
   * EMPTY model catalogue. Starting it early therefore guaranteed an immediate
   * restart, which threw away whatever command was already in flight.
   */
  #secretsFetched = false;

  constructor(cfg: BridgeConfig) {
    this.#cfg = cfg;

    this.#link = new HostLink({
      url: cfg.hostUrl,
      token: cfg.token,
      bridgeVersion: BRIDGE_VERSION,
      reconnectMinMs: cfg.reconnectMinMs,
      reconnectMaxMs: cfg.reconnectMaxMs,
      onFrame: (f) => this.#onHostFrame(f),
      onConnected: (ack) => void this.#onConnected(ack),
      onSuperseded: () => {
        // Exit rather than linger: a second bridge is serving the app, and two
        // of them displace each other in a loop that wedges it.
        log.warn("exiting: another karen-bridge is already connected");
        process.exitCode = 0;
        void this.stop();
      },
      onDisconnected: () => this.#onDisconnected(),
    });

    this.#actions = new ActionServer({
      socketPath: socketPath(),
      dispatch: (verb, args) => this.#dispatchAction(verb, args),
    });
  }

  async start(): Promise<void> {
    await this.#actions.start();
    this.#link.connect();
  }

  /* ---------------- host link ---------------- */

  async #onConnected(ack: HelloAck): Promise<void> {
    this.#ack = ack;
    log.info("handshake accepted", { mode: ack.mode, workspaceRoot: ack.workspaceRoot });

    // Seed the guard's copy from the handshake, so the very first tool call of
    // a session is policed even if the user never touches the mode control.
    await this.#writePolicy({ mode: ack.mode, workspaceRoot: ack.workspaceRoot });

    await this.#fetchSecrets();
    this.#ensurePi();
  }

  /**
   * Pull credentials from the host and hand them to pi.
   *
   * pi reads its environment once, at spawn, so a changed key means a fresh
   * child. Sessions are append-only files on disk, so restarting loses nothing.
   */
  async #fetchSecrets(): Promise<void> {
    try {
      const secrets = await this.#link.request<SecretsPayload>((id) => ({
        ch: "ctl",
        id,
        op: "secrets",
      }));
      const next = secrets?.env ?? {};
      const changed = JSON.stringify(next) !== JSON.stringify(this.#secretEnv);
      this.#secretEnv = next;
      log.info("received secrets", { vars: Object.keys(next), changed });
      this.#secretsFetched = true;

      if (changed && this.#pi) {
        this.#pi.updateSecrets(next);
        if (this.#pi.running) await this.#pi.restart();
      }
    } catch (err) {
      // A host that cannot supply secrets must not block pi forever; it will
      // simply come up with whatever providers need no key.
      log.error("could not fetch secrets", { err: String(err) });
      this.#secretsFetched = true;
    }
  }

  #onDisconnected(): void {
    // Deliberately leave pi running. Session entries are append-only with
    // stable ids, so on reconnect the host resyncs with get_entries + a cursor
    // rather than losing in-flight work.
    log.info("host link down; pi left running");
  }

  #onHostFrame(frame: KarenFrame): void {
    switch (frame.ch) {
      case "rpc": {
        const type = (frame.payload as { type?: string })?.type ?? "?";
        this.#ensurePi();
        log.debug("rpc -> pi", { type, piRunning: this.#pi?.running ?? false });
        this.#pi?.send(frame.payload as PiOutbound);
        break;
      }
      case "ctl":
        if ("op" in frame) void this.#onCtlRequest(frame);
        break;
      case "action":
        // Results are correlated inside HostLink; nothing to do here.
        break;
      default:
        log.warn("unknown channel from host", { frame: JSON.stringify(frame).slice(0, 120) });
    }
  }

  /* ---------------- pi ---------------- */

  #ensurePi(): void {
    if (this.#pi?.running) return;
    // Construct it even when we are not ready to start: its outbox is what
    // holds early commands instead of dropping them.
    if (!this.#pi) {
      this.#pi = new PiProcess({
        sessionDir: this.#cfg.sessionDir,
        cwd: this.#cfg.workspaceRoot,
        secretEnv: this.#secretEnv,
        onFrame: (f: PiFrame) => {
          this.#link.send({ ch: "rpc", payload: f });
          // A deferred respawn waits here: agent_settled is the first moment
          // it is safe to cut pi off without truncating a reply.
          if (f.type === "agent_settled" && this.#catalogueStale) {
            void this.#reconcileCatalogue();
          }
        },
        onExit: () => this.#schedulePiRestart(),
      });
    }
    if (!this.#secretsFetched) {
      log.debug("holding pi start until credentials arrive");
      return;
    }
    this.#pi.start();
    // Record what pi just read, so a later write can be compared against it.
    this.#piCatalogue = JSON.stringify(readModelsSync(CONFIG_PATHS.piModels) ?? { providers: {} });
    this.#catalogueStale = false;
  }

  /**
   * Bring pi's cached model catalogue back in line with models.json.
   *
   * Respawning is the only way: pi has no reload command. The active model is
   * captured and re-applied afterwards, because editing which models are
   * AVAILABLE must not silently change which one is ACTIVE.
   */
  async #reconcileCatalogue(): Promise<void> {
    if (!this.#catalogueStale || !this.#pi?.running) return;

    let sessionFile: string | undefined;
    let active: { id?: string; provider?: string } | undefined;
    try {
      const res = await this.#pi.request({ type: "get_state" });
      const data = res.data as
        | { isStreaming?: boolean; sessionFile?: string; model?: { id?: string; provider?: string } }
        | undefined;
      if (data?.isStreaming) {
        log.info("catalogue stale; deferring pi respawn until the run settles");
        return;
      }
      sessionFile = data?.sessionFile;
      active = data?.model;
    } catch (err) {
      log.warn("could not read pi state before respawn", { err: String(err) });
    }

    log.info("models.json changed; respawning pi to pick it up", {
      resume: sessionFile ?? "(new session)",
      active: active?.id ?? "(unknown)",
    });
    this.#pi.setResumeSession(sessionFile);
    await this.#pi.restart();
    this.#piCatalogue = JSON.stringify(readModelsSync(CONFIG_PATHS.piModels) ?? { providers: {} });
    this.#catalogueStale = false;

    // Re-select the model the user was on, if it survived the edit.
    if (!active?.id || !active.provider) return;
    const cfg = readModelsSync(CONFIG_PATHS.piModels);
    const survived = cfg && flattenModels(cfg).some(
      (m) => m.id === active.id && m.provider === active.provider,
    );
    if (!survived) return;
    try {
      await this.#pi.request({ type: "set_model", provider: active.provider, modelId: active.id });
    } catch (err) {
      log.warn("could not restore active model after respawn", { err: String(err) });
    }
  }

  /**
   * Publish the permission mode where the guard extension can read it.
   *
   * Written atomically: the guard reads this on every tool call, and a
   * half-written file would be read as "no policy", which fails open.
   */
  #policySeq = 0;

  async #writePolicy(config: PolicyConfig | undefined): Promise<void> {
    if (!config?.mode || !config.workspaceRoot) return;
    try {
      await mkdir(CONFIG_PATHS.dir, { recursive: true });
      // Unique temp name per write. Two writers legitimately race here -- the
      // handshake seeds the policy while the host pushes the same thing -- and
      // a shared "<file>.tmp" means one rename finds the other's file already
      // moved. Same-content today, but a mode change arriving mid-handshake
      // would let the loser's copy win.
      const tmp = `${CONFIG_PATHS.policy}.${process.pid}.${++this.#policySeq}.tmp`;
      await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, CONFIG_PATHS.policy);
      log.info("policy updated", { mode: config.mode });
    } catch (err) {
      log.warn("could not write policy file", { err: String(err) });
    }
  }

  #schedulePiRestart(): void {
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => this.#ensurePi(), 2_000);
    this.#restartTimer.unref();
  }

  /* ---------------- control ops ---------------- */

  async #onCtlRequest(frame: CtlRequestFrame): Promise<void> {
    // Build the frame with only the fields that are actually present:
    // exactOptionalPropertyTypes distinguishes "absent" from "explicitly undefined".
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      this.#link.send({
        ch: "ctl",
        id: frame.id,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    };

    try {
      switch (frame.op) {
        case "refresh_secrets":
          await this.#fetchSecrets();
          reply(true, { refreshed: true });
          break;

        case "get_state": {
          if (!this.#pi?.running) { reply(false, undefined, "pi is not running"); break; }
          const res = await this.#pi.request({ type: "get_state" });
          reply(res.success, res.data, res.error);
          break;
        }

        case "health":
          reply(true, {
            bridgeVersion: BRIDGE_VERSION,
            piRunning: this.#pi?.running ?? false,
            workspaceRoot: this.#cfg.workspaceRoot,
          });
          break;

        case "get_models": {
          // models.json is the source of truth for what is AVAILABLE, so it is
          // read from disk rather than asked of pi. pi answers with the
          // catalogue it cached at spawn, which is stale the instant the user
          // changes the list -- that mismatch is what made the dropdown show a
          // model nobody had selected.
          const cfg = await readModels(CONFIG_PATHS.piModels);
          const models = flattenModels(cfg);

          // pi drops any provider whose apiKey env var is unset, without
          // saying so: the catalogue simply comes back empty and set_model
          // then fails with a bare "Model not found". Detect that here so the
          // UI can name the real problem -- a key that is configured but has
          // not reached pi.
          let credentialsMissing = false;
          if (models.length > 0 && this.#pi?.running) {
            try {
              const res = await this.#pi.request({ type: "get_available_models" });
              const seen = (res.data as { models?: unknown[] } | undefined)?.models ?? [];
              credentialsMissing = seen.length === 0;
            } catch { /* pi mid-restart; leave the flag alone */ }
          }

          reply(true, {
            models,
            config: cfg,
            piInSync: !this.#catalogueStale,
            credentialsMissing,
          });
          break;
        }

        case "write_models": {
          const config = frame.args?.["config"] as ModelsConfig;
          await writeModels(CONFIG_PATHS.piModels, config);
          // pi is now holding a catalogue that no longer matches the file, so
          // set_model would reject anything newly added. Respawn before
          // replying, so whatever the caller does next talks to a current pi.
          if (JSON.stringify(config) !== this.#piCatalogue) {
            this.#catalogueStale = true;
            await this.#reconcileCatalogue();
          }
          reply(true, { written: true, piInSync: !this.#catalogueStale });
          break;
        }

        case "set_research": {
          // Written to a file rather than pushed into pi, because the research
          // extension is a separate process: it reads this at the moment a tool
          // runs, so a change takes effect on the very next call with no
          // restart and no stale copy in memory.
          const cfg = (frame.args?.["config"] ?? DEFAULT_RESEARCH) as ResearchConfig;
          await mkdir(CONFIG_PATHS.dir, { recursive: true });
          const tmp = `${CONFIG_PATHS.research}.tmp`;
          await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
          await rename(tmp, CONFIG_PATHS.research);
          log.info("research config updated", { mode: cfg.mode, categories: cfg.category });
          reply(true, { config: cfg });
          break;
        }

        case "set_policy": {
          // Same reasoning as set_research: the guard extension is in another
          // process and reads this at the moment a tool call happens, so a mode
          // change takes effect on the very next call rather than at restart.
          await this.#writePolicy(frame.args?.["config"] as PolicyConfig | undefined);
          reply(true, { ok: true });
          break;
        }

        case "list_sessions": {
          reply(true, { sessions: await listSessions(this.#cfg.sessionDir) });
          break;
        }

        case "delete_session": {
          const id = String(frame.args?.["id"] ?? "");
          if (!id) {
            reply(false, undefined, "delete_session needs an id");
            break;
          }
          const result = await deleteSession(id, this.#cfg.sessionDir, researchRootPath());
          log.info("session deleted", { id, runs: result.runsDeleted.length });
          reply(true, result);
          break;
        }

        case "delete_all_sessions": {
          const result = await deleteAllSessions(this.#cfg.sessionDir, researchRootPath());
          log.info("all sessions deleted", { ...result });
          reply(true, result);
          break;
        }

        case "pause_research": {
          /*
           * Pause the newest run by dropping a file in its directory.
           *
           * A file rather than a signal, because the pipeline is a chain of pi
           * SUBPROCESSES: there is no in-memory flag the bridge could set that
           * the stage currently running would see. The pipeline checks for this
           * at each stage boundary, which is the only place a pause resumes
           * cleanly — a stage killed mid-flight would leave nothing to resume
           * from.
           */
          const root = researchRootPath();
          const runs = await readdir(root, { withFileTypes: true }).catch(() => []);
          const newest = runs
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
            .pop();
          if (!newest) {
            reply(false, undefined, "no research runs to pause");
            break;
          }
          await writeFile(
            join(root, newest, "PAUSED"),
            `paused at ${new Date().toISOString()}\n`,
            "utf8",
          );
          log.info("research paused", { run: newest });
          reply(true, { run: newest });
          break;
        }

        case "get_search_categories": {
          // Read from the running SearXNG so the GUI offers exactly the
          // categories the user's own engine configuration actually supports.
          const base = (process.env["KAREN_SEARXNG_URL"] ?? "http://127.0.0.1:8888").replace(/\/$/, "");
          const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new Error(`SearXNG returned ${res.status} ${res.statusText}`);
          reply(true, { categories: categoriesFromConfig((await res.json()) as SearxngConfigBody) });
          break;
        }

        case "probe_models": {
          // Probed from the VM, never the host: the host app is not permitted
          // to contact the LLM endpoint at all under the two-zone network model.
          const baseUrl = String(frame.args?.["baseUrl"] ?? "");
          const envVar = String(frame.args?.["envVar"] ?? "");
          reply(true, await this.#probeModels(baseUrl, envVar));
          break;
        }

        default:
          reply(false, undefined, `unsupported op: ${frame.op}`);
      }
    } catch (err) {
      reply(false, undefined, (err as Error).message);
    }
  }

  async #probeModels(
    baseUrl: string,
    envVar: string,
  ): Promise<{ models: { id: string; name: string }[] }> {
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must be http(s)");
    const key = envVar ? this.#secretEnv[envVar] : undefined;
    const url = baseUrl.replace(/\/$/, "") + "/models";

    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`endpoint returned ${res.status} ${res.statusText}`);

    // Servers vary: some add a friendlier display_name (LM Studio, llama-swap),
    // most give only an id. Prefer the nicer label when it exists.
    const body = (await res.json()) as { data?: { id?: string; display_name?: string }[] };
    const models = (body.data ?? [])
      .map((m) => ({ id: String(m.id ?? ""), name: String(m.display_name ?? m.id ?? "") }))
      .filter((m) => m.id.length > 0);
    return { models };
  }

  /* ---------------- host actions ---------------- */

  /**
   * Host actions get a much longer deadline than other requests.
   *
   * Any action may stop and ask the user to approve it, and the floor classes
   * ALWAYS do. The default 60s deadline meant a user who took a minute to
   * notice the dialog got the worst possible outcome: the VM gave up and told
   * the model the action failed, while the host went ahead and performed it on
   * the click. The model would then reasonably retry, and create a duplicate.
   *
   * Still finite, so a genuinely lost reply eventually surfaces as an error
   * rather than wedging the agent forever.
   */
  async #dispatchAction(verb: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.#link.connected) {
      throw new Error("host is not connected; action unavailable");
    }
    return this.#link.request((id) => ({ ch: "action", id, verb, args }), ACTION_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#restartTimer);
    this.#pi?.stop();
    this.#link.close();
    await this.#actions.stop();
  }
}

async function main(): Promise<void> {
  // Before anything else, and before any socket is opened: two bridges fight
  // over the app's single host link and wedge it. See single-instance.ts.
  const lock = acquire();
  if (!lock) {
    log.warn("another karen-bridge is already running; nothing to do", { lock: lockPath() });
    return;
  }

  const cfg = await loadConfig();
  log.info("karen-bridge starting", { host: cfg.hostUrl, workspace: cfg.workspaceRoot });

  const bridge = new Bridge(cfg);
  try {
    await bridge.start();
  } catch (err) {
    lock.release();
    throw err;
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info("shutting down", { sig });
      void bridge.stop().then(() => {
        lock.release();
        process.exit(0);
      });
    });
  }
  // A crash still releases it: the next start finds a pid that is not running
  // and takes the lock over rather than refusing to work.
  process.on("exit", () => lock.release());
}

main().catch((err) => {
  log.error("fatal", { err: String(err?.stack ?? err) });
  process.exit(1);
});
