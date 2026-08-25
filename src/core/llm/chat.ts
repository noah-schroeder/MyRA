/**
 * The one place the application talks to a language model.
 *
 * v1 spawned `pi --mode json --print --no-session --offline --no-extensions
 * --no-skills --no-tools` for every reasoning stage. With all of that switched
 * off, pi was doing nothing but POSTing a prompt and parsing the reply, so this
 * module replaces it outright. The exported surface is deliberately identical
 * to the old subagent's -- the seven research stages import it unchanged.
 *
 * Nothing here knows about Electron. It is reachable from tests with no
 * display, no keyring, and no `pi` binary on PATH.
 */

import { ConfigStore, type EndpointSettings } from "../config.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One tool call the model asked for. `arguments` is a JSON string, per the wire format. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that asked for tools. */
  tool_calls?: ToolCall[];
  /** Present on tool messages: which call this is the result of. */
  tool_call_id?: string;
  /** Present on tool messages: the tool's name, which some servers require. */
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export class LlmError extends Error {
  override readonly name = "LlmError";
  /** Explicit field rather than a constructor parameter property: these files
   *  are loaded by type-stripping, and parameter properties are real emit. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Accepts both `http://host:1234` and `http://host:1234/v1`.
 *
 * Users paste whichever their server printed at startup, and appending /v1 to a
 * URL that already ends in it produces a 404 that reads like the model is down.
 */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  temperature: number;
  stream: boolean;
  tools?: ToolSchema[];
  tool_choice?: "auto";
}

/**
 * The request body, built as a pure function so it can be asserted without a
 * server. Replaces v1's `buildArgs`, which served the same purpose for pi's
 * command line.
 *
 * The model string is passed through untouched. It is tempting to strip a
 * leading "provider/" the way pi's dropdown formatted it, but real model ids
 * contain slashes -- "meta-llama/Llama-3-8B" is the name the server knows.
 */
export function buildRequest(opts: {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: ToolSchema[];
}): ChatRequest {
  return {
    ...(opts.model ? { model: opts.model } : {}),
    messages: opts.messages,
    // Extraction and screening are not creative tasks, and a warm model
    // invents owners for action items nobody volunteered for.
    temperature: opts.temperature ?? 0.2,
    stream: opts.stream ?? false,
    // Omitted entirely when there are none: some OpenAI-compatible servers
    // reject an empty `tools` array rather than treating it as "no tools".
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" as const } : {}),
  };
}

export interface ChatOptions {
  endpoint: EndpointSettings;
  messages: ChatMessage[];
  apiKey?: string;
  temperature?: number;
  signal?: AbortSignal;
  /** Receives text as it arrives. Providing it switches the request to SSE. */
  onDelta?: (delta: string) => void;
  tools?: ToolSchema[];
}

export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  /** Tools the model asked for. Empty unless tools were offered. */
  toolCalls: ToolCall[];
  /** Why the model stopped, when the server says. */
  finishReason?: string;
}

const EMPTY_USAGE: ChatUsage = { input: 0, output: 0, total: 0 };

function usageFrom(raw: unknown): ChatUsage {
  const u = raw as
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  return { input, output, total: u?.total_tokens ?? input + output };
}

/** One chat completion. Streams when `onDelta` is supplied, otherwise not. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const { endpoint } = opts;
  if (!endpoint.baseUrl) {
    throw new LlmError("No LLM endpoint is configured. Set one in Settings → Endpoints.");
  }

  const timeoutMs = endpoint.timeoutMs || 120_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const streaming = typeof opts.onDelta === "function";

  let res: Response;
  try {
    res = await fetch(chatUrl(endpoint.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(
        buildRequest({
          ...(endpoint.model ? { model: endpoint.model } : {}),
          messages: opts.messages,
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          stream: streaming,
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
        }),
      ),
      signal,
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new LlmError(
        `The LLM endpoint did not answer within ${timeoutMs / 1000}s. ` +
          `A long meeting or a large synthesis may simply need a longer timeout in Settings.`,
      );
    }
    throw new LlmError(
      `Could not reach the LLM endpoint at ${endpoint.baseUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 400).trim();
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        `The LLM endpoint rejected the API key (${res.status}). Check it in Settings.`,
        res.status,
      );
    }
    throw new LlmError(
      `The LLM endpoint failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
      res.status,
    );
  }

  const result = streaming
    ? await readStream(res, opts.onDelta!)
    : await readWhole(res);

  // A reply with no text but a tool call is not empty -- it is the normal shape
  // of a turn that decided to use a tool before saying anything.
  if (!result.text.trim() && result.toolCalls.length === 0) {
    throw new LlmError("The LLM endpoint returned an empty reply.");
  }
  return result;
}

async function readWhole(res: Response): Promise<ChatResult> {
  const body = (await res.json().catch(() => undefined)) as
    | {
        choices?: {
          message?: { content?: unknown; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }[];
        usage?: unknown;
        error?: { message?: string };
      }
    | undefined;
  if (body?.error?.message) throw new LlmError(body.error.message);
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  return {
    text: typeof content === "string" ? content : "",
    usage: usageFrom(body?.usage),
    toolCalls: choice?.message?.tool_calls ?? [],
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
  };
}

/**
 * Server-sent events, split on "\n\n" only.
 *
 * The same framing discipline v1 needed for pi's JSONL applies here: a chunk
 * boundary lands mid-event often enough that parsing per-read desynchronises
 * on the first long reply. Buffer until a real separator appears.
 */
async function readStream(res: Response, onDelta: (d: string) => void): Promise<ChatResult> {
  if (!res.body) throw new LlmError("The LLM endpoint returned no response body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = EMPTY_USAGE;
  let finishReason: string | undefined;
  /* Tool calls arrive spread across frames, keyed by an index rather than by id:
   * the first frame carries the id and name, later ones append argument
   * fragments. Accumulate by index or the arguments arrive as JSON confetti. */
  const partial = new Map<number, { id: string; name: string; args: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed: {
          choices?: {
            delta?: {
              content?: unknown;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string;
          }[];
          usage?: unknown;
          error?: { message?: string };
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          // A malformed frame is not worth failing the whole stage over; the
          // next one usually carries the same content.
          continue;
        }
        if (parsed.error?.message) throw new LlmError(parsed.error.message);
        if (parsed.usage) usage = usageFrom(parsed.usage);
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
          onDelta(delta);
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const acc = partial.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) acc.id = call.id;
          if (call.function?.name) acc.name = call.function.name;
          if (call.function?.arguments) acc.args += call.function.arguments;
          partial.set(index, acc);
        }
      }
    }
  }
  const toolCalls: ToolCall[] = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      type: "function" as const,
      function: { name: acc.name, arguments: acc.args },
    }))
    .filter((c) => c.function.name);

  return { text, usage, toolCalls, ...(finishReason ? { finishReason } : {}) };
}

// ---------------------------------------------------------------------------
// Subagent surface -- unchanged signatures, so the research stages need no edit
// ---------------------------------------------------------------------------

/**
 * Milliseconds of total silence before a stage is considered wedged.
 *
 * A long synthesis legitimately thinks for minutes, so this is generous; the
 * point is that a genuinely dead endpoint fails rather than blocking for ever.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;
const MAX_ATTEMPTS = 3;

export interface SubagentOptions {
  /** Model id exactly as the server knows it. Overrides the configured one. */
  model: string;
  prompt: string;
  /** Extra system prompt, prepended as a system message. */
  system?: string;
  /** Present for signature compatibility. Subagents have no tools, by design. */
  tools?: string[];
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** Present for signature compatibility with the v1 process-based runner. */
  cwd?: string;
  onProgress?: (note: string) => void;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
  /** Overrides the configured endpoint. Tests use this; the app does not. */
  endpoint?: EndpointSettings;
  apiKey?: string;
}

export type SubagentUsage = ChatUsage;

export interface SubagentResult {
  text: string;
  usage: SubagentUsage;
  /** How many times the request had to be retried. Non-zero is worth surfacing. */
  retries: number;
  model: string;
  durationMs: number;
}

export class SubagentError extends Error {
  override readonly name = "SubagentError";
  readonly stderr: string | undefined;
  constructor(message: string, stderr?: string) {
    super(message);
    this.stderr = stderr;
  }
}

/** Resolves the endpoint a stage should use. Overridable so tests need no disk. */
let endpointResolver: () => Promise<{ endpoint: EndpointSettings; apiKey?: string }> = async () => {
  const store = new ConfigStore();
  const settings = await store.load();
  return { endpoint: settings.llm };
};

/**
 * Point every stage somewhere else.
 *
 * Used by the bundled runtime: when Karen is serving a model itself, the
 * address and key are known only to the main process and change on every
 * launch, so reading them from settings on disk would find a stale port. The
 * research stages have to follow chat to the same server, or a run would talk
 * to a different model than the conversation that started it.
 */
export function setEndpointResolver(
  fn: (() => Promise<{ endpoint: EndpointSettings; apiKey?: string }>) | undefined,
): void {
  endpointResolver = fn ?? (async () => {
    const store = new ConfigStore();
    const settings = await store.load();
    return { endpoint: settings.llm };
  });
}


function retryable(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.status === undefined) return true; // transport failure
  return err.status === 429 || err.status >= 500;
}

/**
 * Run one reasoning stage and return its text.
 *
 * Deliberately strict, exactly as in v1: a stage that errored, timed out, or
 * produced no text is a failure the run must see, not an empty string quietly
 * carried forward into the next stage.
 */
export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const started = Date.now();
  const resolved = opts.endpoint
    ? { endpoint: opts.endpoint, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) }
    : await endpointResolver();

  const idle = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const endpoint: EndpointSettings = {
    ...resolved.endpoint,
    ...(opts.model ? { model: opts.model } : {}),
    ...(idle > 0 ? { timeoutMs: idle } : {}),
  };

  const messages: ChatMessage[] = [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    { role: "user" as const, content: opts.prompt },
  ];

  let retries = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      retries++;
      opts.onProgress?.(`retrying (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    try {
      const result = await chat({
        endpoint,
        messages,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onDelta ? { onDelta: (d: string) => opts.onDelta!(d, "text") } : {}),
      });
      return {
        text: result.text,
        usage: result.usage,
        retries,
        model: opts.model,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted || !retryable(err)) break;
    }
  }

  throw new SubagentError(
    `Stage failed after ${retries + 1} attempt(s): ${(lastError as Error)?.message ?? "unknown error"}`,
  );
}

/**
 * Every stage that returns data asks for JSON, and models reliably wrap it:
 * a fenced block, a sentence of preamble, a cheerful sign-off afterwards.
 * Failing the stage over that would be brittle, so find the value instead --
 * but scan with a real bracket matcher rather than a regex, because a brace
 * inside a quoted string is not a brace.
 */
export function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const haystack = fenced?.[1] ?? text;

  for (let i = 0; i < haystack.length; i++) {
    const open = haystack[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < haystack.length; j++) {
      const ch = haystack[j]!;
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return haystack.slice(i, j + 1);
    }
  }
  return undefined;
}

export function parseJsonReply<T>(text: string, what = "reply"): T {
  const raw = extractJson(text);
  if (!raw) {
    throw new SubagentError(`${what} contained no JSON:\n${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new SubagentError(`${what} contained malformed JSON (${(err as Error).message})`);
  }
}
