/**
 * A project's memory: what it is about, kept so a new chat inside it does not
 * start from nothing.
 *
 * Fixed slots rather than a growing log, for the same reason `Scope` always
 * carries the same fields: nothing downstream is surprised by the shape, and
 * "what goes where" is a decision made once here rather than by every prompt
 * that reads or writes one. See [intake.ts](./intake.ts) for how a project
 * gets its first memory and [memoryUpdate.ts](../projects/memoryUpdate.ts) --
 * actually `../../main` wiring aside -- for how it grows afterwards.
 *
 * Deliberately uncapped. A researcher re-explaining something the app forgot
 * is exactly the cost this feature exists to remove, so nothing here refuses
 * an item for size. The only limit is on what reaches the PROMPT, because that
 * rides on the model's own context window every turn -- see `renderMemory`.
 *
 * Pure: no disk, no Electron. [main/memoryStore.ts](../../main/memoryStore.ts)
 * owns the file.
 */

import type { ChatMessage } from "../llm/chat.ts";
import { estimateTokens } from "../agent/compact.ts";

/** The fixed fields a memory can hold an item under. */
export type MemorySlot = "questions" | "aims" | "theory" | "methods" | "decisions" | "open" | "context";

export const MEMORY_SLOTS: readonly MemorySlot[] = [
  "questions", "aims", "theory", "methods", "decisions", "open", "context",
];

/**
 * Priority order for the prompt, poorest first to be dropped.
 *
 * Not alphabetical and not declaration order: a question left off a project
 * costs more than a stray piece of context, so questions and aims are the last
 * thing `renderMemory` ever omits and `context` -- background that is nice to
 * have rather than load-bearing -- is the first.
 */
const PRIORITY: readonly MemorySlot[] = [
  "questions", "aims", "theory", "methods", "decisions", "open", "context",
];

export const SLOT_LABELS: Record<MemorySlot, string> = {
  questions: "Research questions",
  aims: "Aims",
  theory: "Guiding theory",
  methods: "Methods",
  decisions: "Decisions",
  open: "Open questions",
  context: "Context",
};

export function isMemorySlot(value: unknown): value is MemorySlot {
  return typeof value === "string" && (MEMORY_SLOTS as readonly string[]).includes(value);
}

/** Where an item came from, so an automatic write can never overwrite one the user made. */
export type ItemSource = "you" | "setup" | "auto";

export interface MemoryItem {
  id: string;
  slot: MemorySlot;
  text: string;
  source: ItemSource;
  /** The conversation this came from, when it has one. Setup items have none. */
  from?: string;
  at: string;
}

export interface ProjectMemory {
  /** Whether the project's setup chat has run. A simple folder starts "done" with nothing in it. */
  setup: "pending" | "done";
  /** Whether an idle conversation may add to this memory on its own. On by default for a research project. */
  auto: boolean;
  items: MemoryItem[];
  /**
   * How far each conversation has already been read for automatic updates, by
   * message count. Per conversation rather than one number, because two chats
   * in the same project are read independently and a project holds several at
   * once.
   */
  seen: Record<string, number>;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export function newMemory(opts: { setup?: "pending" | "done" } = {}): ProjectMemory {
  return { setup: opts.setup ?? "done", auto: true, items: [], seen: {} };
}

/**
 * A record read back off disk, rebuilt field by field.
 *
 * The same discipline `parseProject` gets, for the same reason: a truncated
 * write or a half-synced file must not throw the project page, and a slot or a
 * source this build does not know is dropped rather than trusted forward.
 */
export function parseMemory(raw: unknown): ProjectMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return newMemory();
  const row = raw as Record<string, unknown>;

  const items: MemoryItem[] = [];
  for (const entry of Array.isArray(row["items"]) ? row["items"] : []) {
    if (!entry || typeof entry !== "object") continue;
    const it = entry as Record<string, unknown>;
    const text = typeof it["text"] === "string" ? it["text"].trim() : "";
    const slot = it["slot"];
    if (!text || !isMemorySlot(slot)) continue;
    const source = it["source"];
    const id = typeof it["id"] === "string" && it["id"] ? it["id"] : randomId();
    items.push({
      id,
      slot,
      text,
      source: source === "you" || source === "setup" || source === "auto" ? source : "you",
      ...(typeof it["from"] === "string" && it["from"] ? { from: it["from"] } : {}),
      at: typeof it["at"] === "string" ? it["at"] : new Date(0).toISOString(),
    });
  }

  const seen: Record<string, number> = {};
  if (row["seen"] && typeof row["seen"] === "object" && !Array.isArray(row["seen"])) {
    for (const [session, count] of Object.entries(row["seen"] as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) seen[session] = Math.round(count);
    }
  }

  return {
    setup: row["setup"] === "pending" ? "pending" : "done",
    auto: row["auto"] !== false,
    items,
    seen,
  };
}

/* ------------------------------------------------------------------ *
 * Editing                                                             *
 * ------------------------------------------------------------------ */

export interface NewItem {
  slot: MemorySlot;
  text: string;
}

/** Add items the user has just approved -- setup, or a manual edit. */
export function addItems(
  memory: ProjectMemory,
  proposed: readonly NewItem[],
  source: Exclude<ItemSource, "auto">,
  now = new Date(),
): ProjectMemory {
  const at = now.toISOString();
  const items = [...memory.items];
  for (const p of proposed) {
    const text = p.text.trim();
    if (!text) continue;
    items.push({ id: randomId(), slot: p.slot, text, source, at });
  }
  return { ...memory, items };
}

/**
 * Change an item's text.
 *
 * An automatic item that the user edits stops being one -- it is now something
 * the user wrote, and a later automatic pass must never overwrite it. Clearing
 * the text removes the item outright, which is what the memory editor's own
 * blank-field-means-delete convention (`removeItem`'s caller) relies on.
 */
export function editItem(memory: ProjectMemory, id: string, text: string, now = new Date()): ProjectMemory {
  const trimmed = text.trim();
  if (!trimmed) return removeItem(memory, id);
  const items = memory.items.map((it) =>
    it.id === id ? { ...it, text: trimmed, source: it.source === "auto" ? "you" : it.source, at: now.toISOString() } : it,
  );
  return { ...memory, items };
}

export function removeItem(memory: ProjectMemory, id: string): ProjectMemory {
  const items = memory.items.filter((it) => it.id !== id);
  return items.length === memory.items.length ? memory : { ...memory, items };
}

export function setAuto(memory: ProjectMemory, auto: boolean): ProjectMemory {
  return memory.auto === auto ? memory : { ...memory, auto };
}

export function markSetupDone(memory: ProjectMemory): ProjectMemory {
  return memory.setup === "done" ? memory : { ...memory, setup: "done" };
}

/**
 * Grounded items from an automatic pass, folded in.
 *
 * Only ever ADDS. An automatic pass has no way to touch a `"you"` or `"setup"`
 * item -- see the module header -- so there is no update path here, only
 * dedupe-and-append. `seen` moves regardless of whether anything was added,
 * so a quiet stretch of conversation is not re-read next time.
 */
export function mergeAuto(
  memory: ProjectMemory,
  proposed: readonly NewItem[],
  sessionId: string,
  upTo: number,
  now = new Date(),
): ProjectMemory {
  const added = addAuto(memory, proposed, sessionId, now);
  return { ...added, seen: { ...memory.seen, [sessionId]: upTo } };
}

/**
 * Grounded items appended as `"auto"`, deduplicated, and nothing else moved.
 *
 * What the `remember` tool writes through: a model saving one note mid-turn
 * has read nothing past it, so unlike `mergeAuto` it must leave the
 * conversation's watermark where it was -- moving it would let the idle pass
 * skip everything said after this one note.
 */
export function addAuto(
  memory: ProjectMemory,
  proposed: readonly NewItem[],
  sessionId: string,
  now = new Date(),
): ProjectMemory {
  const at = now.toISOString();
  const items = [...memory.items];
  for (const p of proposed) {
    const text = p.text.trim();
    if (!text) continue;
    const dup = items.some((it) => it.slot === p.slot && it.text.toLowerCase() === text.toLowerCase());
    if (dup) continue;
    items.push({ id: randomId(), slot: p.slot, text, source: "auto", from: sessionId, at });
  }
  return items.length === memory.items.length ? memory : { ...memory, items };
}

/* ------------------------------------------------------------------ *
 * Rendering, for the system prompt                                   *
 * ------------------------------------------------------------------ */

function blockFor(slot: MemorySlot, items: readonly MemoryItem[]): string {
  const own = items.filter((it) => it.slot === slot);
  if (!own.length) return "";
  return [`${SLOT_LABELS[slot]}:`, ...own.map((it) => `- ${it.text}`)].join("\n");
}

/** The same char-per-token estimate compaction budgets the request against, so this bar and the one that actually fires agree. */
function tokensOf(text: string): number {
  if (!text) return 0;
  return estimateTokens([{ role: "system", content: text } as ChatMessage]);
}

export interface MemoryRender {
  /** What actually goes in the system prompt. Empty when there is nothing to say. */
  text: string;
  /** Fields left out because the half-window limit was reached. Never touches storage. */
  omitted: MemorySlot[];
  /** Tokens `text` costs, by the same estimate compaction uses. */
  tokens: number;
  /** `tokens / contextTokens`, only when a window was given. */
  share?: number;
  /** Past a quarter of the window. Shown as a heads-up, well before anything is actually dropped. */
  warn: boolean;
}

const QUARTER = 0.25;
const HALF = 0.5;

/**
 * The memory as it goes in front of the model, sized to the window it will
 * actually be read in.
 *
 * Nothing is ever dropped from STORAGE here -- every item stays on the project
 * page whatever this returns. What can be dropped is which of it reaches the
 * PROMPT: past half the window, whole fields are left out in priority order,
 * poorest first, because a memory that fills the window fails every turn in
 * the project rather than costing one degraded reply.
 *
 * With no window (a hosted endpoint, which reports none), nothing is capped --
 * the same stance `needsCompaction` takes on an unknown window.
 */
export function renderMemory(memory: ProjectMemory, contextTokens?: number): MemoryRender {
  const blocks = PRIORITY.map((slot) => ({ slot, block: blockFor(slot, memory.items) })).filter((b) => b.block);
  const full = blocks.map((b) => b.block).join("\n\n");
  const fullTokens = tokensOf(full);

  if (!contextTokens || contextTokens <= 0) {
    return { text: full, omitted: [], tokens: fullTokens, warn: false };
  }

  const warn = fullTokens > contextTokens * QUARTER;
  if (fullTokens <= contextTokens * HALF) {
    return { text: full, omitted: [], tokens: fullTokens, warn, share: fullTokens / contextTokens };
  }

  const kept: string[] = [];
  const omitted: MemorySlot[] = [];
  let used = 0;
  for (const { slot, block } of blocks) {
    const cost = tokensOf(block);
    /* At least one field always makes it through, even alone over budget --
       an empty memory prompt is a worse failure than a slightly oversized
       one, the same call `renderMemory`'s caller in intake.ts's fallback
       menu makes for a question with no good options. */
    if (kept.length && used + cost > contextTokens * HALF) {
      omitted.push(slot);
      continue;
    }
    kept.push(block);
    used += cost;
  }
  const text = kept.join("\n\n");
  return { text, omitted, tokens: tokensOf(text), warn: true, share: tokensOf(text) / contextTokens };
}

/** How much of a window the whole memory would cost, uncapped -- what the project page's meter shows. */
export function memoryTokens(memory: ProjectMemory): number {
  return renderMemory(memory).tokens;
}

/**
 * The memory as a document, for the export a project can be turned into --
 * see [render.ts](./render.ts)'s own header on why "all of it together on
 * disk" is answered by exporting rather than by living in one folder.
 *
 * Markdown headings rather than `renderMemory`'s plain "Label:" lines, to sit
 * next to `project.md`'s own `## Conversations` style; and always the whole
 * memory, uncapped -- this is read by a person, not sent to a model, so the
 * half-window rule that exists only because a prompt shares a context window
 * has nothing to do here. Empty when the memory has nothing in it, so a
 * project with no notes gets no empty file.
 */
export function renderMemoryMarkdown(memory: ProjectMemory): string {
  const blocks = PRIORITY.map((slot) => {
    const own = memory.items.filter((it) => it.slot === slot);
    if (!own.length) return "";
    return [`## ${SLOT_LABELS[slot]}`, "", ...own.map((it) => `- ${it.text}`)].join("\n");
  }).filter(Boolean);
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/* ------------------------------------------------------------------ *
 * Grounding support                                                   *
 * ------------------------------------------------------------------ */

/** A message adapted to the shape `verifyQuote` already knows how to search. */
export interface GroundingLine {
  at: number;
  end: number;
  speaker: "user" | "assistant";
  trackId: string;
  text: string;
}

/**
 * User and assistant text, in order, with untrusted content stripped.
 *
 * `<<<UNTRUSTED CONTENT …>>>` blocks are a fetched page or a dropped document,
 * never something the user typed -- see html.ts's `asUntrusted`. Removing them
 * before grounding is what stops a page reached mid-conversation from planting
 * a "memory" of its own: content that lived only inside one of these blocks
 * can never itself become a quote `groundProposals` matches against.
 */
export function conversationLines(messages: readonly ChatMessage[]): GroundingLine[] {
  const lines: GroundingLine[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user" && m.role !== "assistant") return;
    const text = stripUntrusted(m.content ?? "");
    if (!text.trim()) return;
    lines.push({ at: i, end: i, speaker: m.role, trackId: m.role, text });
  });
  return lines;
}

function stripUntrusted(text: string): string {
  return text.replace(/<<<UNTRUSTED CONTENT[\s\S]*?<<<END UNTRUSTED CONTENT>>>/g, " ");
}

/* ------------------------------------------------------------------ *
 * Review dialogs                                                      *
 * ------------------------------------------------------------------ */

/**
 * The shape the renderer's generic `form` dialog already draws --
 * `create_prisma_diagram`'s own `PrismaFormField`, structurally. A candidate
 * item becomes one field, so setup and the "update from this chat" button can
 * both show "what I found, edit or clear anything wrong" using the dialog
 * that already exists rather than a new one invented for this feature.
 */
export interface MemoryFormField {
  key: string;
  label: string;
  hint?: string;
  group: string;
  /** The textarea `kind: "list"` draws -- borrowed for its widget, not for
   *  PRISMA's own list-splitting, which nothing here applies. */
  kind?: "list";
  value?: string;
  /** Proposed by a model, not yet the user's own answer -- shown and marked. */
  guessed?: boolean;
}

/** Candidate items as fields, one per item, grouped by the field they'd land under. */
export function itemsToFields(items: readonly NewItem[], guessed: boolean): MemoryFormField[] {
  return items.map((item, i) => ({
    key: `item-${i}`,
    label: SLOT_LABELS[item.slot],
    group: SLOT_LABELS[item.slot],
    kind: "list" as const,
    value: item.text,
    ...(guessed ? { guessed: true } : {}),
  }));
}

/**
 * The form's answers, paired back with the items that produced the fields.
 *
 * A blank field drops its item -- the same "blank field, nothing drawn"
 * convention the PRISMA form itself reads back with, repurposed here as
 * "blank field, nothing kept".
 */
export function fieldsToItems(items: readonly NewItem[], values: Record<string, string>): NewItem[] {
  const out: NewItem[] = [];
  items.forEach((item, i) => {
    const text = (values[`item-${i}`] ?? "").trim();
    if (text) out.push({ slot: item.slot, text });
  });
  return out;
}
