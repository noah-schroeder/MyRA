/**
 * The planning conversation: what gets asked, and how an answer comes back.
 *
 * Scoping used to ask its questions as blank text boxes. The model had already
 * decided which slot it was asking about -- population, timeframe, what counts
 * as in scope -- so it knows the shape of a good answer, and asking it to
 * propose two to four of them turns a blank box into a decision. What it must
 * NOT do is bound the answer: "Other" is added here, by the app, on every
 * question, and skipping stays possible because "I don't care about that" is a
 * real answer to a question about an ambiguity.
 *
 * Everything in this file is pure. The dialogs live in the renderer and the
 * plumbing in the main process; this is the part that decides what a question
 * means and what an answer to it is, which is the part worth testing.
 */

import type { Role } from "./roles.ts";

/** What the UI adds to every set of options, and never receives from a model. */
export const OTHER = "Other…";

export interface Choice {
  title: string;
  message?: string;
  options: string[];
  /** Several answers can be true at once — criteria, mostly. */
  multi?: boolean;
}

/**
 * Several answers, joined into the one string the prompt channel carries.
 *
 * "; " rather than ", " because the answers are phrases and several of them
 * contain commas -- "adults, 18 and over" is one option, not two.
 */
export const JOIN = "; ";

export function joinAnswers(picked: string[]): string {
  return picked.filter((p) => p.trim()).join(JOIN);
}

/**
 * Options a model proposed, made fit to show.
 *
 * Trimmed, de-duplicated case-insensitively, capped at four, and stripped of
 * anything that is really an instruction rather than an answer. A model that
 * offers "Other", "All of the above" or "None of these" is proposing the two
 * things the UI already provides -- an escape hatch and a skip -- and showing
 * them twice makes the list read as though the app were guessing.
 */
const NOT_AN_ANSWER =
  /^(other|another|something else|all of (the )?above|none( of (these|the above))?|n\/?a|any|no preference|skip)\.?$/i;

export function cleanOptions(raw: unknown, cap = 4): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const option = entry.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!option || NOT_AN_ANSWER.test(option)) continue;
    const key = option.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option);
    if (out.length >= cap) break;
  }
  /* One option is not a choice, it is a leading question. Below two, the
     question falls back to the text box it used to be. */
  return out.length >= 2 ? out : [];
}

/* --------------------------------------------------------------- depth --- */

/**
 * How much of the literature the run actually looks at.
 *
 * These were four numbers in a markdown document, which is a fair way to store
 * them and a poor way to choose them: nobody can pick 150 over 250 from a blank
 * field. As one question they are what they really are -- how long this takes
 * and how much it costs against how much it misses.
 *
 * The numbers are still shown, and "Other" still opens them for editing. The
 * point is not to hide them.
 */
export interface Depth {
  /** Result pages requested per query. */
  pages: number;
  /** Candidates that survive ranking and reach the screener. */
  screenTop: number;
  /** Screened-in papers read in full. */
  fullTexts: number;
  /** Rounds of backward citation-graph traversal. 0 is off. */
  snowball: number;
}

export interface DepthPreset extends Depth {
  name: string;
  /** What choosing it costs, in the terms a person is actually trading off. */
  note: string;
}

export const DEPTH_PRESETS: readonly DepthPreset[] = [
  {
    name: "Quick look",
    pages: 1, screenTop: 60, fullTexts: 10, snowball: 0,
    note: "Fastest. Enough to see whether a literature exists and what it calls itself.",
  },
  {
    name: "Standard",
    pages: 2, screenTop: 150, fullTexts: 30, snowball: 0,
    note: "A defensible answer to a focused question.",
  },
  {
    name: "Thorough",
    pages: 3, screenTop: 250, fullTexts: 50, snowball: 1,
    note:
      "Roughly twice a Standard run. One round of citation traversal, which is what finds " +
      "the paper a literature is built on when its title uses the vocabulary of thirty years ago.",
  },
  {
    name: "Exhaustive",
    pages: 4, screenTop: 400, fullTexts: 80, snowball: 2,
    note: "For a review you intend to publish. Long, and the most expensive by a wide margin.",
  },
];

/** Thorough: the question said quality over speed, and this is where that lands. */
export const DEFAULT_DEPTH = "Thorough";

export function depthLabel(preset: DepthPreset): string {
  const pages = `${preset.pages} page${preset.pages === 1 ? "" : "s"}`;
  const snowball =
    preset.snowball === 0
      ? "no citation traversal"
      : `${preset.snowball} round${preset.snowball === 1 ? "" : "s"} of citation traversal`;
  return (
    `${preset.name} — ${pages} per query, ${preset.screenTop} screened, ` +
    `${preset.fullTexts} read in full, ${snowball}`
  );
}

/** The preset a label came back as, or nothing if the user typed their own. */
export function depthFromLabel(answer: string): Depth | undefined {
  const found = DEPTH_PRESETS.find((p) => answer.trim().startsWith(p.name));
  if (!found) return undefined;
  const { name: _name, note: _note, ...depth } = found;
  return depth;
}

/**
 * Four numbers typed by hand, in the shape the plan document already uses.
 *
 * Accepts "pages: 3, screen_top: 250, full_texts: 50, snowball: 1" in any
 * order and with any separators, because this is what somebody types after
 * choosing "Other" and it should not have to be a format.
 */
export function depthFromText(answer: string, fallback: Depth): Depth {
  const num = (names: string[], current: number): number => {
    for (const name of names) {
      const found = new RegExp(`${name}\\D{0,4}(\\d{1,4})`, "i").exec(answer);
      if (found) return Number(found[1]);
    }
    return current;
  };
  return {
    pages: clamp(num(["pages?"], fallback.pages), 1, 10),
    screenTop: clamp(num(["screen[_ ]?top", "screened"], fallback.screenTop), 10, 2000),
    fullTexts: clamp(num(["full[_ ]?texts?", "read"], fallback.fullTexts), 1, 500),
    snowball: clamp(num(["snowball", "traversal", "rounds?"], fallback.snowball), 0, 3),
  };
}

function clamp(n: number, low: number, high: number): number {
  if (!Number.isFinite(n)) return low;
  return Math.min(high, Math.max(low, Math.round(n)));
}

/* -------------------------------------------------------------- models --- */

/** One dropdown in the model question set. */
export interface RoleSlot {
  key: Role | "all" | "embedder";
  label: string;
  hint: string;
}

export const SAME_MODEL_QUESTION: Choice = {
  title: "Use the same model for every stage of the run?",
  message:
    "One model is simplest, and the whole run costs what that model costs.\n\n" +
    "Separate models usually give a better report for less money. Screening reads " +
    "thousands of titles and abstracts and wants something fast and cheap. Synthesis " +
    "writes one long careful answer and wants your best model. And the reviewer should " +
    "not be the model that wrote the draft: asked to critique its own work, a model " +
    "mostly defends the reasoning it already committed to.",
  options: [
    "No — pick a model for each stage",
    "Yes — one model for everything",
  ],
};

export function wantsSeparateModels(answer: string): boolean {
  return /^no\b/i.test(answer.trim());
}

export const ROLE_SLOTS: readonly RoleSlot[] = [
  {
    key: "screener",
    label: "Screener",
    hint: "Reads every candidate title and abstract and decides what stays. The most calls by far, and the cheapest work.",
  },
  {
    key: "analyst",
    label: "Analyst",
    hint: "Scopes the question, writes the search queries, and extracts findings from the papers that are read in full.",
  },
  {
    key: "synthesist",
    label: "Synthesist",
    hint: "Writes the report. One long careful answer: your best model belongs here.",
  },
  {
    key: "reviewer",
    label: "Reviewer",
    hint: "Critiques the draft. Should be a different model from the synthesist, or the review is self-review.",
  },
];

/*
 * The embedder is deliberately NOT one of these.
 *
 * It is not a chat model, and offering the chat catalogue for it would be
 * offering models that cannot do the job. It is set once in Settings →
 * Providers, and the plan document names whichever one is configured.
 */
export const SINGLE_SLOT: RoleSlot = {
  key: "all",
  label: "Model for every stage",
  hint: "Scoping, screening, extraction, synthesis and review all use this one.",
};

/** The preset the stated priority points at, as plain numbers. */
export function defaultDepth(): Depth {
  const found = DEPTH_PRESETS.find((p) => p.name === DEFAULT_DEPTH) ?? DEPTH_PRESETS[1]!;
  const { name: _name, note: _note, ...depth } = found;
  return depth;
}

/**
 * The answer from the model dialog, folded into the roles the run will use.
 *
 * "all" fills every role, which is what the one-model answer means. Anything
 * missing or blank keeps what was already assigned rather than falling back to
 * the app's current model -- a dialog that quietly reset a role the user did
 * not touch would be the plan editor's old write-only bug in a new place.
 */
export function applyRoleAnswer(
  current: Record<Role, string>,
  picked: Record<string, string>,
): Record<Role, string> {
  const one = (picked["all"] ?? "").trim();
  if (one) {
    return { screener: one, analyst: one, synthesist: one, reviewer: one };
  }
  const next = { ...current };
  for (const role of Object.keys(current) as Role[]) {
    const value = (picked[role] ?? "").trim();
    if (value) next[role] = value;
  }
  return next;
}
