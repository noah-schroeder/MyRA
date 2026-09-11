/**
 * Verification: does the cited passage actually say what the sentence claims?
 *
 * This is the honest half of the citation guarantee. That an [n] resolves to a
 * real source, and that a quote is verbatim, are proven mechanically elsewhere.
 * Whether a PARAPHRASE faithfully represents its source is a semantic judgement
 * and cannot be proven — so it is checked, every pair, and whatever fails is
 * flagged in the output rather than quietly dropped.
 *
 * The check runs against the located passages, not the whole paper, so the
 * verifier is answering a narrow question about text it can see in full.
 */

import type { Claim } from "./extract.ts";
import { parseJsonReply, runSubagent, type SubagentUsage } from "../llm/chat.ts";

export type Verdict = "supports" | "contradicts" | "does not address" | "unchecked";

export interface CitedSentence {
  index: number;
  text: string;
  citations: number[];
}

export interface Check {
  sentenceIndex: number;
  sentence: string;
  source: number;
  verdict: Verdict;
  note: string;
}

/**
 * Sentences of the draft that carry a citation.
 *
 * Splitting is deliberately conservative: an over-long "sentence" is checked
 * as a unit and reads fine in a flag, whereas a wrongly split one would ask
 * the verifier about half a claim.
 *
 * A markdown list item is the one case split first and unconditionally,
 * before that conservative rule even applies. The synthesist's own prompt
 * asks for "evidence organised by sub-question", which it reliably renders as
 * one quoted passage per bullet, each with its own citation and no terminal
 * period -- "quote" [1]. With no full stop to split on, every bullet in the
 * list glued into the next, and a source cited by bullet one was then asked
 * whether it supports bullets two, three and four as well. It does not, so
 * it failed -- not because the quote was a poor match, but because the
 * "sentence" it was judged against was four unrelated quotes wide.
 */
export function splitCitedSentences(draft: string): CitedSentence[] {
  const out: CitedSentence[] = [];
  let index = 0;
  for (const block of draft.split(/\n{2,}/)) {
    const body = block.trim();
    if (!body || body.startsWith("#")) continue;
    for (const item of body.split(/\n(?=\s*(?:[-*]|\d+[.)])\s)/)) {
      // A citation marker often sits before the full stop, so keep it with its
      // sentence: split only on terminal punctuation followed by a capital.
      for (const raw of item.split(/(?<=[.!?])\s+(?=[A-Z"“(\-*\d])/)) {
        const text = raw.replace(/^[-*]\s*|^\d+[.)]\s*/, "").trim();
        if (!text) continue;
        const citations = [
          ...new Set(
            [...text.matchAll(/\[(\d+)\]/g)]
              .map((m) => Number(m[1]))
              .filter((n) => Number.isFinite(n) && n >= 1),
          ),
        ];
        if (citations.length === 0) continue;
        out.push({ index: index++, text, citations });
      }
    }
  }
  return out;
}

/** Every (sentence, cited source) pair that needs checking. */
export function pairsToCheck(sentences: CitedSentence[]): { sentence: CitedSentence; source: number }[] {
  return sentences.flatMap((sentence) => sentence.citations.map((source) => ({ sentence, source })));
}

function evidenceFor(source: number, claims: Claim[]): string {
  const mine = claims.filter((c) => c.source === source);
  if (mine.length === 0) return "  (no extracted passages for this source)";
  return mine.map((c) => `  - "${c.quote}"`).join("\n");
}

export function buildVerifyPrompt(
  pairs: { sentence: CitedSentence; source: number }[],
  claims: Claim[],
): string {
  const sources = [...new Set(pairs.map((p) => p.source))].sort((a, b) => a - b);
  return [
    `You are checking whether cited passages support the statements that cite them.`,
    "",
    `PASSAGES`,
    ...sources.map((n) => [`SOURCE [${n}]`, evidenceFor(n, claims)].join("\n")),
    "",
    `STATEMENTS TO CHECK`,
    ...pairs.map(
      (p, i) => `  ${i + 1}. against [${p.source}]: ${p.sentence.text}`,
    ),
    "",
    `For each numbered statement, judge ONLY whether the passages from the source it`,
    `names establish it. Use the passages alone — not your own knowledge of the topic,`,
    `and not the other sources.`,
    "",
    `  supports          — the passages establish the statement`,
    `  contradicts       — the passages say something incompatible with it`,
    `  does not address  — the passages are about something else, or are too thin`,
    "",
    `"does not address" is the right answer for a statement that is true but simply`,
    `not shown by this source. Being generous here defeats the point of the check.`,
    "",
    `Reply with JSON only, every number present:`,
    `[{"n": 1, "verdict": "supports", "note": "reports the effect directly"}]`,
    `Keep each note under 20 words.`,
  ].join("\n");
}

interface RawVerdict {
  n?: unknown;
  verdict?: unknown;
  note?: unknown;
}

function normalizeVerdict(value: unknown): Verdict | undefined {
  const v = String(value ?? "").toLowerCase().trim();
  if (v.startsWith("support")) return "supports";
  if (v.startsWith("contradict")) return "contradicts";
  if (v.includes("not address") || v.startsWith("unrelated") || v.startsWith("no")) {
    return "does not address";
  }
  return undefined;
}

/**
 * Parse verdicts, accounting for every pair.
 *
 * A pair the verifier skipped becomes "unchecked" rather than disappearing: an
 * unverified claim silently presented as verified is the exact failure this
 * stage exists to prevent.
 */
export function parseVerdicts(
  text: string,
  pairs: { sentence: CitedSentence; source: number }[],
): Check[] {
  const raw = parseJsonReply<RawVerdict[]>(text, "verification reply");
  const byIndex = new Map<number, { verdict: Verdict; note: string }>();
  for (const row of Array.isArray(raw) ? raw : []) {
    const n = typeof row?.n === "number" ? row.n : Number(row?.n);
    const verdict = normalizeVerdict(row?.verdict);
    if (!Number.isFinite(n) || n < 1 || n > pairs.length || !verdict || byIndex.has(n)) continue;
    byIndex.set(n, {
      verdict,
      note: typeof row?.note === "string" ? row.note.trim().slice(0, 200) : "",
    });
  }
  return pairs.map((p, i) => {
    const got = byIndex.get(i + 1);
    return {
      sentenceIndex: p.sentence.index,
      sentence: p.sentence.text,
      source: p.source,
      verdict: got?.verdict ?? "unchecked",
      note: got?.note ?? "no verdict returned for this statement",
    };
  });
}

export interface VerifyResult {
  checks: Check[];
  usage: SubagentUsage;
  /** Anything that is not a clean "supports" — what the reviser must address. */
  flagged: Check[];
}

/** How many (sentence, source) pairs go to the model at once. */
export const VERIFY_BATCH = 12;

export async function verifyDraft(opts: {
  draft: string;
  claims: Claim[];
  model: string;
  batchSize?: number;
  signal?: AbortSignal;
  cwd?: string;
  onBatch?: (batch: number, batches: number) => void;
  onProgress?: (done: number, total: number) => void;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<VerifyResult> {
  const pairs = pairsToCheck(splitCitedSentences(opts.draft));
  const size = opts.batchSize ?? VERIFY_BATCH;
  const checks: Check[] = [];
  const usage: SubagentUsage = { input: 0, output: 0, total: 0 };

  const batchCount = Math.ceil(pairs.length / size) || 1;
  for (let i = 0; i < pairs.length; i += size) {
    const batch = pairs.slice(i, i + size);
    opts.onBatch?.(Math.floor(i / size) + 1, batchCount);
    const result = await runSubagent({
      model: opts.model,
      prompt: buildVerifyPrompt(batch, opts.claims),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
    });
    checks.push(...parseVerdicts(result.text, batch));
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.total += result.usage.total;
    opts.onProgress?.(Math.min(i + size, pairs.length), pairs.length);
  }

  return { checks, usage, flagged: checks.filter((c) => c.verdict !== "supports") };
}

/** A short, readable account of what verification found. */
export function summarizeChecks(checks: Check[]): string {
  const count = (v: Verdict) => checks.filter((c) => c.verdict === v).length;
  const lines = [
    `${checks.length} cited statement(s) checked:`,
    `  supports          ${count("supports")}`,
    `  contradicts       ${count("contradicts")}`,
    `  does not address  ${count("does not address")}`,
    `  unchecked         ${count("unchecked")}`,
  ];
  return lines.join("\n");
}
