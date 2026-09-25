/**
 * The research-project setup chat: what gets asked, and how an answer parses.
 *
 * Same shape as scoping ([research/scope.ts](../research/scope.ts)) for the
 * same reason -- fixed slots, generated questions, options a small model
 * proposes rather than a form it has to fill in from nothing -- applied to a
 * different moment: this runs once, the first time somebody describes a new
 * research project, rather than once per run.
 *
 * Everything here is pure text in, parsed data out. The chat turn that drives
 * it (asking, showing dialogs, saving what comes back) lives in
 * [main/projectMemory.ts](../../main/projectMemory.ts), the same split
 * `draftScope` keeps from the pipeline that calls it.
 */

import { parseJsonReply } from "../llm/chat.ts";
import { cleanOptions, JOIN } from "../research/questions.ts";
import { activeItems, isMemorySlot, MEMORY_SLOTS, SLOT_LABELS, type NewItem, type ProjectMemory } from "./memory.ts";
import { SETUP_GREETING } from "./greeting.ts";

export { SETUP_GREETING };

/** One thing the setup chat can help with. */
export interface Task {
  id: string;
  label: string;
  why: string;
}

/**
 * Offered when the model's own proposal comes back unusable.
 *
 * The same floor `cleanOptions` holds a scoping question to: fewer than two
 * real options is not a menu. Every research project can use these five, so a
 * small model that cannot tailor them should degrade to them rather than to a
 * dialog with nothing worth picking.
 */
export const FIXED_TASKS: readonly Task[] = [
  {
    id: "questions",
    label: "Brainstorm research questions",
    why: "Turn what you described into a short list of answerable questions.",
  },
  {
    id: "theory",
    label: "Suggest guiding theories",
    why: "Frameworks that fit what you're studying, to argue with or adopt.",
  },
  { id: "scope", label: "Sharpen the scope", why: "Work out what's actually in and out of this project." },
  { id: "methods", label: "Think through methods", why: "Talk through how you might go about answering this." },
  {
    id: "literature",
    label: "Note key literature",
    why: "Write down papers, authors or debates you already know are central.",
  },
];

export interface OffersDraft {
  /** Pulled directly from the description -- only what was actually said. */
  items: NewItem[];
  offers: Task[];
}

export function buildOffersPrompt(description: string): string {
  return [
    `A researcher just described a new project:`,
    `"""${description}"""`,
    ``,
    `Two jobs.`,
    ``,
    `1. Pull out anything they stated as fact -- an aim, a research question, a theory they're`,
    `   working from, a method they've already decided on, a decision already made, a paper or`,
    `   author they named as central (slot "literature"), something still genuinely open, or`,
    `   background context. Only what they actually said; do not invent or infer anything beyond`,
    `   it. None is a fine answer if they were vague.`,
    ``,
    `2. Suggest 3-5 concrete ways you could help them develop this further. Each needs a short`,
    `   label, a few words, imperative ("Brainstorm research questions") and one line on why it`,
    `   would help THIS project specifically -- not a generic description of the offer.`,
    ``,
    `Reply with JSON only:`,
    `{`,
    `  "items": [{"slot": "${MEMORY_SLOTS.join("|")}", "text": "..."}],`,
    `  "offers": [{"label": "...", "why": "..."}]`,
    `}`,
  ].join("\n");
}

interface RawOffers {
  items?: unknown;
  offers?: unknown;
}

function slugify(label: string, fallback: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
}

/**
 * A label or a "why", trimmed and capped -- and never carrying `JOIN`
 * ("; "), which is what several chosen offers come back joined by. A label
 * that happened to contain it would make that answer unsplittable from the
 * next one.
 */
function clean(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").replace(new RegExp(JOIN, "g"), ", ").slice(0, cap);
}

export function parseOffers(reply: string): OffersDraft {
  let raw: RawOffers;
  try {
    raw = parseJsonReply<RawOffers>(reply, "project setup reply");
  } catch {
    return { items: [], offers: [...FIXED_TASKS] };
  }

  const items: NewItem[] = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { slot?: unknown; text?: unknown };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || !isMemorySlot(row.slot)) continue;
    items.push({ slot: row.slot, text });
    if (items.length >= 20) break;
  }

  const offers: Task[] = [];
  for (const entry of Array.isArray(raw.offers) ? raw.offers : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { label?: unknown; why?: unknown };
    const label = clean(row.label, 80);
    if (!label) continue;
    const why = clean(row.why, 200);
    offers.push({ id: slugify(label, `offer-${offers.length}`), label, why });
    if (offers.length >= 6) break;
  }

  return { items, offers: offers.length >= 2 ? offers : [...FIXED_TASKS] };
}

/* ---------------------------------------------------------- one task ---- */

export interface TaskQuestion {
  ask: string;
  options: string[];
  multi?: boolean;
}

function knownSoFar(memory: ProjectMemory): string {
  const current = activeItems(memory);
  if (!current.length) return "";
  return `\n\nAlready noted about this project:\n${current
    .map((i) => `- (${SLOT_LABELS[i.slot]}) ${i.text}`)
    .join("\n")}`;
}

export function buildTaskQuestionsPrompt(task: Task, description: string, memory: ProjectMemory): string {
  return [
    `A researcher described their project as:`,
    `"""${description}"""${knownSoFar(memory)}`,
    ``,
    `They asked for help with: "${task.label}" (${task.why})`,
    ``,
    `Ask up to 3 short questions that would sharpen this work, all at once. For each, if there are`,
    `2-4 concrete answers a researcher in this area would plausibly give, propose them as`,
    `"options" -- specific to this project, mutually exclusive unless you set "multi": true, and`,
    `never "Other", "None" or "All of the above". If a question is too open for that, give no`,
    `options and it will be asked as free text. None is a fine answer if nothing needs asking.`,
    ``,
    `Reply with JSON only:`,
    `{"questions": [{"ask": "...", "options": ["..."], "multi": false}]}`,
  ].join("\n");
}

interface RawQuestions {
  questions?: unknown;
}

export function parseTaskQuestions(reply: string): TaskQuestion[] {
  let raw: RawQuestions;
  try {
    raw = parseJsonReply<RawQuestions>(reply, "project task questions");
  } catch {
    return [];
  }
  const out: TaskQuestion[] = [];
  for (const entry of Array.isArray(raw.questions) ? raw.questions : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { ask?: unknown; options?: unknown; multi?: unknown };
    const ask = typeof row.ask === "string" ? row.ask.trim() : "";
    if (!ask) continue;
    out.push({ ask, options: cleanOptions(row.options), ...(row.multi === true ? { multi: true } : {}) });
    if (out.length >= 3) break;
  }
  return out;
}

export interface AnsweredQuestion {
  ask: string;
  /** Empty when the question was skipped. */
  answer: string;
}

export function buildTaskResultPrompt(
  task: Task,
  description: string,
  answers: readonly AnsweredQuestion[],
  memory: ProjectMemory,
): string {
  const qa = answers.length
    ? `\n\nThe researcher answered:\n${answers
        .map((a) => `Q: ${a.ask}\nA: ${a.answer || "(skipped)"}`)
        .join("\n\n")}`
    : "";
  return [
    `Project: "${description}"${knownSoFar(memory)}`,
    `Task just done: "${task.label}" (${task.why})${qa}`,
    ``,
    `Write 2-6 short, concrete notes worth keeping as a result of this, each one sentence in your`,
    `own words and tagged with the field it belongs under. Do not repeat anything already noted`,
    `above.`,
    ``,
    `Reply with JSON only:`,
    `{"items": [{"slot": "${MEMORY_SLOTS.join("|")}", "text": "..."}]}`,
  ].join("\n");
}

interface RawItems {
  items?: unknown;
}

export function parseTaskResult(reply: string): NewItem[] {
  let raw: RawItems;
  try {
    raw = parseJsonReply<RawItems>(reply, "project task result");
  } catch {
    return [];
  }
  const out: NewItem[] = [];
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { slot?: unknown; text?: unknown };
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || !isMemorySlot(row.slot)) continue;
    out.push({ slot: row.slot, text });
    if (out.length >= 8) break;
  }
  return out;
}
