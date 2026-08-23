/**
 * Turns pi's RPC event stream into a renderable conversation.
 *
 * The stream is delta-based: message_update carries an assistantMessageEvent
 * with a contentIndex, and blocks arrive interleaved, so text is assembled per
 * index rather than appended blindly. message_end is authoritative, per the spec.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantItem, CitedSource, Item, ToolItem, Usage } from "./types.ts";

let seq = 0;
const nextId = (): string => `i${++seq}`;

export function useAgent() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** Citation number -> source, accumulated from every tool that retrieved one. */
  const [sources, setSources] = useState<Map<number, CitedSource>>(new Map());
  const currentAssistant = useRef<string | undefined>(undefined);

  useEffect(() => {
    return window.karen.onRpcEvent((frame: any) => {
      switch (frame?.type) {
        case "response": {
          // The reply to get_messages after switching sessions. Anything else
          // is handled where it was requested.
          if (frame.command !== "get_messages" || !frame.success) break;
          const messages = (frame.data?.messages ?? []) as any[];
          const rebuilt: Item[] = [];
          const seen = new Map<number, CitedSource>();
          for (const m of messages) {
            const text = extractText(m?.content);
            if (m?.role === "user") {
              if (text) rebuilt.push({ id: nextId(), kind: "user", text });
              continue;
            }
            // Tool results carry the source tables. Without harvesting them a
            // reopened chat would show [n] markers that resolve to nothing.
            if (m?.role === "toolResult") {
              for (const src of (m?.details?.sources ?? []) as CitedSource[]) {
                if (typeof src?.n === "number" && src.url) seen.set(src.n, src);
              }
              continue;
            }
            if (m?.role !== "assistant") continue;
            const blocks = new Map<number, { kind: "text" | "thinking"; text: string }>();
            for (const [i, block] of (m.content ?? []).entries()) {
              if (block?.type === "text" && block.text) blocks.set(i, { kind: "text", text: block.text });
              else if (block?.type === "thinking" && block.thinking) {
                blocks.set(i, { kind: "thinking", text: block.thinking });
              } else if (block?.type === "toolCall") {
                // Rendered as a finished card: the live update stream for a
                // past call is long gone, and inventing one would be a lie.
                const tool: ToolItem = {
                  id: nextId(),
                  kind: "tool",
                  toolCallId: String(block.id ?? ""),
                  name: String(block.name ?? "tool"),
                  args: (block.arguments ?? {}) as Record<string, unknown>,
                  output: "",
                  status: "ok",
                };
                rebuilt.push(tool);
              }
            }
            if (blocks.size) rebuilt.push({ id: nextId(), kind: "assistant", blocks, done: true } as AssistantItem);
          }
          setItems(rebuilt);
          setSources(seen);
          break;
        }

        case "agent_start":
          setBusy(true);
          setError(undefined);
          break;

        case "agent_settled":
          setBusy(false);
          currentAssistant.current = undefined;
          break;

        case "message_start": {
          const id = nextId();
          currentAssistant.current = id;
          setItems((prev) => [
            ...prev,
            { id, kind: "assistant", blocks: new Map(), done: false } as AssistantItem,
          ]);
          break;
        }

        case "message_update": {
          if (frame.usage) setUsage(frame.usage);
          const ev = frame.assistantMessageEvent;
          if (!ev) break;
          const idx: number = ev.contentIndex ?? 0;

          const append = (kind: "text" | "thinking", delta: string) => {
            const target = currentAssistant.current;
            setItems((prev) =>
              prev.map((it) => {
                if (it.id !== target || it.kind !== "assistant") return it;
                const blocks = new Map(it.blocks);
                const existing = blocks.get(idx);
                blocks.set(idx, {
                  kind,
                  text: (existing?.kind === kind ? existing.text : "") + delta,
                } as any);
                return { ...it, blocks };
              }),
            );
          };

          if (ev.type === "text_delta") append("text", ev.delta ?? "");
          else if (ev.type === "thinking_delta") append("thinking", ev.delta ?? "");
          break;
        }

        case "message_end": {
          const target = currentAssistant.current;
          setItems((prev) =>
            prev.map((it) =>
              it.id === target && it.kind === "assistant" ? { ...it, done: true } : it,
            ),
          );
          break;
        }

        case "tool_execution_start": {
          const tool: ToolItem = {
            id: nextId(),
            kind: "tool",
            toolCallId: frame.toolCallId,
            name: frame.toolName,
            args: frame.args ?? {},
            output: "",
            status: "running",
          };
          setItems((prev) => [...prev, tool]);
          break;
        }

        case "tool_execution_update": {
          const text = extractText(frame.partialResult?.content);
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.toolCallId === frame.toolCallId
                ? { ...it, output: text || it.output }
                : it,
            ),
          );
          break;
        }

        case "tool_execution_end": {
          const text = extractText(frame.result?.content);
          // Tools that retrieved sources hand over their numbering, so the
          // transcript can turn every [n] into a link to the real page.
          const found = (frame.result as { details?: { sources?: CitedSource[] } } | undefined)
            ?.details?.sources;
          if (Array.isArray(found) && found.length) {
            setSources((prev) => {
              const next = new Map(prev);
              for (const s of found) {
                if (typeof s?.n === "number" && s.url) next.set(s.n, s);
              }
              return next;
            });
          }
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.toolCallId === frame.toolCallId
                ? { ...it, output: text || it.output, status: frame.isError ? "error" : "ok" }
                : it,
            ),
          );
          break;
        }

        case "extension_error":
          setError(String(frame.error ?? "an extension failed"));
          break;

        // A rejected command used to vanish silently, so a failed prompt looked
        // exactly like nothing happening. Surface it.
        case "response":
          if (frame.success === false) {
            setError(`${frame.command ?? "command"} failed: ${frame.error ?? "unknown error"}`);
            setBusy(false);
          }
          break;
      }
    });
  }, []);

  /**
   * Send a prompt.
   *
   * `display` exists because the Deep research button wraps the question in a
   * directive before sending it. That wrapper is plumbing: showing it back in
   * the transcript makes the user's own words look like something the app
   * wrote, so the sent text and the shown text are allowed to differ.
   */
  const send = useCallback(async (text: string, streaming: boolean, display?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const shown = (display ?? trimmed).trim() || trimmed;
    setItems((prev) => [...prev, { id: nextId(), kind: "user", text: shown }]);
    await window.karen.rpc({
      type: "prompt",
      message: trimmed,
      // The agent rejects a bare prompt mid-stream; queue it instead.
      ...(streaming ? { streamingBehavior: "steer" } : {}),
    });
  }, []);

  const abort = useCallback(() => window.karen.rpc({ type: "abort" }), []);

  const reset = useCallback(async () => {
    await window.karen.rpc({ type: "new_session" });
    setItems([]);
    setUsage(undefined);
    setSources(new Map()); // the VM restarts numbering at [1] for a new session
    currentAssistant.current = undefined;
  }, []);

  /**
   * Open a past conversation.
   *
   * The transcript is rebuilt from pi rather than kept in the renderer: the
   * session file is the record, and reconstructing from anything else would
   * eventually show something the agent does not believe.
   */
  const openSession = useCallback(async (path: string) => {
    setItems([]);
    setUsage(undefined);
    setSources(new Map());
    currentAssistant.current = undefined;
    await window.karen.rpc({ type: "switch_session", sessionPath: path });
    await window.karen.rpc({ type: "get_messages" });
  }, []);

  return { items, busy, usage, error, sources, send, abort, reset, openSession };
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as any).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
