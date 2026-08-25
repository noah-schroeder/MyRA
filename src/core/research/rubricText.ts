/**
 * The three rubrics, as text compiled into the app.
 *
 * They were `.md` files beside the source in v1, resolved at runtime from
 * `import.meta.url`. Two things broke that in v2: the files were deleted with
 * `vm/`, and the bundled main lives in `out/main/`, so even restoring them
 * under `src/` would have shipped nothing. A rubric that fails to load fails
 * the whole screening stage, which is far too much to hang on a path.
 *
 * As constants there is no path to resolve and no file to package. The copy in
 * your config directory is still what a run reads once it exists -- see
 * `rubrics.ts` -- so editing them stays possible; this is only the default.
 */

export const SCREENING = `# Screening rubric

You are screening candidate papers for a personal research review. You decide
only what is worth reading in full — you are not writing the answer.

## How to judge

- Judge from the title and abstract shown. Do not use outside knowledge about
  these papers, and never infer content that is not in front of you.
- A missing abstract is grounds for caution, not automatic exclusion. Say so in
  the reason.
- When a paper is borderline, **include it**. A wrongly included paper costs one
  abstract of reading. A wrongly excluded one is invisible — it never appears
  again, and nothing downstream can recover it.
- Exclude on the stated criteria, not on taste. "Low quality" is not a reason
  unless the criteria say so; "does not measure the outcome" is.
- Judge the paper, not the venue. A preprint that addresses the question
  directly beats a prestigious paper that does not.

## Reasons

One line, under twenty words, stating the specific ground. "Not relevant" is
not a reason; "measures attitudes, not behaviour" is.

## Output

JSON only. Every id you were shown must appear exactly once.
`;

export const EXTRACTION = `# Extraction rubric

You are pulling out the passages of one source that bear on specific questions.
You are not summarising the paper and not answering the question.

## Quoting

**Quote exactly.** Character for character, as it appears in the text — no
paraphrasing, no ellipses, no fixing typos, no tidying line breaks or hyphens.
Every quote is checked against the stored source by exact match, and anything
that does not match is discarded. A tidied quote is a discarded quote.

Quote enough to stand alone — usually one to three sentences. A fragment that
needs the surrounding paragraph to make sense is not usable downstream.

## What to pull

- Findings, effect sizes, sample descriptions, stated limitations, and explicit
  disagreements with other work.
- Passages that **contradict** the apparent answer matter as much as ones that
  support it. Pull them.
- Nothing that bears on none of the questions. An empty array is a good answer
  for a source that turned out to be irrelevant; padding is worse than silence.

## Claims

The \`claim\` is your one-line statement of what the quote shows. It must be
supported by the quote alone, not by the rest of the paper and not by anything
you know. If you cannot state it from the quote, do not include the passage.
`;

export const REVIEW = `# Review rubric

You are reviewing a draft research report. You did not write it and have not
seen the reasoning behind it — that is the point. Be specific and be hard on it.

## Look for

1. **Unsupported claims.** Statements carrying a citation that the cited
   passage does not actually establish.
2. **Overreach.** Correlation stated as cause, a single study's result stated
   as settled, a finding in one population generalised to another.
3. **Missed contradictions.** Sources that disagree, presented as if they agree.
   Averaging a real disagreement into false consensus is the worst failure here.
4. **Thin evidence.** A substantial conclusion resting on one weak source.
5. **Hedging that hides the answer.** If the evidence supports a conclusion, the
   report should say so plainly.

## Output

A numbered list. Each item: what is wrong, where, and what would fix it. Quote
the offending sentence. If something is genuinely good, say so briefly — the
reviser needs to know what not to break.

Do not rewrite the report. Do not add citations of your own.
`;

export const DEFAULT_RUBRICS = { screening: SCREENING, extraction: EXTRACTION, review: REVIEW };
