/**
 * From transcript to notes.
 *
 * Two passes: extract grounded items, then compose prose from them. Between the
 * two sits the step that makes the result trustworthy — every quote the model
 * produced is looked up in the transcript, and the item's timestamp is taken
 * from the line that was actually found rather than from what the model claimed
 * it was. A model that reconstructs a quote will also reconstruct its
 * timestamp, so the model's own `at` field is never believed.
 */

import type { EndpointSettings } from "../config.ts";
import { chat } from "../llm/chat.ts";
import {
  compositionPrompt, extractionPrompt, type ChatMessage, type MeetingContext,
} from "./meetingPrompts.ts";
import { timecode, verifyQuote, type Line } from "./transcript.ts";

export class NotesError extends Error {
  override readonly name = "NotesError";
}

export const ITEM_TYPES = ["decision", "action", "update", "question", "risk"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface ExtractedItem {
  project: string;
  type: ItemType;
  title: string;
  owner: string | null;
  due: string | null;
  quote: string;
  certain: boolean;
}

export interface VerifiedItem extends ExtractedItem {
  /** Timestamp of the transcript line the quote was found in. */
  at: string | null;
  /** verbatim | reworded | unverified. */
  sourcing: "verbatim" | "reworded" | "unverified";
  /** The transcript line itself, for the hover card and the audit. */
  sourceText?: string;
  speaker?: string;
}

/**
 * Pull the JSON object out of a chat reply.
 *
 * Models wrap JSON in prose and in markdown fences no matter how firmly they
 * are told not to, and failing the whole meeting over a fence would be absurd.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the harder cases */
  }

  // A fenced block, with or without a language tag.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep looking */
    }
  }

  // Otherwise take the outermost braces and hope the middle is well formed.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* nothing more to try */
    }
  }
  throw new NotesError("The model's reply was not JSON, and no JSON could be found in it.");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the extraction reply into items, discarding what cannot be trusted.
 *
 * An unrecognised type becomes an update rather than being dropped or guessed
 * at: update is the bucket with no consequences, and the alternative is junk
 * arriving in someone's task list because a model wrote "todo" instead of
 * "action".
 */
export function parseItems(raw: string): ExtractedItem[] {
  const body = extractJson(raw) as { items?: unknown };
  const list = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : undefined;
  if (!list) throw new NotesError("The model's reply had no `items` array.");

  const items: ExtractedItem[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const title = str(row.title);
    if (!title) continue;

    const rawType = str(row.type).toLowerCase();
    const type = (ITEM_TYPES as readonly string[]).includes(rawType) ? (rawType as ItemType) : "update";

    const owner = str(row.owner);
    const due = str(row.due);
    items.push({
      project: str(row.project) || "General",
      type,
      title,
      // "null", "none" and "unassigned" all come back as strings from models.
      owner: owner && !/^(null|none|unassigned|unknown|n\/a)$/i.test(owner) ? owner : null,
      due: due && !/^(null|none|n\/a)$/i.test(due) ? due : null,
      quote: str(row.quote),
      certain: row.certain !== false,
    });
  }
  return items;
}

/**
 * Attach each item to the transcript line it came from.
 *
 * This is the whole point of the exercise. An item whose quote is verbatim is
 * sourced; one that was reworded is shown with its nearest line and marked; one
 * that matches nothing is marked unverified, and the app must never present it
 * as though it had a source.
 */
export function verifyItems(items: ExtractedItem[], lines: Line[]): VerifiedItem[] {
  return items.map((item) => {
    const match = item.quote ? verifyQuote(lines, item.quote) : undefined;
    if (!match) {
      return { ...item, at: null, sourcing: "unverified" as const };
    }
    return {
      ...item,
      // The model's own timestamp is not used: a reconstructed quote comes with
      // a reconstructed time, and the found line knows when it actually was.
      at: timecode(match.line.at),
      sourcing: match.exact ? ("verbatim" as const) : ("reworded" as const),
      sourceText: match.line.text,
      speaker: match.line.speaker,
    };
  });
}

export interface MeetingNotes {
  markdown: string;
  items: VerifiedItem[];
  /** Action items only, already verified — what the review queue is offered. */
  actions: VerifiedItem[];
}

export interface GenerateOptions {
  endpoint: EndpointSettings;
  context: MeetingContext;
  lines: Line[];
  transcript: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Progress, for the UI: this runs for minutes, not seconds. */
  onProgress?: (stage: "extracting" | "verifying" | "writing", detail?: string) => void;
}

/** Extract, verify, then write. */
export async function generateNotes(opts: GenerateOptions): Promise<MeetingNotes> {
  const { endpoint, context, lines, transcript } = opts;

  opts.onProgress?.("extracting");
  const extraction = (await chat({
    endpoint,
    messages: extractionPrompt(context, transcript),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })).text;
  const parsed = parseItems(extraction);

  opts.onProgress?.("verifying", `${parsed.length} items`);
  const items = verifyItems(parsed, lines);

  opts.onProgress?.("writing");
  // Composition sees the verified items, so it cannot restate a claim whose
  // source could not be found without that being visible in the item list.
  const markdown = (await chat({
    endpoint,
    messages: compositionPrompt(context, JSON.stringify({ items }, null, 2), transcript),
    temperature: 0.4,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })).text;

  return {
    markdown: markdown.trim(),
    items,
    actions: items.filter((item) => item.type === "action"),
  };
}
