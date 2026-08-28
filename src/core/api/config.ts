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
   * 1234 because a great many tutorials hardcode `localhost:1234/v1`, and
   * drop-in compatibility is worth more here than originality.
   *
   * It is also LM Studio's port, so it will be taken if LM Studio is running.
   * That is handled by failing with a sentence that says so, not by picking a
   * different port silently -- an address that moves is the thing this whole
   * feature exists to avoid.
   *
   * Ollama's 11434 is deliberately not the default: taking it would break the
   * user's Ollama, which is a rude thing for a tool to do on first run.
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
   * Record request and response bodies in the log.
   *
   * Off, and labelled for what it is: bodies are prompts. Kept in memory only,
   * like the rest of the log.
   */
  logBodies: boolean;
  keys: ApiKey[];
}

export const API_DEFAULTS: ApiConfig = {
  enabled: false,
  port: 1234,
  lan: false,
  cors: false,
  startOnLaunch: false,
  logBodies: false,
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
    logBodies: bool(raw.logBodies, API_DEFAULTS.logBodies),
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
