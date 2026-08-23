/**
 * Drives the research tools directly, without pi or an LLM.
 *
 * Registers them against a stub ExtensionAPI and calls execute(), so each tool
 * is exercised as pi would call it -- against the real OpenAlex, arXiv and
 * SearXNG endpoints.
 */

export interface CapturedTool {
  name: string;
  description: string;
  execute: (
    id: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (u: any) => void,
    ctx?: any,
  ) => Promise<{ content: { type: string; text: string }[]; details?: any }>;
}

export interface Stub {
  pi: any;
  tools: Map<string, CapturedTool>;
  /** Event handlers the extension registered, so tests can fire them. */
  handlers: Map<string, (...args: any[]) => any>;
  /** The current active-tool list, as setActiveTools leaves it. */
  activeTools: () => string[];
}

export function stubApi(initialActive: string[] = []): Stub {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, (...args: any[]) => any>();
  let active = [...initialActive];
  const pi = {
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: () => {},
    on: (event: string, fn: (...args: any[]) => any) => handlers.set(event, fn),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    getAllTools: () => [...tools.values()],
  };
  return { pi, tools, handlers, activeTools: () => [...active] };
}

/** Collect onUpdate progress so tests can assert streaming actually happens. */
export function recorder(): { onUpdate: (u: any) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    onUpdate: (u: any) => {
      const text = u?.content?.[0]?.text;
      if (text) lines.push(text);
    },
  };
}
