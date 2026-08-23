/**
 * Running one pipeline stage as a separate pi process.
 *
 * This is the piece that makes "a different model per stage" real, and it uses
 * pi rather than a hand-written HTTP client on purpose:
 *
 *   - model resolution, retries and provider quirks are already solved
 *   - a separate PROCESS gives the reviewer genuinely fresh context, which is
 *     the entire point of the review stage; asking one model to critique what
 *     it just wrote mostly produces rationalisation
 *   - `--tools` (or none at all) makes "this stage cannot wander off" a
 *     property of the process rather than a hopeful instruction in a prompt
 *
 * Every stage here is pure text in, pure text out. Tools are off by default,
 * extensions are off (this file's own extension must never load recursively),
 * and context files are off so a stray AGENTS.md cannot change a screening
 * decision.
 */

import { spawn } from "node:child_process";

/**
 * How long a stage may produce NOTHING AT ALL before it is treated as wedged.
 *
 * Idle time, not total time. A wall-clock limit cannot tell a slow model from a
 * hung one, and on a modest inference server a legitimate screening batch or a
 * long-context synthesis can run for many minutes -- killing that is destroying
 * good work. Silence is the honest signal: the timer resets on every byte the
 * child produces, so a model that is merely slow keeps its stage alive
 * indefinitely, while a process that has genuinely stopped still fails rather
 * than blocking the run for ever.
 *
 * Set `idleTimeoutMs: 0` to disable it entirely.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

export interface SubagentOptions {
  /** "provider/id", exactly as the app's model dropdown reports it. */
  model: string;
  prompt: string;
  /** Extra system prompt: literal text, or a path to a markdown rubric. */
  system?: string;
  /** Tool allowlist. Omit for none, which is what every stage should want. */
  tools?: string[];
  /** Milliseconds of total silence before the stage is considered wedged. 0 disables. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  onProgress?: (note: string) => void;
  /**
   * Live output from the stage as it is produced.
   *
   * Without this a stage is a silent gap of several minutes: the work is
   * happening in another process, so none of it appears in the conversation.
   * `thinking` is the model's reasoning, which is worth showing separately
   * because it is not part of the answer.
   */
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}

export interface SubagentUsage {
  input: number;
  output: number;
  total: number;
}

export interface SubagentResult {
  text: string;
  usage: SubagentUsage;
  /** How many times pi had to retry. Non-zero is worth surfacing. */
  retries: number;
  model: string;
  durationMs: number;
}

export class SubagentError extends Error {
  override readonly name = "SubagentError";
  /** Explicit field, not a constructor parameter property: pi loads these files
   *  by stripping types, and parameter properties are real emit, not types. */
  readonly stderr: string | undefined;
  constructor(message: string, stderr?: string) {
    super(message);
    this.stderr = stderr;
  }
}

interface PiEvent {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    content?: { type?: string; text?: string }[];
    usage?: { input?: number; output?: number; totalTokens?: number };
    stopReason?: string;
    errorMessage?: string;
  };
  finalError?: string;
}

export function buildArgs(opts: SubagentOptions): string[] {
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--offline",
    // Nothing this process reads should be able to change its judgement.
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--model", opts.model,
  ];
  if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
  else args.push("--no-tools");
  if (opts.system) args.push("--append-system-prompt", opts.system);
  args.push(opts.prompt);
  return args;
}

/**
 * Run one stage and return its text.
 *
 * Deliberately strict: a stage that errored, timed out, or produced no text is
 * a failure the run must see, not an empty string to carry forward silently.
 */
export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const started = Date.now();
  const child = spawn("pi", buildArgs(opts), {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const texts: string[] = [];
  const usage: SubagentUsage = { input: 0, output: 0, total: 0 };
  let retries = 0;
  let actualModel: string | undefined;
  let failure: string | undefined;
  let stderr = "";
  let buffer = "";

  const onEvent = (event: PiEvent): void => {
    switch (event.type) {
      case "message_end": {
        const m = event.message;
        if (m?.role !== "assistant") return;
        for (const block of m.content ?? []) {
          if (block.type === "text" && block.text) texts.push(block.text);
        }
        // pi echoes back what it actually used. Recording the requested model
        // when a different one answered would put a false attribution in the
        // run's audit trail, which is the one thing it exists to prevent.
        if (m.provider && m.model) actualModel = `${m.provider}/${m.model}`;
        // Usage accrues across retries, which is the honest number to report:
        // a retried call really did cost twice.
        usage.input += m.usage?.input ?? 0;
        usage.output += m.usage?.output ?? 0;
        usage.total += m.usage?.totalTokens ?? 0;
        if (m.stopReason === "error") failure = m.errorMessage ?? "model call failed";
        else failure = undefined; // a later success supersedes an earlier error
        return;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent;
        const delta = inner?.delta;
        if (!delta) return;
        if (inner?.type === "text_delta") opts.onDelta?.(delta, "text");
        else if (inner?.type === "thinking_delta" || inner?.type === "reasoning_delta") {
          opts.onDelta?.(delta, "thinking");
        }
        return;
      }
      case "auto_retry_start":
        retries++;
        opts.onProgress?.(`retrying (${retries})`);
        return;
      case "auto_retry_end":
        if (event.finalError) failure = event.finalError;
        return;
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    touch(); // any output at all means the stage is alive
    buffer += chunk;
    // LF only. pi's protocol is explicit about this, and a JSON string can
    // legitimately contain other line separators.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as PiEvent);
      } catch {
        /* a partial or non-JSON line is not worth failing the stage over */
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    touch();
    stderr = (stderr + chunk).slice(-4_000);
  });

  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const touch = (): void => {
    if (idleMs <= 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, idleMs);
  };
  touch();

  const onAbort = () => child.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (timedOut) {
      const shown =
        idleMs >= 120_000
          ? `${Math.round(idleMs / 60_000)} minutes`
          : idleMs >= 1000
            ? `${Math.round(idleMs / 1000)} seconds`
            : `${idleMs}ms`;
      throw new SubagentError(
        `${opts.model} produced no output for ${shown} — treating it as stuck. ` +
          `If your endpoint is simply this slow, raise idleTimeoutMs or set it to 0.`,
        stderr,
      );
    }
    if (opts.signal?.aborted) throw new SubagentError("stage aborted");
    if (failure) throw new SubagentError(`${opts.model} failed: ${failure}`, stderr);
    if (code !== 0) throw new SubagentError(`pi exited with code ${code}`, stderr);

    const text = texts.join("\n").trim();
    if (!text) throw new SubagentError(`${opts.model} returned no text`, stderr);
    if (actualModel && actualModel !== opts.model) {
      throw new SubagentError(
        `asked for ${opts.model} but ${actualModel} answered — refusing to attribute this stage ` +
          `to a model that did not run it`,
        stderr,
      );
    }

    return {
      text, usage, retries, model: actualModel ?? opts.model, durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof SubagentError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new SubagentError("pi is not on PATH — the research pipeline runs stages as pi subprocesses");
    }
    throw new SubagentError((err as Error).message, stderr);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/* ------------------------------------------------------------------ *
 * Reading structured replies                                          *
 * ------------------------------------------------------------------ */

/**
 * Pull a JSON value out of a model's reply.
 *
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
