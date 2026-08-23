/**
 * Screening: deciding which candidates are worth reading in full.
 *
 * Two passes, because ~500 candidates is too many to judge and too few to
 * guess at. Embeddings rank everything against the scope cheaply and
 * deterministically; the screener model then judges only the top slice, in
 * batches, with a one-line reason for each decision.
 *
 * THE RULE THAT MATTERS: a candidate the model failed to mention is never
 * dropped. Screening decides what to read, so a silent omission is a paper
 * that vanishes from the run with no record of why. Anything unaccounted for
 * is carried forward and flagged as undecided instead.
 */

import { parseJsonReply, runSubagent, type SubagentUsage } from "./subagent.ts";

export interface Candidate {
  /** Stable id within the run, used as the model's handle on this paper. */
  id: number;
  title: string;
  abstract?: string;
  year?: number;
  venue?: string;
  url: string;
  doi?: string;
  citedBy?: number;
}

export interface Decision {
  id: number;
  include: boolean;
  reason: string;
  /** True when the model said nothing about this candidate and it was kept by default. */
  defaulted?: boolean;
}

export interface ScreenScope {
  question: string;
  include: string[];
  exclude: string[];
}

/** How many candidates go to the model at once. Small enough to stay coherent. */
export const SCREEN_BATCH = 50;

/**
 * The batches a screening pass will run, worked out up front.
 *
 * Separate from the loop so the boundaries can be announced before any work
 * starts, and so they can be tested without a model.
 */
export function batchRanges(total: number, size: number): { n: number; of: number; from: number; to: number }[] {
  const of = Math.ceil(total / size);
  const out: { n: number; of: number; from: number; to: number }[] = [];
  for (let i = 0; i < total; i += size) {
    out.push({ n: out.length + 1, of, from: i + 1, to: Math.min(i + size, total) });
  }
  return out;
}

export function formatCandidate(c: Candidate): string {
  const bits = [`[${c.id}] ${c.title}`];
  const meta = [c.year, c.venue, c.citedBy !== undefined ? `cited by ${c.citedBy}` : undefined]
    .filter(Boolean)
    .join(" · ");
  if (meta) bits.push(`    ${meta}`);
  bits.push(`    ${c.abstract?.trim() ? c.abstract.trim() : "(no abstract available)"}`);
  return bits.join("\n");
}

export function buildScreenPrompt(scope: ScreenScope, batch: Candidate[]): string {
  return [
    `RESEARCH QUESTION`,
    scope.question,
    "",
    `INCLUDE a paper if:`,
    ...scope.include.map((c) => `  - ${c}`),
    "",
    `EXCLUDE a paper if:`,
    ...scope.exclude.map((c) => `  - ${c}`),
    "",
    `CANDIDATES (${batch.length})`,
    "",
    batch.map(formatCandidate).join("\n\n"),
    "",
    `Decide each candidate against the criteria above. Judge only from the title and abstract `,
    `shown — do not use outside knowledge about these papers, and do not guess at content that `,
    `is not there. A missing abstract is grounds for caution, not automatic exclusion.`,
    "",
    `Reply with JSON only, one object per candidate, every id present:`,
    `[{"id": 1, "include": true, "reason": "measures the outcome directly in the target population"}]`,
    `Keep each reason under 20 words.`,
  ].join("\n");
}

interface RawDecision {
  id?: unknown;
  include?: unknown;
  reason?: unknown;
}

/**
 * Turn the model's reply into decisions, accounting for every candidate.
 *
 * Anything the model omitted, duplicated, or answered unintelligibly is kept
 * and marked `defaulted`. Recall matters more than precision here: an extra
 * paper costs one abstract of reading time, a lost one is invisible.
 */
export function parseDecisions(text: string, batch: Candidate[]): Decision[] {
  const raw = parseJsonReply<RawDecision[]>(text, "screening reply");
  const rows = Array.isArray(raw) ? raw : [];
  const byId = new Map<number, Decision>();

  for (const row of rows) {
    const id = typeof row?.id === "number" ? row.id : Number(row?.id);
    if (!Number.isFinite(id) || byId.has(id)) continue;
    if (!batch.some((c) => c.id === id)) continue; // an id we never asked about
    byId.set(id, {
      id,
      include: row?.include === true || String(row?.include).toLowerCase() === "true",
      reason: typeof row?.reason === "string" ? row.reason.trim().slice(0, 200) : "",
    });
  }

  return batch.map(
    (c) =>
      byId.get(c.id) ?? {
        id: c.id,
        include: true,
        reason: "no decision returned for this candidate — kept for review",
        defaulted: true,
      },
  );
}

export interface ScreenResult {
  decisions: Decision[];
  usage: SubagentUsage;
  batches: number;
}

/** Screen every candidate, in batches, with the screener model. */
export async function screenCandidates(opts: {
  scope: ScreenScope;
  candidates: Candidate[];
  model: string;
  rubric?: string;
  batchSize?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Called BEFORE each batch as well as after, so a slow batch is not silence. */
  onBatch?: (batch: number, batches: number, from: number, to: number) => void;
  onProgress?: (done: number, total: number) => void;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<ScreenResult> {
  const size = opts.batchSize ?? SCREEN_BATCH;
  const decisions: Decision[] = [];
  const usage: SubagentUsage = { input: 0, output: 0, total: 0 };
  const total = opts.candidates.length;
  const ranges = batchRanges(total, size);
  let batches = 0;

  for (const range of ranges) {
    const batch = opts.candidates.slice(range.from - 1, range.to);
    // Announced up front: a batch can take minutes on a modest endpoint, and
    // reporting only on completion makes the first one indistinguishable from
    // a hang.
    opts.onBatch?.(range.n, range.of, range.from, range.to);
    const result = await runSubagent({
      model: opts.model,
      prompt: buildScreenPrompt(opts.scope, batch),
      ...(opts.rubric ? { system: opts.rubric } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
    });
    decisions.push(...parseDecisions(result.text, batch));
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.total += result.usage.total;
    batches++;
    opts.onProgress?.(range.to, total);
  }

  return { decisions, usage, batches };
}
