/**
 * Turns the agent's event stream into a renderable conversation.
 *
 * v1 consumed pi's RPC events, which were delta-based with a contentIndex and
 * interleaved blocks, so text had to be assembled per index. The stream here is
 * simpler by construction: text deltas belong to the assistant message being
 * written, and a tool call is its own item with its own lifecycle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent, AssistantItem, CitedSource, Item, PendingAttachment, ToolItem, Usage,
} from "./types.ts";
import { harvestSources } from "./restore.ts";
import type { TurnProgress } from "../core/llm/progress.ts";

/**
 * What the turn in flight is doing, and since when.
 *
 * `since` restarts only when the phase changes, so "Reading the conversation"
 * counts up across its several batch updates rather than resetting on each;
 * `startedAt` is the whole turn, for the total beside it.
 */
export interface LiveProgress {
  value: TurnProgress;
  since: number;
  startedAt: number;
}

function advance(prev: LiveProgress | undefined, value: TurnProgress): LiveProgress {
  const now = Date.now();
  if (!prev) return { value, since: now, startedAt: now };
  const same = prev.value.phase === value.phase &&
    (value.phase !== "tool" || (prev.value.phase === "tool" && prev.value.tool === value.tool));
  return { value, since: same ? prev.since : now, startedAt: prev.startedAt };
}

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
  const [progress, setProgress] = useState<LiveProgress | undefined>();
  /** The assistant item currently being streamed into. */
  const open = useRef<string | undefined>(undefined);
  /**
   * The conversation on screen right now, if it is one `reset` or `resume`
   * has named.
   *
   * Every event used to be applied to whatever `items` currently held, with
   * nothing saying which conversation it was actually for -- so switching to
   * a different conversation while the first one was still generating fed
   * its deltas into the newly opened one instead. Left `undefined` until a
   * session is explicitly opened or created, so the very first message of a
   * fresh conversation -- which has gone through neither -- is not filtered
   * against an id nothing has set yet.
   */
  const currentSessionId = useRef<string | undefined>(undefined);

  /** The reducer proper, shared by the live subscription below and `resume`,
   *  which replays a session's own past events through the same logic. */
  const apply = useCallback((event: AgentEvent) => {
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

      case "stats": {
        /* Fired once per model call, right after it returns -- so this
           always lands on the bubble `open.current` still names, before a
           following tool call (if any) clears it. A reply that made a tool
           call and wrote no prose of its own opened no bubble at all, and
           the stats for it are dropped rather than attached to the wrong
           one. */
        const id = open.current;
        if (id && event.stats) {
          const stats = event.stats;
          setItems((prev) =>
            prev.map((i) => (i.id === id && i.kind === "assistant" ? { ...i, stats } : i)),
          );
        }
        break;
      }

      case "progress":
        if (event.progress) {
          const value = event.progress;
          setProgress((prev) => advance(prev, value));
        }
        break;

      case "tool_start": {
        // A tool call ends the assistant message it was requested from: the
        // next text belongs after the card, not before it.
        open.current = undefined;
        {
          const tool = event.tool ?? "tool";
          setProgress((prev) => advance(prev, { phase: "tool", tool }));
        }
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
              ? {
                  ...i, status: "ok" as const, output: event.result ?? "",
                  ...(event.detail !== undefined ? { detail: event.detail } : {}),
                }
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
         indistinguishable from one that is broken.

         "notice" is the same idea for anything else the app needs to say in
         the transcript rather than about it -- a provider that withholds its
         reasoning, for one. Same shape, same place, so it reads as part of
         the conversation and not as an error. */
      case "notice":
      case "compacted":
        setItems((prev) => [
          ...prev,
          { id: crypto.randomUUID(), kind: "notice" as const, text: event.text ?? "" },
        ]);
        break;

      case "done": {
        setBusy(false);
        setProgress(undefined);
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
        setProgress(undefined);
        open.current = undefined;
        setItems((prev) => prev.map(settle));
        setError(event.text ?? "Something went wrong.");
        break;
    }
  }, []);

  useEffect(() => {
    return window.myra.onAgentEvent((event: AgentEvent) => {
      /* A conversation whose id has been set is the only one live events are
         applied to; one tagged for some other conversation is dropped rather
         than drawn on top of whatever is on screen. */
      if (currentSessionId.current && event.sessionId && event.sessionId !== currentSessionId.current) {
        return;
      }
      apply(event);
    });
  }, [apply]);

  const send = useCallback(async (text: string, attachments: PendingAttachment[] = []) => {
    const trimmed = text.trim();
    // An image with no question about it is still a real message -- "what is
    // this" is implied, not required -- so this refuses only when there is
    // genuinely nothing to send.
    if (!trimmed && !attachments.length) return;
    setError(undefined);
    setBusy(true);
    setProgress(advance(undefined, { phase: "waiting" }));
    open.current = undefined;
    setItems((prev) => [
      ...prev,
      {
        id: nextId(),
        kind: "user",
        text: trimmed,
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ kind: a.kind, name: a.name })) }
          : {}),
      },
    ]);
    await window.myra.send(trimmed, attachments);
  }, []);

  const abort = useCallback(() => {
    void window.myra.abort();
    setBusy(false);
    setProgress(undefined);
  }, []);

  const reset = useCallback(
    (restored: Item[] = [], restoredSources?: Map<number, CitedSource>, sessionId?: string) => {
      currentSessionId.current = sessionId;
      setItems(restored);
      setSources(restoredSources ?? new Map());
      setUsage(undefined);
      setError(undefined);
      setBusy(false);
      setProgress(undefined);
      open.current = undefined;
    },
    [],
  );

  /**
   * Catch up on a conversation whose own turn is still running.
   *
   * Called right after `reset` has shown its saved messages, with whatever
   * that turn has emitted so far -- the same events a subscriber who never
   * left would have received, replayed through the same reducer. Without
   * this, reopening it mid-turn showed only what was on disk when the turn
   * started, indistinguishable from the reply having stopped.
   */
  const resume = useCallback(
    (sessionId: string, events: AgentEvent[]) => {
      currentSessionId.current = sessionId;
      setBusy(true);
      /* Progress is never replayed, so the clock starts from coming back to
         it -- honest about what this window saw, not about when it began. */
      setProgress(advance(undefined, { phase: "waiting" }));
      open.current = undefined;
      for (const event of events) apply(event);
    },
    [apply],
  );

  /**
   * Put the error away.
   *
   * Sending already clears it, but that makes dismissing a message conditional
   * on having something else to say — and the banner sits above the composer
   * for the rest of the conversation until you do. An error is a thing that
   * happened, not a state the app is in.
   */
  const dismissError = useCallback(() => setError(undefined), []);

  return { items, busy, usage, error, sources, progress, send, abort, reset, resume, dismissError };
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
