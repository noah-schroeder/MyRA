/**
 * Synthesis: writing the report from located claims, not from raw text.
 *
 * The synthesist never sees the full sources. It sees the claims table — each
 * entry a one-line claim, the verbatim quote behind it, and the source number.
 * Two things follow, and both matter:
 *
 *   - thirty papers fit in one call, because a 40-page paper has already been
 *     reduced to a handful of located passages
 *   - there is no raw text to quote from, so a quote in the draft can only have
 *     come from a quote that was already verified as present in a source
 *
 * The model may emit "[n]" and nothing else resembling a citation. It never
 * writes an author, a year, a venue or a URL: the bibliography is rendered from
 * the stored records. That is what makes a fabricated reference impossible
 * rather than unlikely.
 */

import type { Claim } from "./extract.ts";
import { auditCitations, type SourceRecord } from "./sources.ts";
import { runSubagent, type SubagentUsage } from "./subagent.ts";

export interface SynthesisInput {
  question: string;
  subQuestions: string[];
  claims: Claim[];
  sources: SourceRecord[];
}

/** Group the claims by source so the model sees each paper as one voice. */
export function formatClaims(claims: Claim[]): string {
  const bySource = new Map<number, Claim[]>();
  for (const c of claims) {
    const list = bySource.get(c.source);
    if (list) list.push(c);
    else bySource.set(c.source, [c]);
  }
  return [...bySource.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, list]) =>
      [
        `SOURCE [${n}]`,
        ...list.map((c) => [`  - ${c.claim}`, `    "${c.quote}"`].join("\n")),
      ].join("\n"),
    )
    .join("\n\n");
}

export function buildSynthesisPrompt(input: SynthesisInput): string {
  const titles = input.sources
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((s) => `  [${s.n}] ${s.title}${s.year ? ` (${s.year})` : ""}`)
    .join("\n");

  return [
    `QUESTION`,
    input.question,
    "",
    ...(input.subQuestions.length
      ? [`SUB-QUESTIONS`, ...input.subQuestions.map((q, i) => `  ${i + 1}. ${q}`), ""]
      : []),
    `SOURCES AVAILABLE`,
    titles,
    "",
    `EVIDENCE — every claim below was located verbatim in the source shown`,
    "",
    formatClaims(input.claims),
    "",
    `Write the report from this evidence.`,
    "",
    `Rules, all of them mechanical and all of them checked:`,
    `  - Cite as [n] using the source numbers above. Nothing else counts as a citation:`,
    `    do not write author names, years, venues, URLs or a reference list. The`,
    `    bibliography is generated from stored records and yours would be discarded.`,
    `  - Every [n] must be a source number listed above. A citation to anything else`,
    `    fails the run.`,
    `  - Quote only text that appears in the evidence above, exactly as it appears.`,
    `  - Where sources disagree, say so and cite both. Do not average a real`,
    `    disagreement into a false consensus.`,
    `  - Where the evidence does not answer part of the question, say that plainly`,
    `    instead of filling the gap from your own knowledge.`,
    `  - Nothing you know about this topic belongs in the report unless a claim`,
    `    above supports it.`,
    "",
    `Structure: a direct answer first, then the evidence organised by sub-question,`,
    `then what remains uncertain. Markdown. No reference list.`,
  ].join("\n");
}

export interface SynthesisResult {
  draft: string;
  usage: SubagentUsage;
  model: string;
}

export class DanglingCitationError extends Error {
  override readonly name = "DanglingCitationError";
  readonly dangling: number[];
  constructor(dangling: number[]) {
    super(
      `the draft cites ${dangling.length} source(s) that do not exist: [${dangling.join("], [")}]`,
    );
    this.dangling = dangling;
  }
}

/**
 * Run synthesis and refuse to return a draft with a dangling citation.
 *
 * A hard error, deliberately. A citation pointing at nothing is the one failure
 * that must never be quietly repaired downstream: dropping the marker would
 * leave an unsupported sentence, and renumbering it would attach the sentence
 * to whichever source happened to be next.
 */
export async function synthesize(opts: {
  input: SynthesisInput;
  model: string;
  rubric?: string;
  signal?: AbortSignal;
  cwd?: string;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<SynthesisResult> {
  const result = await runSubagent({
    model: opts.model,
    prompt: buildSynthesisPrompt(opts.input),
    ...(opts.rubric ? { system: opts.rubric } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });

  const audit = auditCitations(result.text, opts.input.sources);
  if (!audit.ok) throw new DanglingCitationError(audit.dangling);

  return { draft: result.text, usage: result.usage, model: result.model };
}
