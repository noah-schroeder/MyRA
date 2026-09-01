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
import { harvestSources } from "./restore.ts";

let seq = 0;
const nextId = (): string => `i${++seq}`;

/**
 * A tool card cannot still be running once the turn has ended.
 *
 * It could, on screen: nothing settled these, so a call interrupted mid-flight
 * -- the user pressing stop, or the turn erroring out under it -- kept its
 * spinner and the word "running" indefinitely. Seen in practice on a cancelled
 * draft_document, which sat there claiming to be writing a document that no
 * longer had a process behind it.
 */
function settle(item: Item): Item {
  return item.kind === "tool" && item.status === "running"
    ? { ...item, status: "stopped" as const, output: item.output || "stopped before it finished" }
    : item;
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
          const text = event.text;
          const kind = event.kind === "thinking" ? "thinking" : "text";
          /*
           * The id is decided here, not inside the updater.
           *
           * `open.current` used to be assigned in the middle of `setItems`, and
           * React invokes updaters twice in development -- so two deltas
           * arriving in one batch could each create their own bubble, splitting
           * a single reply into two messages part-way through the first word.
           * A state updater has to be a pure function of `prev`; the ref is a
           * side effect and belongs out here with the other side effects.
           */
          if (open.current === undefined) open.current = nextId();
          const id = open.current;
          setItems((prev) =>
            prev.some((i) => i.id === id)
              ? prev.map((i) =>
                  i.id !== id || i.kind !== "assistant"
                    ? i
                    : { ...i, blocks: append(i.blocks, text, kind) },
                )
              : [
                  ...prev,
                  {
                    id,
                    kind: "assistant",
                    blocks: [{ kind, text }],
                    streaming: true,
                  } satisfies AssistantItem,
                ],
          );
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
          const harvested = harvestSources(event.result);
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

        /* Older messages were summarised to make room. Said out loud, because
           a model that silently forgot the first half of a conversation is
           indistinguishable from one that is broken. */
        case "compacted":
          setItems((prev) => [
            ...prev,
            { id: crypto.randomUUID(), kind: "notice" as const, text: event.text ?? "" },
          ]);
          break;

        case "done": {
          setBusy(false);
          open.current = undefined;
          setItems((prev) =>
            prev.map((i) =>
              i.kind === "assistant"
                ? { ...i, streaming: false }
                : settle(i),
            ),
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
          setItems((prev) => prev.map(settle));
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

  const reset = useCallback((restored: Item[] = [], restoredSources?: Map<number, CitedSource>) => {
    setItems(restored);
    setSources(restoredSources ?? new Map());
    setUsage(undefined);
    setError(undefined);
    setBusy(false);
    open.current = undefined;
  }, []);

  return { items, busy, usage, error, sources, send, abort, reset };
}

/*
 * Deltas of the same kind join the block they belong to; a change of kind
 * starts a new one. That is what makes a model that thinks, answers, thinks
 * again and answers again render as four blocks in the order it produced them,
 * rather than as one heap with the reasoning folded into the prose.
 */
function append(
  blocks: AssistantItem["blocks"],
  text: string,
  kind: "text" | "thinking",
): AssistantItem["blocks"] {
  const last = blocks.at(-1);
  if (last?.kind === kind) {
    return [...blocks.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...blocks, { kind, text }];
}
