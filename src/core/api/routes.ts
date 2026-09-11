/**
 * What another app may reach through MyRA, and nothing else.
 *
 * ## Why this file exists at all
 *
 * Lemonade's own API key has no scopes. Measured against `lemond` 11.8.0 with
 * a valid key, every one of these succeeded:
 *
 *     POST   /api/v1/install          200   installed a backend
 *     POST   /api/v1/unload           200   unloaded the running model
 *     POST   /api/v1/pull             400   routed
 *     DELETE /api/v1/models/<id>      404   routed
 *
 * So giving another app the daemon's key would give it the power to install
 * runtimes, download gigabytes, delete models, and unload the model the user
 * is talking to. MyRA therefore never shares that key; it runs a gateway that
 * accepts its own keys and forwards only the paths below.
 *
 * ## Why it is a table and not a chain of ifs
 *
 * This is the security boundary of the whole feature. A table can be asserted
 * against in a test that fails the day someone adds `/api/v1/install` to it;
 * a chain of conditionals scattered through a request handler cannot.
 *
 * **Default deny.** A path absent from this list is 404, including every path
 * Lemonade grows in a version MyRA has not seen.
 */

/** Which client ecosystem a route belongs to, for the UI's setup snippets. */
export type Dialect = "openai" | "ollama" | "anthropic" | "myra";

export interface Route {
  method: "GET" | "POST";
  /** Exact path, matched after the query string is stripped. */
  path: string;
  dialect: Dialect;
  /** What it does, in the words the API page uses. */
  what: string;
  /**
   * Answered by MyRA rather than forwarded.
   *
   * Two routes qualify: `/health`, which must work without a key so a client
   * can probe, and the model lists, which are filtered so a client is not
   * offered 228 catalogue entries it cannot load.
   */
  local?: boolean;
  /** Reachable without a key. Only ever `/health`. */
  open?: boolean;
  /** Request and response bodies are not JSON; stream them through untouched. */
  binary?: boolean;
}

/**
 * The exposed surface.
 *
 * Three dialects because Lemonade answers three, all verified against the
 * daemon: OpenAI, Ollama (`/api/tags` returns an Ollama-shaped model list) and
 * Anthropic (`/v1/messages`). A path-allowlisting proxy gets all three for the
 * same effort as one, which is the difference between serving OpenAI clients
 * and serving anything a person already has.
 */
export const ROUTES: readonly Route[] = [
  // ---- MyRA's own ----
  { method: "GET", path: "/health", dialect: "myra", what: "Whether MyRA is serving", local: true, open: true },

  // ---- OpenAI ----
  { method: "GET", path: "/v1/models", dialect: "openai", what: "List models", local: true },
  { method: "POST", path: "/v1/chat/completions", dialect: "openai", what: "Chat" },
  { method: "POST", path: "/v1/completions", dialect: "openai", what: "Text completion" },
  { method: "POST", path: "/v1/responses", dialect: "openai", what: "Responses API" },
  { method: "POST", path: "/v1/embeddings", dialect: "openai", what: "Embeddings" },
  { method: "POST", path: "/v1/audio/transcriptions", dialect: "openai", what: "Transcribe audio", binary: true },
  { method: "POST", path: "/v1/audio/speech", dialect: "openai", what: "Speak text", binary: true },
  { method: "POST", path: "/v1/images/generations", dialect: "openai", what: "Generate an image" },
  { method: "POST", path: "/v1/reranking", dialect: "openai", what: "Rerank passages" },

  // ---- Anthropic ----
  { method: "POST", path: "/v1/messages", dialect: "anthropic", what: "Chat" },

  // ---- Ollama ----
  { method: "GET", path: "/api/tags", dialect: "ollama", what: "List models", local: true },
  { method: "GET", path: "/api/version", dialect: "ollama", what: "Server version" },
  { method: "POST", path: "/api/chat", dialect: "ollama", what: "Chat" },
  { method: "POST", path: "/api/generate", dialect: "ollama", what: "Text completion" },
  { method: "POST", path: "/api/embed", dialect: "ollama", what: "Embeddings" },
  { method: "POST", path: "/api/show", dialect: "ollama", what: "Model detail" },
  { method: "GET", path: "/api/ps", dialect: "ollama", what: "What is loaded" },
];

/**
 * Paths that must never be reachable, asserted in the tests.
 *
 * Redundant with default-deny, and deliberately so. This list is the statement
 * of intent; default-deny is the mechanism. A test reads both, so adding one of
 * these to `ROUTES` fails loudly rather than quietly widening what a leaked key
 * can do.
 */
export const NEVER_EXPOSED: readonly string[] = [
  "/api/v1/install",
  "/api/v1/pull",
  "/api/v1/load",
  "/api/v1/unload",
  "/api/v1/models/register",
  "/api/v1/system-info",
  "/api/v1/system-stats",
  "/api/v1/system-checks",
  "/api/v1/downloads",
  "/api/v1/stats",
  "/api/v1/health",
  "/realtime",
  "/api/create",
  "/api/copy",
  "/api/delete",
  "/api/push",
  "/api/pull",
  "/api/blobs",
];

/** The path a request is for, with its query string and trailing slash gone. */
export function normalisePath(url: string): string {
  const path = (url.split("?")[0] ?? "").trim();
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path || "/";
}

/**
 * The route for a request, or nothing.
 *
 * Exact matching only. No prefixes and no patterns: `/api/v1/models/(.+)` is a
 * real Lemonade route that would let `DELETE /api/v1/models/x` through a
 * careless prefix match, and there is nothing here that needs a pattern.
 */
export function routeFor(method: string, url: string): Route | undefined {
  const path = normalisePath(url);
  const verb = method.toUpperCase();
  return ROUTES.find((r) => r.method === verb && r.path === path);
}

/** Every dialect that has at least one route, for the setup snippets. */
export function dialects(): Dialect[] {
  return [...new Set(ROUTES.map((r) => r.dialect))].filter((d) => d !== "myra");
}
