/**
 * Karen's wire envelope: one authenticated WebSocket carrying three channels.
 *
 * The VM always dials the host (QEMU SLIRP user networking lets the guest reach
 * 10.0.2.2, but the host cannot reach the guest without hostfwd). So the host
 * listens and the VM connects, and both directions then share this one socket.
 */

import type { PiOutbound, PiFrame } from "./pi-rpc.ts";
import type { PermissionMode, PolicyVerdict, RiskClass } from "./policy.ts";

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Host verbs — the complete set of things the agent may ask the host  *
 * to do. Anything not on this list is rejected outright.              *
 *                                                                     *
 * Note what is absent by design: there is no generic shell verb and    *
 * no general filesystem write. Document work happens in the VM, and    *
 * files reach the host only via a save dialog the user initiates.      *
 * ------------------------------------------------------------------ */

export const HOST_VERBS = [
  "calendar.list",
  "calendar.propose_event",
  "contacts.search",
  "planify.list",
  "planify.propose",
  "notify",
  "vault.read",
  "vault.write",
  "clipboard.read",
  "clipboard.write",
] as const;

export type HostVerb = (typeof HOST_VERBS)[number];

export function isHostVerb(v: string): v is HostVerb {
  return (HOST_VERBS as readonly string[]).includes(v);
}

/**
 * Static risk classification per host verb.
 *
 * `vault.write` is `write`, not `system_of_record`: it is jailed to a dedicated
 * subtree that acts as the agent's output drop, and merely happens to live on
 * the host so reports appear where the user will see them. Writes outside that
 * jail are rejected by the broker rather than reclassified.
 */
export const HOST_VERB_RISK: Record<HostVerb, RiskClass> = {
  "calendar.list": "safe",
  "contacts.search": "safe",
  "planify.list": "safe",
  notify: "safe",
  "vault.read": "safe",
  "vault.write": "write",
  "calendar.propose_event": "system_of_record",
  "planify.propose": "system_of_record",
  "clipboard.read": "system_of_record",
  "clipboard.write": "system_of_record",
};

/* ------------------------------------------------------------------ *
 * Channels                                                            *
 * ------------------------------------------------------------------ */

/** pi RPC, forwarded verbatim. Host -> VM carries commands, VM -> host events. */
export interface RpcFrame {
  ch: "rpc";
  payload: PiOutbound | PiFrame;
}

/** A host action request travelling VM -> host. */
export interface ActionRequestFrame {
  ch: "action";
  id: string;
  verb: string;
  args: Record<string, unknown>;
}

/** Its result travelling host -> VM. */
export interface ActionResultFrame {
  ch: "action";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** How the broker decided, echoed back for the agent's own logging. */
  verdict?: PolicyVerdict;
}

export type CtlOp =
  | "hello"
  | "health"
  | "secrets"
  | "get_models"
  | "write_models"
  | "probe_models"
  | "set_mode"
  | "refresh_secrets"
  | "get_state"
  | "list_sessions"
  | "set_research"
  | "set_policy"
  | "get_search_categories"
  /** Pause the newest research run at its next stage boundary. */
  | "pause_research"
  | "list_sessions"
  /** Delete one session and the research runs it started. */
  | "delete_session"
  | "delete_all_sessions";

/**
 * How the research tools behave, chosen in the GUI rather than by the model.
 *
 * The mode decides which research tool the model can reach at all, and the
 * category is FORCED rather than suggested -- a control the model can quietly
 * override is not a control. `category` is a SearXNG category name, so it
 * follows whatever engines the user configured for it.
 */
/**
 * Where embeddings come from.
 *
 * Separate from the chat endpoint on purpose: an embedding model is usually a
 * different process on a different port -- llama.cpp serves one model per
 * server -- and it answers /embeddings rather than /chat/completions. Assuming
 * one base URL for both is the common way this breaks.
 *
 * Carries only the NAME of the env var holding the key, never the key: the
 * value reaches the VM through the secrets channel and lives in pi's process
 * environment alone.
 */
export interface EmbeddingsConfig {
  baseUrl: string;
  envVar: string;
  model: string;
}

export interface ResearchConfig {
  mode: "off" | "web" | "deep";
  /**
   * One or more SearXNG categories, comma-separated -- SearXNG's own wire
   * format, verified to work against a live instance. Kept as a string rather
   * than an array so it survives a round trip through the editable research
   * plan, where the user can type `category: science, news` by hand.
   */
  category: string;
  timeRange?: "" | "day" | "week" | "month" | "year";
  embeddings?: EmbeddingsConfig;
}

export const DEFAULT_RESEARCH: ResearchConfig = { mode: "off", category: "general" };

/**
 * What the VM needs in order to enforce the permission matrix itself.
 *
 * The host broker polices its own verbs, but pi's BUILT-IN tools -- bash, write,
 * edit -- never touch the broker. Their only enforcement point is inside the VM,
 * so the mode has to travel there and stay current: pushed on every change, not
 * just read once at handshake.
 */
export interface PolicyConfig {
  mode: PermissionMode;
  /** Writes inside this stay `write`; outside it they are `dangerous`. */
  workspaceRoot: string;
}

/** Splits the stored form into distinct, trimmed, non-empty category names. */
export function parseCategories(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** The inverse: the canonical stored form for a set of categories. */
export function formatCategories(list: readonly string[]): string {
  return parseCategories(list.join(",")).join(",");
}

export interface CtlRequestFrame {
  ch: "ctl";
  id: string;
  op: CtlOp;
  args?: Record<string, unknown>;
}

export interface CtlResultFrame {
  ch: "ctl";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type KarenFrame =
  | RpcFrame
  | ActionRequestFrame
  | ActionResultFrame
  | CtlRequestFrame
  | CtlResultFrame;

/* ------------------------------------------------------------------ *
 * Handshake                                                           *
 * ------------------------------------------------------------------ */

/** First frame the VM sends after connecting. Rejected unless the token matches. */
export interface HelloPayload {
  protocolVersion: number;
  token: string;
  bridgeVersion: string;
  piVersion?: string;
}

export interface HelloAck {
  protocolVersion: number;
  mode: PermissionMode;
  /** Workspace root the agent may write to freely, inside the VM. */
  workspaceRoot: string;
}

/* ------------------------------------------------------------------ *
 * Secrets                                                             *
 * ------------------------------------------------------------------ */

/**
 * Delivered to the bridge after the handshake and injected into pi's process
 * environment only. The bridge must never write these to disk, so that the VM
 * holds no API keys at rest.
 */
export interface SecretsPayload {
  env: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * Model configuration                                                 *
 * ------------------------------------------------------------------ */

/** Mirrors an entry in pi's ~/.pi/agent/models.json. */
export interface ModelSpec {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ProviderSpec {
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** An env-var reference such as "$KAREN_LLM_KEY" — never a literal secret. */
  apiKey: string;
  models: ModelSpec[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderSpec>;
}

export function isEnvRef(apiKey: string): boolean {
  return apiKey.startsWith("$");
}

/* ------------------------------------------------------------------ *
 * Type guards                                                         *
 * ------------------------------------------------------------------ */

export function isRpcFrame(f: KarenFrame): f is RpcFrame {
  return f.ch === "rpc";
}

export function isActionRequest(f: KarenFrame): f is ActionRequestFrame {
  return f.ch === "action" && "verb" in f;
}

export function isActionResult(f: KarenFrame): f is ActionResultFrame {
  return f.ch === "action" && "ok" in f;
}

export function isCtlRequest(f: KarenFrame): f is CtlRequestFrame {
  return f.ch === "ctl" && "op" in f;
}

export function isCtlResult(f: KarenFrame): f is CtlResultFrame {
  return f.ch === "ctl" && "ok" in f;
}
