/**
 * Turns the agent's event stream into a renderable conversation.
 *
 * v1 consumed pi's RPC events, which were delta-based with a contentIndex and
 * interleaved blocks, so text had to be assembled per index. The stream here is
 * simpler by construction: text deltas belong to the assistant message being
 * written, and a tool call is its own item with its own lifecycle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AssistantItem, CitedSource, Item, ToolItem, Usage } from "./types.ts";

let seq = 0;
const nextId = (): string => `i${++seq}`;

/** Sources a tool reported, so [n] markers in the prose can resolve to a link. */
function harvest(result: string | undefined): CitedSource[] {
  if (!result) return [];
  const found: CitedSource[] = [];
  // The format formatHits writes: "[3] Title\n    https://…"
  const pattern = /^\[(\d+)\]\s+(.*)\n\s+(https?:\/\/\S+)/gm;
  for (const m of result.matchAll(pattern)) {
    found.push({ n: Number(m[1]), title: m[2]!.trim(), url: m[3]! });
  }
  return found;
}

export function useAgent() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [sources, setSources] = useState<Map<number, CitedSource>>(new Map());
  /** The assistant item currently being streamed into. */
  const open = useRef<string | undefined>(undefined);

  useEffect(() => {
    return window.karen.onAgentEvent((event: AgentEvent) => {
      switch (event.type) {
        case "text": {
          if (!event.text) break;
          setItems((prev) => {
            const id = open.current;
            const existing = id ? prev.find((i) => i.id === id) : undefined;
            if (existing && existing.kind === "assistant") {
              return prev.map((i) =>
                i.id !== id || i.kind !== "assistant"
                  ? i
                  : { ...i, blocks: appendText(i.blocks, event.text!) },
              );
            }
            const created: AssistantItem = {
              id: nextId(),
              kind: "assistant",
              blocks: [{ kind: "text", text: event.text! }],
              streaming: true,
            };
            open.current = created.id;
            return [...prev, created];
          });
          break;
        }

        case "tool_start": {
          // A tool call ends the assistant message it was requested from: the
          // next text belongs after the card, not before it.
          open.current = undefined;
          const card: ToolItem = {
            id: nextId(),
            kind: "tool",
            toolCallId: event.toolCallId ?? "",
            name: event.tool ?? "tool",
            args: event.params ?? {},
            output: "",
            status: "running",
          };
          setItems((prev) => [...prev, card]);
          break;
        }

        case "tool_update":
          setItems((prev) =>
            prev.map((i) =>
              i.kind === "tool" && i.toolCallId === event.toolCallId
                ? { ...i, update: event.text ?? "" }
                : i,
            ),
          );
          break;

        case "tool_end": {
          const harvested = harvest(event.result);
          if (harvested.length) {
            setSources((prev) => {
              const next = new Map(prev);
              for (const s of harvested) next.set(s.n, s);
              return next;
            });
          }
          setItems((prev) =>
            prev.map((i) =>
              i.kind === "tool" && i.toolCallId === event.toolCallId
                ? { ...i, status: "ok" as const, output: event.result ?? "" }
                : i,
            ),
          );
          break;
        }

        case "tool_error":
          setItems((prev) =>
            prev.map((i) =>
              i.kind === "tool" && i.toolCallId === event.toolCallId
                ? { ...i, status: "error" as const, output: event.text ?? "failed" }
                : i,
            ),
          );
          break;

        case "done": {
          setBusy(false);
          open.current = undefined;
          setItems((prev) =>
            prev.map((i) => (i.kind === "assistant" ? { ...i, streaming: false } : i)),
          );
          try {
            if (event.result) setUsage(JSON.parse(event.result) as Usage);
          } catch {
            // Usage is a nicety; a malformed figure is not worth an error.
          }
          break;
        }

        case "error":
          setBusy(false);
          open.current = undefined;
          setError(event.text ?? "Something went wrong.");
          break;
      }
    });
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(undefined);
    setBusy(true);
    open.current = undefined;
    setItems((prev) => [...prev, { id: nextId(), kind: "user", text: trimmed }]);
    await window.karen.send(trimmed);
  }, []);

  const abort = useCallback(() => {
    void window.karen.abort();
    setBusy(false);
  }, []);

  const reset = useCallback((restored: Item[] = []) => {
    setItems(restored);
    setSources(new Map());
    setUsage(undefined);
    setError(undefined);
    setBusy(false);
    open.current = undefined;
  }, []);

  return { items, busy, usage, error, sources, send, abort, reset, setError };
}

function appendText(blocks: AssistantItem["blocks"], text: string): AssistantItem["blocks"] {
  const last = blocks.at(-1);
  if (last?.kind === "text") {
    return [...blocks.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...blocks, { kind: "text", text }];
}
