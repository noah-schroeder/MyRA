/**
 * The API server's state: its config, its keys, and its lifecycle.
 *
 * Mirrors `RuntimeManager`: its own JSON file, owner-only, loaded once and
 * written on every change. `api.json` is separate from `settings.json` because
 * it holds key hashes and a switch that opens a socket, and because a person
 * should be able to point at the file that does that.
 */

import { readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../../core/paths.ts";
import { API_DEFAULTS, mergeApiConfig, type ApiConfig } from "../../core/api/config.ts";
import { mintKey, type ApiKey } from "../../core/api/keys.ts";
import { RequestLog } from "../../core/api/log.ts";
import { ApiGateway, type GatewayStatus, type Upstream } from "./server.ts";

const CONFIG_PATH = join(CONFIG_DIR, "api.json");

export interface ApiState {
  config: Omit<ApiConfig, "keys">;
  keys: ApiKey[];
  status: GatewayStatus;
  /** The LAN address, when serving beyond loopback. */
  lanUrl?: string | undefined;
}

export class ApiManager {
  #config: ApiConfig = { ...API_DEFAULTS };
  #log = new RequestLog();
  #gateway: ApiGateway;
  #listeners = new Set<() => void>();
  /** Keys whose counters moved since the last write, to avoid a write per request. */
  #dirtyKeys = false;

  constructor(deps: {
    upstream: () => Upstream | undefined;
    models: () => Promise<{ id: string; loaded: boolean }[]>;
    loadModel: (id: string) => Promise<void>;
  }) {
    this.#gateway = new ApiGateway({
      config: () => this.#config,
      upstream: deps.upstream,
      models: deps.models,
      loadModel: deps.loadModel,
      log: this.#log,
      onKeyUsed: (id) => this.#noteKeyUse(id),
    });
    this.#gateway.onChange(() => this.#emit());
    this.#log.onChange(() => this.#emitLog());
  }

  get log(): RequestLog {
    return this.#log;
  }

  get state(): ApiState {
    const { keys, ...config } = this.#config;
    return {
      config,
      // The hash never leaves the main process; the renderer gets the rest.
      keys: keys.map((k) => ({ ...k, hash: "" })),
      status: this.#gateway.status,
      ...(this.#config.lan && this.#gateway.status.listening
        ? { lanUrl: `http://${lanAddress() ?? "your-ip"}:${String(this.#config.port)}` }
        : {}),
    };
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #logListeners = new Set<() => void>();
  onLog(fn: () => void): () => void {
    this.#logListeners.add(fn);
    return () => this.#logListeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
  #emitLog(): void {
    for (const fn of this.#logListeners) fn();
  }

  /* --------------------------------------------------------------- state -- */

  async load(): Promise<ApiConfig> {
    try {
      this.#config = mergeApiConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#config = { ...API_DEFAULTS };
    }
    return this.#config;
  }

  async #save(): Promise<void> {
    await makeOwnDir(CONFIG_DIR);
    await writeFile(CONFIG_PATH, `${JSON.stringify(this.#config, null, 2)}\n`, {
      mode: OWNER_ONLY_FILE,
    });
  }

  /**
   * Usage counters, written lazily.
   *
   * A write per request would put the user's disk in the hot path of every
   * token stream. The counters are advisory -- they answer "is this key still
   * in use" -- so they are flushed when something else saves, and on stop.
   */
  #noteKeyUse(id: string): void {
    const key = this.#config.keys.find((k) => k.id === id);
    if (!key) return;
    key.requests += 1;
    key.lastUsedAt = new Date().toISOString();
    this.#dirtyKeys = true;
  }

  async flush(): Promise<void> {
    if (!this.#dirtyKeys) return;
    this.#dirtyKeys = false;
    await this.#save();
  }

  async update(patch: Partial<Omit<ApiConfig, "keys">>): Promise<ApiState> {
    const before = { port: this.#config.port, lan: this.#config.lan, cors: this.#config.cors };
    this.#config = mergeApiConfig({ ...this.#config, ...patch });
    await this.#save();

    /* A change to where or how it listens has to be applied by relistening;
       changing the port in a settings field and having the old port stay open
       is exactly the kind of quiet wrongness this app tries not to have. */
    const rebind =
      before.port !== this.#config.port ||
      before.lan !== this.#config.lan ||
      before.cors !== this.#config.cors;
    if (this.#config.enabled && (rebind || !this.#gateway.status.listening)) await this.start();
    else if (!this.#config.enabled && this.#gateway.status.listening) await this.stop();
    this.#emit();
    return this.state;
  }

  /* ---------------------------------------------------------------- keys -- */

  /** Returns the secret, which is the only time it exists outside memory. */
  async createKey(label: string): Promise<{ state: ApiState; secret: string }> {
    const { key, secret } = mintKey(label);
    this.#config.keys = [...this.#config.keys, key];
    await this.#save();
    this.#emit();
    return { state: this.state, secret };
  }

  async revokeKey(id: string): Promise<ApiState> {
    this.#config.keys = this.#config.keys.filter((k) => k.id !== id);
    await this.#save();
    /* Serving with no keys is not a state this can be in: it would be an open
       model server. Stop rather than let the last revocation leave it running. */
    if (!this.#config.keys.length && this.#gateway.status.listening) await this.stop();
    this.#emit();
    return this.state;
  }

  /* ----------------------------------------------------------- lifecycle -- */

  async start(): Promise<ApiState> {
    const status = await this.#gateway.start();
    if (status.listening && !this.#config.enabled) {
      this.#config.enabled = true;
      await this.#save();
    }
    this.#emit();
    return this.state;
  }

  async stop(): Promise<ApiState> {
    await this.#gateway.stop();
    if (this.#config.enabled) {
      this.#config.enabled = false;
      await this.#save();
    }
    await this.flush();
    this.#emit();
    return this.state;
  }

  /** Called once at launch, after the config is loaded. */
  async startOnLaunch(): Promise<void> {
    if (this.#config.startOnLaunch && this.#config.keys.length) await this.start();
  }

  cancel(id: string): boolean {
    return this.#gateway.cancel(id);
  }

  clearLog(): void {
    this.#log.clear();
  }
}

/**
 * This machine's address on the local network.
 *
 * Shown after the LAN switch is turned on, so it is unambiguous what was just
 * published and to whom. "Serving on your network" without an address invites
 * someone to assume it is still private.
 */
export function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}
