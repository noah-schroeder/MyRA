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
export type MemorySlot =
  | "questions" | "aims" | "theory" | "methods" | "decisions" | "literature" | "open" | "context";

export const MEMORY_SLOTS: readonly MemorySlot[] = [
  "questions", "aims", "theory", "methods", "decisions", "literature", "open", "context",
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
  "questions", "aims", "theory", "methods", "decisions", "literature", "open", "context",
];

export const SLOT_LABELS: Record<MemorySlot, string> = {
  questions: "Research questions",
  aims: "Aims",
  theory: "Guiding theory",
  methods: "Methods",
  decisions: "Decisions",
  /* Its own field rather than `context`, which is where the setup task "Note
     key literature" used to land -- the first field dropped when the window is
     tight, for the papers a project is built on. */
  literature: "Key literature",
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
  /**
   * The words it rests on, as they were actually found -- the user's own
   * line, or the assistant proposal the user agreed to. A note nobody can
   * trace is a note nobody can check, and the grounding had this in hand and
   * threw it away.
   */
  quote?: string;
  /** Which message of `from` the quote was found in, so the page can open it there. */
  msg?: number;
  /** The meeting this came from, by directory name -- the ref a meeting member uses. */
  meeting?: string;
  /** Where in that meeting, as the transcript prints the time. */
  meetingAt?: string;
  /**
   * Closed, not deleted: replaced by a newer note, or (an open question)
   * answered. A closed item leaves the prompt and stays in the history, because
   * how a decision changed is the part a methods section is asked about.
   */
  status?: "superseded" | "resolved";
  closedAt?: string;
  /** The item that replaced or answered this one. */
  by?: string;
  /** On the newer item, once accepted: what it replaced. */
  supersedes?: string;
  /** On the newer item, once accepted: the open question it answered. */
  resolves?: string;
  /**
   * An automatic note's claim to replace or answer a note a PERSON wrote or
   * approved. Never applied on its own -- see `addAuto` -- only offered on the
   * project page until someone accepts or dismisses it.
   */
  suggests?: { replaces?: string; resolves?: string };
}

/** Current, as opposed to replaced or answered. The prompt only ever sees these. */
export function isActive(item: MemoryItem): boolean {
  return item.status === undefined;
}

export function activeItems(memory: ProjectMemory): MemoryItem[] {
  return memory.items.filter(isActive);
}

export interface ProjectMemory {
  /** Whether the project's setup chat has run. A simple folder starts "done" with nothing in it. */
  setup: "pending" | "done";
  /** Whether a conversation may add to this memory on its own, before each reply. On by default for a research project. */
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
    const str = (key: string): string | undefined =>
      typeof it[key] === "string" && (it[key] as string) ? (it[key] as string) : undefined;
    const status = it["status"] === "superseded" || it["status"] === "resolved" ? it["status"] : undefined;
    const msg = it["msg"];
    const suggests = parseSuggests(it["suggests"]);
    const optional: Partial<MemoryItem> = {};
    for (const key of ["from", "quote", "meeting", "meetingAt", "closedAt", "by", "supersedes", "resolves"] as const) {
      const value = str(key);
      if (value) optional[key] = value;
    }
    items.push({
      id,
      slot,
      text,
      source: source === "you" || source === "setup" || source === "auto" ? source : "you",
      at: typeof it["at"] === "string" ? it["at"] : new Date(0).toISOString(),
      ...optional,
      ...(typeof msg === "number" && Number.isInteger(msg) && msg >= 0 ? { msg } : {}),
      ...(status ? { status } : {}),
      ...(suggests ? { suggests } : {}),
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

function parseSuggests(raw: unknown): MemoryItem["suggests"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const out: NonNullable<MemoryItem["suggests"]> = {};
  if (typeof row["replaces"] === "string" && row["replaces"]) out.replaces = row["replaces"];
  if (typeof row["resolves"] === "string" && row["resolves"]) out.resolves = row["resolves"];
  return out.replaces || out.resolves ? out : undefined;
}

/* ------------------------------------------------------------------ *
 * Editing                                                             *
 * ------------------------------------------------------------------ */

export interface NewItem {
  slot: MemorySlot;
  text: string;
}

/** Where an item came from, carried alongside it into storage. */
export interface Provenance {
  /** The conversation, for an item a person approved from one (the update button). */
  from?: string | undefined;
  quote?: string | undefined;
  msg?: number | undefined;
  meeting?: string | undefined;
  meetingAt?: string | undefined;
}

/** The provenance fields that are actually set, so none is written as `undefined`. */
function provenanceOf(p: Provenance): Partial<MemoryItem> {
  const out: Partial<MemoryItem> = {};
  if (p.from) out.from = p.from;
  if (p.quote?.trim()) out.quote = p.quote.trim().slice(0, QUOTE_CHARS);
  if (typeof p.msg === "number" && Number.isInteger(p.msg) && p.msg >= 0) out.msg = p.msg;
  if (p.meeting) out.meeting = p.meeting;
  if (p.meetingAt) out.meetingAt = p.meetingAt;
  return out;
}

/** Long enough to recognise a line by, short enough not to become a second copy of the conversation. */
const QUOTE_CHARS = 400;

/** Add items the user has just approved -- setup, a manual edit, or a meeting's reviewed items. */
export function addItems(
  memory: ProjectMemory,
  proposed: readonly (NewItem & Provenance)[],
  source: Exclude<ItemSource, "auto">,
  now = new Date(),
): ProjectMemory {
  const at = now.toISOString();
  const items = [...memory.items];
  for (const p of proposed) {
    const text = p.text.trim();
    if (!text) continue;
    items.push({ id: randomId(), slot: p.slot, text, source, at, ...provenanceOf(p) });
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

/* ------------------------------------------------------------------ *
 * Replacing and answering                                             *
 * ------------------------------------------------------------------ */

function mapItems(memory: ProjectMemory, fn: (item: MemoryItem) => MemoryItem): ProjectMemory {
  let changed = false;
  const items = memory.items.map((it) => {
    const next = fn(it);
    if (next !== it) changed = true;
    return next;
  });
  return changed ? { ...memory, items } : memory;
}

/** Without the given keys -- `exactOptionalPropertyTypes` will not let a field be set to undefined. */
function without(item: MemoryItem, ...keys: (keyof MemoryItem)[]): MemoryItem {
  const copy = { ...item };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Clear one half of a `suggests` claim, dropping the field entirely once
 * both halves are gone -- never the other half, which may still be waiting
 * on a person. An item can carry both a `replaces` and a `resolves`
 * suggestion at once (`addAuto` sets both from one proposal), and only one
 * of the two may be settled by a given call.
 */
function withoutSuggestion(item: MemoryItem, key: "replaces" | "resolves"): MemoryItem {
  if (!item.suggests) return item;
  const suggests = { ...item.suggests };
  delete suggests[key];
  return suggests.replaces || suggests.resolves ? { ...item, suggests } : without(item, "suggests");
}

/**
 * Close `oldId` as replaced by `newId`, both already in the memory.
 *
 * The link is written on both sides, so the history can say "replaced by …"
 * under the old note and "replaced …" under the new one without a search.
 */
function link(
  memory: ProjectMemory,
  oldId: string,
  newId: string,
  kind: "superseded" | "resolved",
  now: Date,
): ProjectMemory {
  const old = memory.items.find((it) => it.id === oldId);
  if (!old || !isActive(old) || oldId === newId || !memory.items.some((it) => it.id === newId)) return memory;
  const closedAt = now.toISOString();
  return mapItems(memory, (it) => {
    if (it.id === oldId) return { ...it, status: kind, closedAt, by: newId };
    if (it.id === newId) {
      const cleared = withoutSuggestion(it, kind === "superseded" ? "replaces" : "resolves");
      return kind === "superseded" ? { ...cleared, supersedes: oldId } : { ...cleared, resolves: oldId };
    }
    return it;
  });
}

/**
 * Replace a note with new text: the old one closes, the new one is the person's own.
 *
 * Not an edit. Editing rewrites the note in place, which is right for a typo
 * and wrong for "we changed our minds" -- that change is itself the thing a
 * supervisor or a reviewer asks about later, so both halves are kept.
 */
export function supersede(memory: ProjectMemory, oldId: string, text: string, now = new Date()): ProjectMemory {
  const old = memory.items.find((it) => it.id === oldId);
  const trimmed = text.trim();
  if (!old || !isActive(old) || !trimmed) return memory;
  const item: MemoryItem = { id: randomId(), slot: old.slot, text: trimmed, source: "you", at: now.toISOString() };
  return link({ ...memory, items: [...memory.items, item] }, oldId, item.id, "superseded", now);
}

/**
 * Mark an open question answered -- by a new decision in the person's words,
 * by a note that already exists, or by nothing in particular.
 */
export function resolve(
  memory: ProjectMemory,
  openId: string,
  by: { text: string } | { id: string } | undefined,
  now = new Date(),
): ProjectMemory {
  const open = memory.items.find((it) => it.id === openId);
  if (!open || !isActive(open)) return memory;
  if (by && "id" in by) return link(memory, openId, by.id, "resolved", now);
  const text = by?.text.trim();
  if (text) {
    const item: MemoryItem = { id: randomId(), slot: "decisions", text, source: "you", at: now.toISOString() };
    return link({ ...memory, items: [...memory.items, item] }, openId, item.id, "resolved", now);
  }
  return mapItems(memory, (it) => (it.id === openId ? { ...it, status: "resolved", closedAt: now.toISOString() } : it));
}

/** Put a closed note back, and drop every link that pointed at it being closed. */
export function reopen(memory: ProjectMemory, id: string): ProjectMemory {
  const item = memory.items.find((it) => it.id === id);
  if (!item || isActive(item)) return memory;
  return mapItems(memory, (it) => {
    if (it.id === id) return without(it, "status", "closedAt", "by");
    if (it.supersedes === id) return without(it, "supersedes");
    if (it.resolves === id) return without(it, "resolves");
    return it;
  });
}

/** Apply what an automatic note suggested: the person has agreed it replaces (or answers) theirs. */
export function acceptSuggestion(memory: ProjectMemory, id: string, now = new Date()): ProjectMemory {
  const item = memory.items.find((it) => it.id === id);
  if (!item?.suggests) return memory;
  const { replaces, resolves } = item.suggests;
  let next = memory;
  if (replaces) next = link(next, replaces, id, "superseded", now);
  if (resolves) next = link(next, resolves, id, "resolved", now);
  /* A suggestion whose target has since gone -- deleted, or closed by hand --
     is spent either way, so it does not sit on the page asking forever. */
  return mapItems(next, (it) => (it.id === id && it.suggests ? without(it, "suggests") : it));
}

/** Keep both: the automatic note stays, the one it wanted to replace is untouched. */
export function dismissSuggestion(memory: ProjectMemory, id: string): ProjectMemory {
  return mapItems(memory, (it) => (it.id === id && it.suggests ? without(it, "suggests") : it));
}

/** Suggestions still waiting on a person, with what each one points at. */
export function pendingSuggestions(memory: ProjectMemory): { item: MemoryItem; target: MemoryItem; kind: "replaces" | "resolves" }[] {
  const byId = new Map(memory.items.map((it) => [it.id, it]));
  const out: { item: MemoryItem; target: MemoryItem; kind: "replaces" | "resolves" }[] = [];
  for (const item of memory.items) {
    if (!item.suggests || !isActive(item)) continue;
    for (const kind of ["replaces", "resolves"] as const) {
      const target = item.suggests[kind] ? byId.get(item.suggests[kind]) : undefined;
      if (target && isActive(target)) out.push({ item, target, kind });
    }
  }
  return out;
}

export function setAuto(memory: ProjectMemory, auto: boolean): ProjectMemory {
  return memory.auto === auto ? memory : { ...memory, auto };
}

export function markSetupDone(memory: ProjectMemory): ProjectMemory {
  return memory.setup === "done" ? memory : { ...memory, setup: "done" };
}

/**
 * A grounded item on its way in from an automatic pass: its provenance, and
 * -- by id, already resolved from the number the model was shown -- the note
 * it says it replaces or the open question it says it answers.
 */
export interface AutoItem extends NewItem, Provenance {
  replaces?: string | undefined;
  resolves?: string | undefined;
}

/**
 * Grounded items from an automatic pass, folded in.
 *
 * `seen` moves regardless of whether anything was added, so a quiet stretch
 * of conversation is not re-read next time. The rules on what an automatic
 * item may do to the notes already there are `addAuto`'s.
 */
export function mergeAuto(
  memory: ProjectMemory,
  proposed: readonly AutoItem[],
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
 * conversation's watermark where it was -- moving it would let the automatic pass
 * skip everything said after this one note.
 *
 * **Replacing is split by who wrote the note being replaced.** An `"auto"`
 * note nobody wrote may be closed by a newer automatic one on the spot --
 * "actually, let's use interviews" should not leave the survey plan standing
 * in the prompt. A note a person wrote or approved never is: the new note is
 * added beside it carrying a `suggests`, and the project page asks. That keeps
 * the rule this feature was built on literally true -- an automatic write
 * never changes what a person wrote or approved.
 *
 * Deduplicated against CURRENT notes only: a decision reverted to its earlier
 * wording is a new decision, not a duplicate of the one it replaced.
 *
 * `source` is `"auto"` for the unattended pass and the `remember` tool, and
 * `"you"` for the "Update project notes from this chat" button -- the same
 * grounded replaces/resolves claims, saved under whichever provenance the
 * caller actually has. The closing rule below reads the TARGET's source, not
 * this one, so a reviewed button click still only closes an auto-sourced note
 * on the spot; a person's own prior note still only ever gets a `suggests`,
 * because the review dialog shows the new note's text, never "and this
 * closes note #3".
 */
export function addAuto(
  memory: ProjectMemory,
  proposed: readonly AutoItem[],
  sessionId: string,
  now = new Date(),
  source: Exclude<ItemSource, "setup"> = "auto",
): ProjectMemory {
  const at = now.toISOString();
  let next = memory;
  for (const p of proposed) {
    const text = p.text.trim();
    if (!text) continue;
    const dup = next.items.some(
      (it) => isActive(it) && it.slot === p.slot && it.text.toLowerCase() === text.toLowerCase(),
    );
    if (dup) continue;

    const item: MemoryItem = { id: randomId(), slot: p.slot, text, source, at, ...provenanceOf(p), from: sessionId };
    const replaces = targetOf(next, p.replaces, (t) => t.slot === p.slot);
    const resolves = targetOf(next, p.resolves, (t) => t.slot === "open");
    const suggests: NonNullable<MemoryItem["suggests"]> = {};
    if (replaces && replaces.source !== "auto") suggests.replaces = replaces.id;
    if (resolves && resolves.source !== "auto") suggests.resolves = resolves.id;
    next = { ...next, items: [...next.items, suggests.replaces || suggests.resolves ? { ...item, suggests } : item] };

    if (replaces?.source === "auto") next = link(next, replaces.id, item.id, "superseded", now);
    if (resolves?.source === "auto") next = link(next, resolves.id, item.id, "resolved", now);
  }
  return next;
}

/** A current note by id, if it is one the claim can apply to. */
function targetOf(
  memory: ProjectMemory,
  id: string | undefined,
  fits: (target: MemoryItem) => boolean,
): MemoryItem | undefined {
  if (!id) return undefined;
  const target = memory.items.find((it) => it.id === id);
  return target && isActive(target) && fits(target) ? target : undefined;
}

/* ------------------------------------------------------------------ *
 * Rendering, for the system prompt                                   *
 * ------------------------------------------------------------------ */

function blockFor(slot: MemorySlot, items: readonly MemoryItem[]): string {
  const own = items.filter((it) => it.slot === slot && isActive(it));
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
    const own = memory.items.filter((it) => it.slot === slot && isActive(it));
    if (!own.length) return "";
    return [`## ${SLOT_LABELS[slot]}`, "", ...own.map((it) => `- ${it.text}`)].join("\n");
  }).filter(Boolean);
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/** The fields a research run is scoped from -- context and open questions are not a scope. */
const SEED_SLOTS: readonly MemorySlot[] = ["questions", "aims", "theory", "methods", "decisions", "literature"];
/** The fields a paper is written from. Not `literature`: the drafter forbids citations outright. */
const BRIEF_SLOTS: readonly MemorySlot[] = ["questions", "aims", "theory", "methods", "decisions"];

function plainBlocks(memory: ProjectMemory, slots: readonly MemorySlot[]): string {
  return slots
    .map((slot) => blockFor(slot, memory.items))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The notes a deep research run's scoping reads -- what the researcher has
 * already settled, so the run does not ask it again. Current notes only, the
 * same "Label:" lines the chat prompt gets. Empty when there is nothing to seed.
 */
export function renderSeed(memory: ProjectMemory): string {
  return plainBlocks(memory, SEED_SLOTS);
}

/**
 * The notes a paper is drafted from, as text for the author's own
 * instructions box -- where they are shown, edited and previewed before a
 * word is sent. Deterministic: no model rewrites them on the way in.
 */
export function renderPaperBrief(memory: ProjectMemory): string {
  const body = plainBlocks(memory, BRIEF_SLOTS);
  return body ? `From this project's notes:\n\n${body}` : "";
}

/**
 * Every note, current and closed, in the order it was written -- the
 * project's decision log, for the export.
 *
 * `memory.md` says what the project stands on now. This says how it got
 * there: when each note arrived, who put it there, the words it rests on, and
 * what replaced or answered it. That is the record a methods chapter, a
 * pre-registration deviation or a reviewer's "why this and not that" is
 * written from, and nobody has to have kept it by hand. `origin` names a
 * conversation or a meeting, since only main can look their titles up.
 */
export function renderDecisionLog(
  memory: ProjectMemory,
  origin: (item: MemoryItem) => string | undefined,
): string {
  if (!memory.items.length) return "";
  const byId = new Map(memory.items.map((it) => [it.id, it]));
  const ordered = [...memory.items].sort((a, b) => a.at.localeCompare(b.at));
  const who: Record<ItemSource, string> = { you: "added by you", setup: "from project setup", auto: "noted automatically" };

  const lines = ["# Decision log", "", "Every note this project has kept, oldest first — including the ones later replaced or answered.", ""];
  let day = "";
  for (const item of ordered) {
    const date = logDate(item.at);
    if (date !== day) {
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(`## ${date || "Undated"}`, "");
      day = date;
    }
    const closed = item.status === "superseded" ? " *(replaced)*" : item.status === "resolved" ? " *(answered)*" : "";
    lines.push(`- **${SLOT_LABELS[item.slot]}:** ${item.text}${closed}`);
    const where = origin(item);
    lines.push(`  - ${who[item.source]}${where ? `, ${where}` : ""}`);
    if (item.quote) lines.push(`  - rests on: “${item.quote}”`);
    const earlier = item.supersedes ? byId.get(item.supersedes) : undefined;
    if (earlier) lines.push(`  - replaced: “${earlier.text}”`);
    const answered = item.resolves ? byId.get(item.resolves) : undefined;
    if (answered) lines.push(`  - answered: “${answered.text}”`);
    const later = item.by ? byId.get(item.by) : undefined;
    if (later) {
      const verb = item.status === "resolved" ? "answered by" : "replaced by";
      lines.push(`  - ${verb} “${later.text}”${item.closedAt ? ` on ${logDate(item.closedAt)}` : ""}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function logDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) || at.getTime() === 0
    ? ""
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
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

/**
 * An opening marker with no closing one strips to the end of the message.
 * `asUntrusted` always writes both, so an unterminated block means something
 * was cut short -- and keeping the tail of a cut-short document as the user's
 * own words is exactly the failure this function exists to prevent.
 */
function stripUntrusted(text: string): string {
  return text.replace(/<<<UNTRUSTED CONTENT[\s\S]*?(?:<<<END UNTRUSTED CONTENT>>>|$)/g, " ");
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
export function fieldsToItems<T extends NewItem>(items: readonly T[], values: Record<string, string>): T[] {
  const out: T[] = [];
  items.forEach((item, i) => {
    const text = (values[`item-${i}`] ?? "").trim();
    /* Everything else the item carried -- its quote, the message or meeting it
       came from -- rides through the review untouched: the person edited the
       wording, not the evidence. */
    if (text) out.push({ ...item, text });
  });
  return out;
}
