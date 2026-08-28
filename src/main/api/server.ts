/**
 * Karen's gateway: the first thing in this application that listens.
 *
 * It accepts Karen's own keys, forwards only the paths in `core/api/routes.ts`,
 * and swaps in Lemonade's key on the way through. The two key spaces never
 * meet: a client never learns the daemon's key, so a leaked Karen key cannot
 * reach `/api/v1/install` even if the gateway's allowlist were bypassed at the
 * routing layer.
 *
 * Everything else in Karen is outbound-only, behind a default-deny filter on
 * the renderer. A listening socket is a real change to the threat model, which
 * is why the switch is off by default, why it binds loopback unless told
 * otherwise, why it refuses to start without a key, and why the allowlist is
 * data rather than control flow.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { baseUrl, refuseReason, type ApiConfig } from "../../core/api/config.ts";
import { bearerFrom, findKey, type ApiKey } from "../../core/api/keys.ts";
import { modelFrom, usageFrom, RequestLog } from "../../core/api/log.ts";
import { routeFor, type Route } from "../../core/api/routes.ts";

/** Where to forward to, resolved per request so a restart is picked up. */
export interface Upstream {
  baseUrl: string;
  apiKey: string;
}

export interface GatewayOptions {
  config: () => ApiConfig;
  /** Lemonade, or nothing when it is not running. */
  upstream: () => Upstream | undefined;
  /** The models a client may be told about. */
  models: () => Promise<{ id: string; loaded: boolean }[]>;
  /** Load a downloaded model, for `loadOnDemand`. */
  loadModel: (id: string) => Promise<void>;
  log: RequestLog;
  /** Persist a key's usage counters. Called at most once per request. */
  onKeyUsed?: (keyId: string) => void;
}

export interface GatewayStatus {
  listening: boolean;
  port?: number | undefined;
  host?: string | undefined;
  url?: string | undefined;
  error?: string | undefined;
}

/* A generation can legitimately run for a long time on a slow machine with a
   large model, so the socket must not be closed under it. Node's default of
   two minutes is far too short for a 32k-token prompt on CPU. */
const SOCKET_TIMEOUT_MS = 0;

export class ApiGateway {
  #server: Server | undefined;
  #status: GatewayStatus = { listening: false };
  #listeners = new Set<(s: GatewayStatus) => void>();
  /** Abort handles for requests still in flight, so the UI can cancel one. */
  #inflight = new Map<string, AbortController>();
  #opts: GatewayOptions;
  /**
   * Serialises on-demand loads.
   *
   * Two clients asking for two different models at the same moment would
   * otherwise issue two overlapping loads, and Lemonade holds one model: the
   * pair would fight, and both requests could run against whichever won. The
   * chain makes the second wait for the first, after which its own check sees
   * the real state.
   */
  #loading: Promise<unknown> = Promise.resolve();

  constructor(opts: GatewayOptions) {
    this.#opts = opts;
  }

  get status(): GatewayStatus {
    return this.#status;
  }

  onChange(fn: (s: GatewayStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(patch: Partial<GatewayStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const fn of this.#listeners) fn(this.#status);
  }

  /** Cancel one in-flight request, which also aborts it upstream. */
  cancel(id: string): boolean {
    const controller = this.#inflight.get(id);
    if (!controller) return false;
    controller.abort();
    this.#opts.log.update(id, { state: "cancelled" });
    return true;
  }

  async start(): Promise<GatewayStatus> {
    await this.stop();
    const config = this.#opts.config();

    const refusal = refuseReason(config);
    if (refusal) {
      this.#set({ listening: false, error: refusal });
      return this.#status;
    }

    const host = config.lan ? "0.0.0.0" : "127.0.0.1";
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
        else res.end();
      });
    });
    server.timeout = SOCKET_TIMEOUT_MS;
    server.headersTimeout = 0;
    server.requestTimeout = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      /* The likely failure, and worth saying in words: 1234 is LM Studio's
         port. A person running both should be told which program to look at,
         not shown EADDRINUSE. */
      const known: Record<number, string> = {
        1234: "LM Studio uses 1234",
        11434: "Ollama uses 11434",
        4444: "Selenium Grid uses 4444",
      };
      const culprit = known[config.port];
      const message =
        code === "EADDRINUSE"
          ? `Something else is already using port ${String(config.port)}.` +
            (culprit ? ` ${culprit} by default — close it, or choose another port here.` : " Choose another port here.")
          : code === "EACCES"
            ? `Port ${String(config.port)} needs privileges Karen does not have. Choose a port above 1024.`
            : (err as Error).message;
      this.#set({ listening: false, error: message });
      return this.#status;
    }

    this.#server = server;
    this.#set({
      listening: true,
      port: config.port,
      host,
      url: baseUrl(config),
      error: undefined,
    });
    return this.#status;
  }

  async stop(): Promise<void> {
    for (const [, controller] of this.#inflight) controller.abort();
    this.#inflight.clear();
    const server = this.#server;
    this.#server = undefined;
    if (!server) {
      this.#set({ listening: false, url: undefined, port: undefined });
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    /* `close` waits for open connections, and a streaming client may never
       hang up. `closeAllConnections` is what makes stop actually stop. */
    server.closeAllConnections?.();
    this.#set({ listening: false, url: undefined, port: undefined });
  }

  /* ------------------------------------------------------------ requests -- */

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.#opts.config();
    if (config.cors) setCors(res);

    if (req.method === "OPTIONS") {
      /* Answered whether or not CORS is on: without it a browser client gets
         a bare hang rather than a refusal it can report. */
      res.writeHead(config.cors ? 204 : 405).end();
      return;
    }

    const route = routeFor(req.method ?? "GET", req.url ?? "/");
    if (!route) {
      // Default deny. Deliberately says nothing about what does exist.
      sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      return;
    }

    let key: ApiKey | undefined;
    if (!route.open) {
      const presented = bearerFrom(req.headers as Record<string, string | string[] | undefined>);
      key = presented ? findKey(config.keys, presented) : undefined;
      if (!key) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="Karen"');
        sendJson(res, 401, {
          error: {
            message: "Provide a Karen API key. Create one in Karen under API → Keys.",
            type: "authentication_error",
          },
        });
        return;
      }
      this.#opts.onKeyUsed?.(key.id);
    }

    if (route.local) {
      await this.#answerLocally(route, res);
      return;
    }
    await this.#proxy(route, req, res, key, config);
  }

  /** `/health` and the model lists, which Karen answers rather than forwards. */
  async #answerLocally(route: Route, res: ServerResponse): Promise<void> {
    if (route.path === "/health") {
      const up = this.#opts.upstream();
      sendJson(res, 200, { status: up ? "ok" : "no model loaded", serving: Boolean(up) });
      return;
    }

    const models = await this.#opts.models().catch(() => []);
    if (route.dialect === "ollama") {
      sendJson(res, 200, {
        models: models.map((m) => ({
          name: m.id,
          model: m.id,
          // Ollama clients read these; absent values break some of them.
          modified_at: new Date().toISOString(),
          size: 0,
          details: { family: "llama", format: "gguf", parameter_size: "", quantization_level: "" },
        })),
      });
      return;
    }
    sendJson(res, 200, {
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "karen" })),
    });
  }

  /**
   * Load the model a request asked for, when it is not the one already loaded.
   *
   * Only models already downloaded, and only when the client actually named
   * one. A request for something Karen does not have is answered with the list
   * of what it does have -- never with a download, because `pull` is not
   * reachable through this gateway and a client must not be able to spend the
   * user's bandwidth.
   */
  async #ensureModel(wanted: string | undefined): Promise<string | undefined> {
    if (!wanted) return undefined;
    const attempt = this.#loading.then(async () => {
      const models = await this.#opts.models().catch(() => []);
      const match = models.find((m) => m.id === wanted);
      if (!match) {
        const names = models.map((m) => m.id).slice(0, 8).join(", ");
        return `Karen does not have a model called ${JSON.stringify(wanted)}. ` +
          `Downloaded models: ${names || "none"}. Download it in Karen first.`;
      }
      if (match.loaded) return undefined;
      await this.#opts.loadModel(wanted);
      return undefined;
    });
    // Kept as the tail of the chain whether it resolved or threw.
    this.#loading = attempt.catch(() => undefined);
    try {
      return await attempt;
    } catch (err) {
      return `Karen could not load ${JSON.stringify(wanted)}: ${(err as Error).message}`;
    }
  }

  /**
   * Forward a request to Lemonade and stream the answer back.
   *
   * The disconnect handling below is the part most likely to be wrong, and the
   * most expensive if it is: if the upstream fetch is not aborted when the
   * client hangs up, Lemonade keeps generating into a closed socket and holds
   * a slot until it hits the token limit. A handful of abandoned `curl`
   * sessions would exhaust the server, and every later request would queue
   * behind requests nobody is waiting for.
   */
  async #proxy(
    route: Route,
    req: IncomingMessage,
    res: ServerResponse,
    key: ApiKey | undefined,
    config: ApiConfig,
  ): Promise<void> {
    /* Read the body before resolving the upstream: with load-on-demand the
       model named in it decides which model the upstream will be serving. */
    const body = route.binary ? req : await readBody(req);
    const bodyText = typeof body === "string" ? body : undefined;
    const wanted = modelFrom(bodyText);

    if (config.loadOnDemand && wanted) {
      const problem = await this.#ensureModel(wanted);
      if (problem) {
        sendJson(res, 404, { error: { message: problem, type: "model_not_found" } });
        return;
      }
    }

    const upstream = this.#opts.upstream();
    if (!upstream) {
      sendJson(res, 503, {
        error: {
          message: config.loadOnDemand
            ? "No model is loaded in Karen, and none was named in the request."
            : "No model is loaded in Karen. Open Karen, choose a model, and try again.",
          type: "service_unavailable",
        },
      });
      return;
    }

    const id = randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    this.#inflight.set(id, controller);

    this.#opts.log.start({
      id,
      startedAt: new Date(startedAt).toISOString(),
      keyLabel: key?.label ?? "—",
      keyId: key?.id ?? "",
      method: route.method,
      path: route.path,
      dialect: route.dialect,
      ...(wanted ? { model: wanted } : {}),
      state: "open",
    });

    const finish = (patch: Parameters<RequestLog["update"]>[1]): void => {
      this.#inflight.delete(id);
      this.#opts.log.update(id, { durationMs: Date.now() - startedAt, ...patch });
    };

    // The client going away must abort the work, not merely stop reading it.
    const onClose = (): void => {
      if (this.#inflight.has(id)) {
        controller.abort();
        finish({ state: "cancelled" });
      }
    };
    res.on("close", onClose);

    try {
      const headers: Record<string, string> = {
        // Karen's key is exchanged for Lemonade's here, and only here.
        authorization: `Bearer ${upstream.apiKey}`,
      };
      const contentType = req.headers["content-type"];
      if (typeof contentType === "string") headers["content-type"] = contentType;

      /*
       * Origin plus the path exactly as the allowlist spells it.
       *
       * Not the upstream base URL with the path appended: Lemonade serves its
       * three dialects at three different roots -- `/v1/...` for OpenAI and
       * Anthropic, `/api/...` for Ollama, `/api/v1/...` for its own management
       * API -- and `chatEndpoint()` hands over the `/api/v1` one. Appending to
       * that produced `/api/api/chat` for Ollama and a non-existent
       * `/api/v1/messages` for Anthropic. Only the OpenAI chat route worked,
       * and only because it happens to exist under both roots.
       */
      const target = new URL(route.path, upstream.baseUrl).origin + route.path;
      const upstreamRes = await fetch(target, {
        method: route.method,
        headers,
        ...(route.method === "POST"
          ? {
              body: typeof body === "string" ? body : (body as unknown as ReadableStream),
              // Node requires this when the body is a stream.
              ...(route.binary ? { duplex: "half" } : {}),
            }
          : {}),
        signal: controller.signal,
      } as RequestInit);

      const firstTokenMs = Date.now() - startedAt;
      res.writeHead(upstreamRes.status, passThroughHeaders(upstreamRes));

      if (!upstreamRes.body) {
        res.end();
        finish({ state: "done", status: upstreamRes.status, firstTokenMs });
        return;
      }

      /* Collected only to read the token usage out of the final frame. Capped,
         because a long generation would otherwise be held twice: once on the
         wire and once here. */
      let tail = "";
      const reader = upstreamRes.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          // Respect backpressure, or a slow client becomes unbounded memory.
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
        tail = (tail + Buffer.from(value).toString("utf8")).slice(-8000);
      }
      res.end();

      const usage = usageFrom(tail) ;
      finish({
        state: "done",
        status: upstreamRes.status,
        firstTokenMs,
        ...(usage.prompt !== undefined ? { promptTokens: usage.prompt } : {}),
        ...(usage.completion !== undefined ? { completionTokens: usage.completion } : {}),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // Already recorded as cancelled by whichever side did the aborting.
        if (!res.writableEnded) res.end();
        this.#inflight.delete(id);
        return;
      }
      const message = (err as Error).message;
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: `Karen could not reach the model: ${message}` } });
      } else {
        res.end();
      }
      finish({ state: "error", error: message });
    } finally {
      res.off("close", onClose);
    }
  }
}

/* ------------------------------------------------------------------ helpers -- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key, api-key");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

/**
 * Headers worth passing back.
 *
 * An allowlist rather than a copy, for the same reason the routes are: the
 * upstream's `set-cookie`, or a CORS header of its own, has no business
 * reaching a client through Karen.
 */
function passThroughHeaders(upstream: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "cache-control", "transfer-encoding"]) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  out["content-type"] ??= "application/json";
  return out;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A prompt is text; 64 MB of it is not a prompt, it is a mistake.
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
