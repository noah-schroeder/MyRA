/**
 * Every tool the model can reach, and nothing else.
 *
 * This is the security boundary of v2, and it is small on purpose. In v1 the
 * agent was pi, which shipped `read, write, edit, bash, grep, find, ls, tree`
 * -- and `bash` alone meant the agent could do anything the user account could,
 * so containment had to be a VM around the whole process.
 *
 * Here the model can only emit a call matching a schema registered below. There
 * is no `bash`, so "run a command" is not a sentence the protocol can express.
 * The tool list IS the capability list, which makes this file the thing to
 * review when asking what the agent can do.
 *
 * Two rules that must not be relaxed, because between them they are what makes
 * the small surface actually small:
 *
 *   1. A tool builds its own argv from a fixed template. Never splice a string
 *      the model chose into a command line -- pandoc's --lua-filter and
 *      --filter execute arbitrary code, so a "convenient" passthrough argument
 *      is a shell with extra steps.
 *   2. Every path parameter is resolved and checked against its jail on every
 *      call, with realpath, after normalisation.
 */

import type { RiskClass } from "../policy.ts";

/** JSON Schema for a tool's parameters, as the wire format wants it. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Progress for the tool card in the UI. */
  onUpdate?: (note: string) => void;
}

export interface ToolResult {
  /** What the model sees. Untrusted content must arrive already fenced. */
  content: string;
  /** Structured payload for the UI. Never shown to the model. */
  detail?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * Risk class, declared here rather than looked up in a table elsewhere.
   *
   * v1 kept the classification in a separate list and it drifted: the list said
   * "fetch_url" while the tool was named "fetch_page", so every page fetch was
   * classified dangerous and Guarded mode would have prompted on each one.
   * Declaring it on the definition makes that particular bug unrepresentable.
   */
  risk: RiskClass;
  /**
   * Whether this tool is currently reachable. Absent means always.
   *
   * Evaluated per call rather than at registration, so a settings change takes
   * effect on the next message with no restart and no stale copy in memory.
   */
  enabled?: () => boolean;
  handler(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class UnknownToolError extends Error {
  override readonly name = "UnknownToolError";
}

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();

  /** Registers a tool, or replaces one of the same name. */
  register(def: ToolDef): void {
    if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
      throw new Error(`tool name ${JSON.stringify(def.name)} is not a plain identifier`);
    }
    this.#tools.set(def.name, def);
  }

  /** Every registered tool, reachable or not. */
  all(): ToolDef[] {
    return [...this.#tools.values()];
  }

  /** Tools the model may call right now. */
  active(): ToolDef[] {
    return this.all().filter((t) => t.enabled?.() ?? true);
  }

  activeNames(): string[] {
    return this.active().map((t) => t.name);
  }

  /** The tool list as the chat wire format wants it. */
  schemas(): { type: "function"; function: { name: string; description: string; parameters: JsonSchema } }[] {
    return this.active().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /**
   * Run one tool call.
   *
   * A name that is not registered, or is registered but currently gated off, is
   * refused rather than ignored. Models hallucinate tool names, and silently
   * returning nothing teaches the model the call succeeded.
   */
  async dispatch(
    name: string,
    params: Record<string, unknown>,
    ctx: ToolContext = {},
  ): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new UnknownToolError(
        `There is no tool named ${JSON.stringify(name)}. Available: ${this.activeNames().join(", ") || "none"}`,
      );
    }
    if (!(tool.enabled?.() ?? true)) {
      throw new UnknownToolError(`The tool ${JSON.stringify(name)} is not enabled in the current settings.`);
    }
    return await tool.handler(params, ctx);
  }
}
