/**
 * Review and revision.
 *
 * The reviewer runs as a SEPARATE PROCESS with a different model and no sight
 * of the drafting reasoning. That is the whole point: self-critique in the same
 * context mostly produces rationalisation, because the model has already
 * committed to the reasoning it would need to attack.
 *
 * The reviewer sees the draft and the verification flags, but not the raw
 * sources — it is judging whether the report's reasoning holds, not re-reading
 * the literature. Then the synthesist revises against both. Both the original
 * draft and the critique are kept, so the change is inspectable rather than
 * something that happened somewhere in the middle.
 */

import { auditCitations, type SourceRecord } from "./sources.ts";
import { runSubagent, type SubagentUsage } from "./subagent.ts";
import { summarizeChecks, type Check } from "./verify.ts";
import { DanglingCitationError } from "./synthesize.ts";

/** Verification flags, formatted for a model that must act on them. */
export function formatFlags(flagged: Check[]): string {
  if (flagged.length === 0) return "None — every cited statement was judged supported.";
  return flagged
    .map(
      (c) =>
        `  - [${c.source}] ${c.verdict.toUpperCase()}: ${c.note}\n    statement: ${c.sentence}`,
    )
    .join("\n");
}

export function buildReviewPrompt(opts: {
  question: string;
  draft: string;
  checks: Check[];
  flagged: Check[];
}): string {
  return [
    `QUESTION THE REPORT ANSWERS`,
    opts.question,
    "",
    `AUTOMATED VERIFICATION ALREADY RUN`,
    summarizeChecks(opts.checks),
    "",
    `STATEMENTS THE VERIFIER DID NOT FIND SUPPORTED`,
    formatFlags(opts.flagged),
    "",
    `DRAFT REPORT`,
    "<<<BEGIN DRAFT",
    opts.draft,
    "END DRAFT",
    "",
    `Critique this draft. You did not write it and have not seen the reasoning behind`,
    `it — say what is wrong with what is actually on the page.`,
    "",
    `Do not rewrite the report, and do not add citations of your own. The [n] markers`,
    `refer to sources you cannot see; treat the verification results above as what is`,
    `known about whether they hold up.`,
  ].join("\n");
}

export interface ReviewResult {
  review: string;
  usage: SubagentUsage;
  model: string;
}

export async function reviewDraft(opts: {
  question: string;
  draft: string;
  checks: Check[];
  flagged: Check[];
  model: string;
  rubric?: string;
  signal?: AbortSignal;
  cwd?: string;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<ReviewResult> {
  const result = await runSubagent({
    model: opts.model,
    prompt: buildReviewPrompt(opts),
    ...(opts.rubric ? { system: opts.rubric } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });
  return { review: result.text, usage: result.usage, model: result.model };
}

/* ------------------------------------------------------------------ *
 * Revision                                                            *
 * ------------------------------------------------------------------ */

export function buildRevisionPrompt(opts: {
  question: string;
  draft: string;
  review: string;
  flagged: Check[];
  sources: SourceRecord[];
}): string {
  const valid = opts.sources
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((s) => s.n)
    .join(", ");
  return [
    `QUESTION`,
    opts.question,
    "",
    `YOUR DRAFT`,
    "<<<BEGIN DRAFT",
    opts.draft,
    "END DRAFT",
    "",
    `REVIEWER'S CRITIQUE`,
    "<<<BEGIN REVIEW",
    opts.review,
    "END REVIEW",
    "",
    `STATEMENTS THE VERIFIER DID NOT FIND SUPPORTED`,
    formatFlags(opts.flagged),
    "",
    `Revise the report to address both.`,
    "",
    `  - A statement the verifier did not find supported must be weakened to what the`,
    `    source does show, moved to a source that does show it, or removed. Do not`,
    `    leave it standing with the same citation.`,
    `  - Where the reviewer is wrong, keep your position and say why in the text. You`,
    `    are not obliged to agree; you are obliged to answer.`,
    `  - Do not add new claims, and do not add citations to sources that were not`,
    `    already cited. You have no new evidence — only the critique.`,
    `  - Valid source numbers are: ${valid}. Nothing else is a citation.`,
    `  - Still no reference list, no author names, no years, no URLs.`,
    "",
    `Return the full revised report in markdown, not a list of changes.`,
  ].join("\n");
}

export interface RevisionResult {
  report: string;
  usage: SubagentUsage;
  model: string;
}

/**
 * Revise, and hold the revision to the same citation rule as the draft.
 *
 * A revision is exactly where a citation can drift: the model is rewriting
 * sentences that carry markers, and a renumbered or invented one here would
 * land in the final report rather than an intermediate file.
 */
export async function reviseDraft(opts: {
  question: string;
  draft: string;
  review: string;
  flagged: Check[];
  sources: SourceRecord[];
  model: string;
  signal?: AbortSignal;
  cwd?: string;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<RevisionResult> {
  const result = await runSubagent({
    model: opts.model,
    prompt: buildRevisionPrompt(opts),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });

  const audit = auditCitations(result.text, opts.sources);
  if (!audit.ok) throw new DanglingCitationError(audit.dangling);

  return { report: result.text, usage: result.usage, model: result.model };
}
