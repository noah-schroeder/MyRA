/**
 * The API server's settings, and what they default to.
 *
 * Its own store rather than a corner of `settings.json`, for the same reason
 * `runtime.json` is separate: this file holds key material (hashed) and a
 * switch that opens a socket, and both deserve to be somewhere a person can
 * point at.
 */

import type { ApiKey } from "./keys.ts";

export interface ApiConfig {
  /**
   * Off. A listening socket is the first inbound anything in this application,
   * and it is not turned on by installing it.
   */
  enabled: boolean;
  /**
   * 4444, chosen to be free rather than familiar.
   *
   * The obvious candidates are all taken on the machines this is for: 1234 is
   * LM Studio's and 11434 is Ollama's, and claiming either would break a tool
   * the user already runs -- a rude thing to do on first install, and worse
   * than the small convenience of a port some tutorials hardcode.
   *
   * 4444 is not free of history either (Selenium Grid's hub uses it), but a
   * conflict there is far less likely on a working machine, and a taken port
   * fails with a sentence rather than by silently moving. An address that
   * moves is the thing this whole feature exists to avoid.
   */
  port: number;
  /**
   * Bind beyond loopback.
   *
   * Separate from `enabled` because they are different decisions with
   * different consequences, and refuses to turn on while no key exists.
   */
  lan: boolean;
  /** Answer CORS preflights, so a page in a browser can call Karen. */
  cors: boolean;
  /** Start serving when Karen opens. */
  startOnLaunch: boolean;
  /**
   * Load the model a request asks for, if it is not the one already loaded.
   *
   * What makes Karen usable from an app where you pick a model in a dropdown:
   * without it, every client is stuck with whatever was last chosen in Karen's
   * own window.
   *
   * Restricted to models already downloaded. A request naming something Karen
   * does not have is an error, never a download -- `pull` stays unreachable,
   * so no API client can spend the user's disk or bandwidth.
   *
   * The cost is real and worth stating: this changes the model Karen's own
   * chat window is using, which is why it is a switch and not a constant.
   */
  loadOnDemand: boolean;
  keys: ApiKey[];
}

export const API_DEFAULTS: ApiConfig = {
  enabled: false,
  port: 4444,
  lan: false,
  cors: false,
  startOnLaunch: false,
  loadOnDemand: true,
  keys: [],
};

/** Ports below 1024 need privileges Karen does not have and must not want. */
export function validPort(port: unknown): boolean {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * Merge a stored config over the defaults, dropping anything malformed.
 *
 * A hand-edited or partially-written `api.json` must not be able to turn the
 * server on, publish it to the network, or produce a key list that is not an
 * array. Every field is checked rather than spread, because this file decides
 * whether a socket opens.
 */
export function mergeApiConfig(stored: unknown): ApiConfig {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Partial<ApiConfig>;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    enabled: bool(raw.enabled, API_DEFAULTS.enabled),
    port: validPort(raw.port) ? (raw.port as number) : API_DEFAULTS.port,
    lan: bool(raw.lan, API_DEFAULTS.lan),
    cors: bool(raw.cors, API_DEFAULTS.cors),
    startOnLaunch: bool(raw.startOnLaunch, API_DEFAULTS.startOnLaunch),
    loadOnDemand: bool(raw.loadOnDemand, API_DEFAULTS.loadOnDemand),
    keys: Array.isArray(raw.keys) ? raw.keys.filter(isKey) : [],
  };
}

function isKey(v: unknown): v is ApiKey {
  if (!v || typeof v !== "object") return false;
  const k = v as Partial<ApiKey>;
  return (
    typeof k.id === "string" &&
    typeof k.label === "string" &&
    typeof k.hash === "string" &&
    k.hash.length === 64
  );
}

/**
 * Whether a configuration may actually open a socket, and why not.
 *
 * The rule that matters: no key, no server. An unauthenticated endpoint on
 * loopback is already a hole -- any process on the machine can reach it -- and
 * on a LAN it is an open model server on someone's office network.
 */
export function refuseReason(config: ApiConfig): string | undefined {
  if (!config.keys.length) {
    return "Create a key first — Karen will not serve without one.";
  }
  if (!validPort(config.port)) {
    return `Port ${String(config.port)} is not usable. Choose a port between 1024 and 65535.`;
  }
  return undefined;
}

/** The address to show and to copy, for a given binding. */
export function baseUrl(config: ApiConfig, host = "127.0.0.1"): string {
  return `http://${host}:${config.port}`;
}
