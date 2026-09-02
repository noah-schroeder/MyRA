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
import { splitThinking, type DeltaKind } from "./thinking.ts";

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
  /** Asks a streaming server to send token counts in a final chunk. */
  stream_options?: { include_usage: true };
  tools?: ToolSchema[];
  tool_choice?: "auto";
  /**
   * Sampler fields, which vary by backend.
   *
   * Open rather than enumerated because llama.cpp's set is long and grows: the
   * list of what Karen offers lives in llm/sampling.ts, where each field also
   * says whether a hosted API will accept it.
   */
  [sampler: string]: unknown;
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
  /**
   * Per-model sampler settings, already filtered for this endpoint.
   *
   * Spread LAST so a tuned temperature beats the default below — but not the
   * one a CALLER passed, because those come from tasks that must not be warm:
   * screening and extraction ask for facts, and a creative setting there
   * invents owners for action items nobody volunteered for.
   */
  sampling?: Record<string, number>;
}): ChatRequest {
  const { temperature: tuned, ...otherSampling } = opts.sampling ?? {};
  return {
    ...(opts.model ? { model: opts.model } : {}),
    messages: opts.messages,
    // Extraction and screening are not creative tasks, and a warm model
    // invents owners for action items nobody volunteered for.
    temperature: opts.temperature ?? tuned ?? 0.2,
    ...otherSampling,
    stream: opts.stream ?? false,
    /*
     * A streaming response carries no token counts unless they are asked for.
     * That is the OpenAI convention and llama.cpp follows it, which is why the
     * status bar read "0 tokens this conversation" against a working server --
     * the usage block was never sent, not lost. Only meaningful while
     * streaming, so it is only sent then.
     */
    ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
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
  /**
   * Receives text as it arrives. Providing it switches the request to SSE.
   *
   * `kind` separates the model's reasoning from its answer, so the UI can show
   * the thinking while it happens without mixing it into the reply.
   */
  onDelta?: (delta: string, kind: DeltaKind) => void;
  tools?: ToolSchema[];
  /** Sampler settings for this model, already filtered for this endpoint. */
  sampling?: Record<string, number>;
}

export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}

export interface ChatResult {
  text: string;
  /**
   * The model's reasoning, if it produced any.
   *
   * Kept out of `text` and out of the message history: it is workings on a
   * question already answered, and replaying it costs context for nothing.
   */
  reasoning?: string;
  usage: ChatUsage;
  /**
   * Reasoning tokens the server charged for but never sent the text of.
   *
   * Several hosted APIs reason and then withhold the chain, reporting only a
   * count in `completion_tokens_details.reasoning_tokens`. That is the whole
   * explanation for a reasoning model whose reasoning never appears, and it is
   * worth saying out loud: the alternative is a user who cannot tell a provider
   * that hides its thinking from an app that has dropped it.
   */
  hiddenReasoning?: number;
  /** Tools the model asked for. Empty unless tools were offered. */
  toolCalls: ToolCall[];
  /** Why the model stopped, when the server says. */
  finishReason?: string;
}

const EMPTY_USAGE: ChatUsage = { input: 0, output: 0, total: 0 };

/**
 * Reasoning tokens, when the server itemises them.
 *
 * OpenAI's field, and copied by most gateways that follow its shape. It is
 * counted inside `completion_tokens` already, so it is read separately rather
 * than added to anything -- the meter must keep reporting what the window
 * holds.
 */
function reasoningTokens(raw: unknown): number {
  const details = (raw as { completion_tokens_details?: { reasoning_tokens?: unknown } } | undefined)
    ?.completion_tokens_details;
  const n = details?.reasoning_tokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

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
  const deadline = idleDeadline(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
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
          ...(opts.sampling ? { sampling: opts.sampling } : {}),
        }),
      ),
      signal,
    });
  } catch (err) {
    // Stopping deliberately is not a timeout, and must not be described as one.
    if (opts.signal?.aborted) throw err;
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new LlmError(
        `The LLM endpoint did not respond within ${timeoutMs / 1000}s. ` +
          `A model still loading into memory can take longer than this on a first request; ` +
          `raise the timeout in Settings → Endpoints if that is what is happening.`,
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
    /*
     * Too long for the window, stated in words rather than in JSON.
     *
     * llama.cpp answers 400 with `exceed_context_size_error` and, helpfully,
     * both numbers. Summarising older messages cannot rescue this when the new
     * message alone is over the limit, so the only useful thing to do is say
     * what happened and what would fix it -- the raw body reads as a crash.
     */
    const oversize = parseOversize(body);
    if (oversize) {
      throw new LlmError(
        `That message is too long for this model. It needs about ` +
          `${oversize.needed.toLocaleString()} tokens and the model can hold ` +
          `${oversize.limit.toLocaleString()}. Send less at once, or give the model a larger ` +
          `context in Models → Configure.`,
        res.status,
      );
    }
    throw new LlmError(
      `The LLM endpoint failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
      res.status,
    );
  }

  let result: ChatResult;
  try {
    result = streaming
      ? await readStream(res, opts.onDelta!, deadline.touch)
      : await readWhole(res);
  } catch (err) {
    // The user pressing stop is not a failure to describe; let it through as it is.
    if (opts.signal?.aborted) throw err;
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new LlmError(
        `The model stopped producing output for ${timeoutMs / 1000}s and the reply was cut off. ` +
          `If it is loading a large model or thinking for a long time, raise the timeout in ` +
          `Settings → Endpoints.`,
      );
    }
    throw err;
  } finally {
    deadline.clear();
  }

  // A reply with no text but a tool call is not empty -- it is the normal shape
  // of a turn that decided to use a tool before saying anything.
  if (!result.text.trim() && result.toolCalls.length === 0) {
    throw new LlmError("The LLM endpoint returned an empty reply.");
  }
  return result;
}

/**
 * A deadline that measures silence rather than duration.
 *
 * This was `AbortSignal.timeout(timeoutMs)`, handed to `fetch` -- and a signal
 * given to fetch governs the RESPONSE BODY too, not just the wait for headers.
 * So a model that was streaming perfectly well had its answer cut off mid-token
 * at 120 seconds, and the error said "the endpoint did not answer within 120s",
 * which was not true: it had been answering the whole time. Anything slow
 * enough to matter -- a large model on CPU, a long synthesis, a 70B on a busy
 * GPU -- hit this exactly when it was working hardest.
 *
 * The useful question is not "how long has this taken" but "how long has it
 * been silent", so the timer is rearmed on every chunk that arrives. A model
 * producing tokens is never interrupted; one that has genuinely hung still
 * fails, at the same number the user configured.
 *
 * The reason is a TimeoutError so callers can tell a stall from a cancellation.
 */
function idleDeadline(ms: number): { signal: AbortSignal; touch: () => void; clear: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException(`idle for ${ms}ms`, "TimeoutError")),
      ms,
    );
    // Never hold the process open on our own account.
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    clear: () => clearTimeout(timer),
  };
}

async function readWhole(res: Response): Promise<ChatResult> {
  const body = (await res.json().catch(() => undefined)) as
    | {
        choices?: {
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
            tool_calls?: ToolCall[];
          };
          finish_reason?: string;
        }[];
        usage?: unknown;
        error?: { message?: string };
      }
    | undefined;
  if (body?.error?.message) throw new LlmError(body.error.message);
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  const raw = typeof content === "string" ? content : "";

  /* Either convention: a field beside the content, or tags inside it. Run the
     splitter over the whole string so the two paths agree on what counts as
     reasoning -- the streaming path uses the same code, frame by frame. */
  let text = "";
  let inline = "";
  const split = splitThinking((s, kind) => {
    if (kind === "thinking") inline += s;
    else text += s;
  });
  split.push(raw);
  split.flush();

  const stated = statedReasoning(choice?.message);
  const reasoning = stated || inline;
  const hidden = reasoning ? 0 : reasoningTokens(body?.usage);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(hidden ? { hiddenReasoning: hidden } : {}),
    usage: usageFrom(body?.usage),
    toolCalls: choice?.message?.tool_calls ?? [],
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
  };
}

/**
 * The names a server may hang its reasoning on.
 *
 * `reasoning_content` is llama.cpp's and DeepSeek's; `reasoning` is
 * OpenRouter's; `reasoning_details` is OpenRouter's newer structured form;
 * `thinking` and `thinking_blocks` are what gateways emit when they are
 * relaying an Anthropic-shaped reply through an OpenAI-shaped API.
 *
 * All five are read because which one arrives is a property of somebody else's
 * server, not a choice Karen gets to make -- and reading one only meant that a
 * provider using any of the others looked exactly like a provider that does no
 * reasoning at all.
 */
const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_details",
  "thinking",
  "thinking_blocks",
] as const;

/** Where the text sits inside one structured reasoning part. */
const REASONING_PART_FIELDS = ["text", "thinking", "reasoning", "content", "summary"] as const;

/**
 * Pull the reasoning text out of a delta or a message, whatever shape it took.
 *
 * Strings are taken as they are; a part or a list of parts is walked one level
 * for a string field, which is as deep as any of these formats nest. Nothing is
 * invented: a shape with no string in it yields nothing, and the caller then
 * has the honest answer that no reasoning arrived.
 */
export function statedReasoning(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  for (const field of REASONING_FIELDS) {
    const found = textOf(record[field]);
    if (found) return found;
  }
  return "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    const part = value as Record<string, unknown>;
    for (const field of REASONING_PART_FIELDS) {
      if (typeof part[field] === "string") return part[field];
    }
  }
  return "";
}

/**
 * Server-sent events, split on "\n\n" only.
 *
 * The same framing discipline v1 needed for pi's JSONL applies here: a chunk
 * boundary lands mid-event often enough that parsing per-read desynchronises
 * on the first long reply. Buffer until a real separator appears.
 */
async function readStream(
  res: Response,
  onDelta: (d: string, kind: DeltaKind) => void,
  /** Called on every frame that arrives, to rearm the idle deadline. */
  onProgress: () => void = () => {},
): Promise<ChatResult> {
  if (!res.body) throw new LlmError("The LLM endpoint returned no response body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let usage = EMPTY_USAGE;
  let hidden = 0;
  /* Deltas go through the splitter rather than straight out, so a model that
     writes its thinking inline is treated the same as one that puts it in its
     own field -- and the tag never reaches the transcript. */
  const split = splitThinking((piece, kind) => {
    if (kind === "thinking") reasoning += piece;
    else text += piece;
    onDelta(piece, kind);
  });
  let finishReason: string | undefined;
  /* Tool calls arrive spread across frames, keyed by an index rather than by id:
   * the first frame carries the id and name, later ones append argument
   * fragments. Accumulate by index or the arguments arrive as JSON confetti. */
  const partial = new Map<number, { id: string; name: string; args: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Progress, however small: a keep-alive comment frame from llama.cpp counts
    // just as much as a token, because both prove the server is still there.
    onProgress();
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
              reasoning_content?: unknown;
              reasoning?: unknown;
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
        if (parsed.usage) {
          usage = usageFrom(parsed.usage);
          hidden = reasoningTokens(parsed.usage);
        }
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        // A server that states the reasoning separately needs no splitting:
        // it is already labelled, and it never appears in `content`.
        const thought = statedReasoning(choice?.delta);
        if (thought) {
          reasoning += thought;
          onDelta(thought, "thinking");
        }
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) split.push(delta);
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
  split.flush();
  const toolCalls: ToolCall[] = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      type: "function" as const,
      function: { name: acc.name, arguments: acc.args },
    }))
    .filter((c) => c.function.name);

  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning ? {} : hidden ? { hiddenReasoning: hidden } : {}),
    usage,
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
  };
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


/**
 * Pull the two numbers out of llama.cpp's context-overflow error.
 *
 * Matched on the machine-readable `type` rather than on the prose, which is
 * upstream's to reword. Returns undefined for every other 400 so that a real
 * bad request is still reported as itself.
 */
export function parseOversize(body: string): { needed: number; limit: number } | undefined {
  if (!body.includes("exceed_context_size_error")) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { n_prompt_tokens?: number; n_ctx?: number };
    };
    const needed = parsed.error?.n_prompt_tokens;
    const limit = parsed.error?.n_ctx;
    if (typeof needed === "number" && typeof limit === "number") return { needed, limit };
  } catch {
    // Truncated at 400 characters, so the JSON may not close. The prose form
    // below still carries both numbers.
  }
  const m = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/.exec(body);
  return m ? { needed: Number(m[1]), limit: Number(m[2]) } : undefined;
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
