/**
 * Socratic scoping: deterministic slots, generated questions.
 *
 * `Scope` always carries the same fields, so nothing downstream can be
 * surprised by its shape. Which questions get ASKED is the model's call, and
 * the value is mostly in what it SKIPS: a fixed template asks "what timeframe?"
 * even when you already wrote "since 2020", and four dialogs confirming things
 * you just said is how a good idea becomes an annoyance.
 *
 * This is not a hole in the pipeline's determinism. The stages, their order and
 * their depth never vary. Scoping is different in kind -- you answer it, you see
 * the result, and it lands in an editable plan before anything expensive runs.
 */

import { parseJsonReply, runSubagent, type SubagentUsage } from "../llm/chat.ts";

export interface Scope {
  question: string;
  subQuestions: string[];
  population?: string;
  timeframe?: string;
  include: string[];
  exclude: string[];
}

/** A slot the model wants filled, phrased for this particular question. */
export interface ScopeQuestion {
  slot: "population" | "timeframe" | "include" | "exclude" | "other";
  ask: string;
  /** Filled in when the user's original question already answers it. */
  prefilled?: string;
}

export interface ScopeDraft {
  subQuestions: string[];
  include: string[];
  exclude: string[];
  population?: string;
  timeframe?: string;
  questions: ScopeQuestion[];
}

export function buildScopePrompt(question: string): string {
  return [
    `The user wants a research report answering:`,
    `  "${question}"`,
    "",
    `Prepare the scope. Two jobs:`,
    "",
    `1. Decompose the question into 3-6 sub-questions that between them answer it.`,
    `   Each should be answerable from literature, and they should not overlap.`,
    "",
    `2. Work out what is still genuinely ambiguous, and ask about ONLY that.`,
    `   If the question already states a population, a timeframe, or what counts as`,
    `   in scope, fill it in as "prefilled" and DO NOT ask about it. Asking the user`,
    `   to confirm what they just wrote is worse than not asking at all.`,
    `   Ask at most 4 questions. Fewer is better. None is a fine answer.`,
    "",
    `Also propose inclusion and exclusion criteria for screening — concrete and`,
    `checkable from a title and abstract, not statements of taste.`,
    "",
    `Reply with JSON only:`,
    `{`,
    `  "subQuestions": ["..."],`,
    `  "population": "<if stated or clearly implied, else omit>",`,
    `  "timeframe": "<if stated or clearly implied, else omit>",`,
    `  "include": ["..."],`,
    `  "exclude": ["..."],`,
    `  "questions": [{"slot": "population|timeframe|include|exclude|other",`,
    `                 "ask": "<the question, one line>"}]`,
    `}`,
  ].join("\n");
}

interface RawScope {
  subQuestions?: unknown;
  population?: unknown;
  timeframe?: unknown;
  include?: unknown;
  exclude?: unknown;
  questions?: unknown;
}

const SLOTS = ["population", "timeframe", "include", "exclude", "other"] as const;

function strings(value: unknown, cap = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, cap);
}

export function parseScopeDraft(reply: string, question: string): ScopeDraft {
  const raw = parseJsonReply<RawScope>(reply, "scoping reply");
  const questions: ScopeQuestion[] = [];
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    const row = q as { slot?: unknown; ask?: unknown };
    const ask = typeof row?.ask === "string" ? row.ask.trim() : "";
    if (!ask) continue;
    const slot = SLOTS.includes(row?.slot as (typeof SLOTS)[number])
      ? (row.slot as ScopeQuestion["slot"])
      : "other";
    questions.push({ slot, ask });
    if (questions.length >= 4) break;
  }

  const subQuestions = strings(raw.subQuestions, 6);
  return {
    // A scope with no sub-questions would search once and call it a sweep.
    subQuestions: subQuestions.length ? subQuestions : [question],
    include: strings(raw.include),
    exclude: strings(raw.exclude),
    ...(typeof raw.population === "string" && raw.population.trim()
      ? { population: raw.population.trim() }
      : {}),
    ...(typeof raw.timeframe === "string" && raw.timeframe.trim()
      ? { timeframe: raw.timeframe.trim() }
      : {}),
    questions,
  };
}

/** Fold the user's answers into the scope. Blank answers leave the slot alone. */
export function applyAnswers(
  draft: ScopeDraft,
  question: string,
  answers: Map<ScopeQuestion, string>,
): Scope {
  const scope: Scope = {
    question,
    subQuestions: draft.subQuestions,
    include: [...draft.include],
    exclude: [...draft.exclude],
    ...(draft.population ? { population: draft.population } : {}),
    ...(draft.timeframe ? { timeframe: draft.timeframe } : {}),
  };

  for (const [q, answer] of answers) {
    const value = answer.trim();
    if (!value) continue; // skipped question: keep whatever the model inferred
    switch (q.slot) {
      case "population": scope.population = value; break;
      case "timeframe": scope.timeframe = value; break;
      case "include": scope.include.push(value); break;
      case "exclude": scope.exclude.push(value); break;
      // An "other" answer is a constraint with nowhere structured to live, so
      // it becomes an inclusion criterion rather than being dropped.
      default: scope.include.push(value);
    }
  }
  return scope;
}

export interface ScopeDraftResult {
  draft: ScopeDraft;
  usage: SubagentUsage;
}

export async function draftScope(opts: {
  question: string;
  model: string;
  signal?: AbortSignal;
  cwd?: string;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<ScopeDraftResult> {
  const result = await runSubagent({
    model: opts.model,
    prompt: buildScopePrompt(opts.question),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });
  return { draft: parseScopeDraft(result.text, opts.question), usage: result.usage };
}
