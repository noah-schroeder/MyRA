/**
 * A PRISMA 2020 flow diagram, drawn from the numbers a run already wrote down.
 *
 * The one diagram this app can produce that nothing else can. A systematic
 * review has to report how many records were identified, how many survived
 * de-duplication, how many were screened out and why, and how many reached
 * the synthesis -- and for a MyRA run every one of those numbers is already on
 * disk, because each stage writes its output there and a stage's output file is
 * its done-marker. Asking a model to invent the diagram would be asking it to
 * invent the numbers; asking the user to type them is asking them to read six
 * JSONL files.
 *
 * Pure, and counts are passed in rather than read here, for the reason
 * `projects/render.ts` returns operations instead of performing them: the
 * arithmetic that decides what a reader sees is worth testing without a run on
 * disk.
 *
 * **A count MyRA did not measure is left out, never guessed.** A run without a
 * snowball stage has no "additional records identified through other sources"
 * box -- not a box reading zero, which in a published diagram is a claim that
 * the search was done and found nothing. `figureFromCounts` below leaves
 * `registers`, `automation`, `removedOther`, `sought`, `notRetrieved` and every
 * exclusion reason blank for exactly this reason: MyRA does not measure them,
 * and `create_prisma_diagram`'s own Edit-numbers form is where a reviewer adds
 * what a run alone cannot supply.
 */

import { emptyFigure, type PrismaFigure, type PrismaVariantId } from "../prisma/spec.ts";

export interface PrismaCounts {
  /** Records returned by the database searches, before de-duplication. */
  identified: number;
  /** Records left after duplicates were removed, when that was measured. */
  afterDuplicates?: number | undefined;
  /** Records found by following citations, when the stage ran. */
  viaSnowball?: number | undefined;
  /** Records actually put in front of the screener. */
  screened: number;
  /** Screened out at title and abstract. */
  excludedAtScreen: number;
  /** Sought for full text and read, when that stage completed. */
  fullText?: number | undefined;
  /** Sources that reached the synthesis, when the retrieve/extract stage ran. */
  included?: number | undefined;
}

/**
 * Derive the counts from what a run wrote, without reading anything.
 *
 * Takes the arrays rather than the run so the mapping from files to boxes is
 * testable on its own. `screened` is the shortlist that reached the screener,
 * which is not the same number as `identified`: without an embeddings model the
 * pipeline takes a slice across the queries, and a diagram claiming every
 * record was screened would be false in exactly the way a reviewer checks.
 *
 * `snowball` and `sources` are `undefined` for a stage that never ran, and an
 * array (however short) for one that did -- never inferred from length. A
 * stage that ran a citation search and genuinely found nothing is a
 * measured zero, drawn as "(n = 0)"; a stage that never ran has no box at
 * all. Collapsing the two onto "the array is empty" -- which is exactly what
 * `readJsonl` returns for a missing file and an empty one alike -- was the
 * bug: the caller has to answer "did this run" itself, from the stage's own
 * output file existing (`ResearchRun.isDone`), before it gets here.
 */
export function prismaCounts(input: {
  candidates: unknown[];
  snowball: unknown[] | undefined;
  screened: { include: boolean }[];
  sources: unknown[] | undefined;
  /** Distinct de-duplication keys, when the run recorded them. */
  distinct?: number | undefined;
}): PrismaCounts {
  const excluded = input.screened.filter((d) => !d.include).length;
  /* Against everything found, not against the database searches alone: a
     citation search turns up papers the queries already returned, and those are
     exactly the duplicates the box is reporting. */
  const total = input.candidates.length + (input.snowball?.length ?? 0);
  return {
    identified: input.candidates.length,
    ...(input.distinct !== undefined && input.distinct < total
      ? { afterDuplicates: input.distinct }
      : {}),
    ...(input.snowball !== undefined ? { viaSnowball: input.snowball.length } : {}),
    screened: input.screened.length,
    excludedAtScreen: excluded,
    /* fullText ("assessed") and included both come from the same array: this
       pipeline has no separate "assessed but excluded after full text" step,
       so a source that was retrieved at all is one that reached the
       synthesis. Both are set together, from the same "did this run" check,
       or neither is -- an assessed box with no included box beside it (or
       the reverse) would be its own version of this file's bug. */
    ...(input.sources !== undefined
      ? { fullText: input.sources.length, included: input.sources.length }
      : {}),
  };
}

/**
 * The counts, mapped onto the PRISMA 2020 template's own field names.
 *
 * "new" rather than "updated": a MyRA run is never told it is revising an
 * earlier review, so the updated-review column and its extra total box are
 * never this run's to claim. "+other" exactly when a snowball round ran,
 * mapped onto the template's own "Citation searching" row -- the standard
 * PRISMA term for following a paper's references, which is what MyRA's
 * snowball stage does.
 *
 * `duplicates` is a subtraction rather than a stored count, because
 * `PrismaCounts.afterDuplicates` is *itself* the number of records left after
 * dedup (`distinct`), and the box this figure draws wants the number
 * *removed* -- the gap between everything found and what was left.
 *
 * `registers`, `automation`, `removedOther`, `sought`, `notRetrieved` and every
 * exclusion reason are left blank on purpose: nothing in the pipeline measures
 * them, and the blank rule above is what keeps a box from appearing over a
 * number nobody checked.
 */
export function figureFromCounts(counts: PrismaCounts, title?: string): PrismaFigure {
  const variant: PrismaVariantId = counts.viaSnowball !== undefined ? "new+other" : "new";
  const fig = emptyFigure(variant, title ?? "PRISMA flow diagram");
  fig.counts.databases = counts.identified;
  if (counts.afterDuplicates !== undefined) {
    fig.counts.duplicates = counts.identified + (counts.viaSnowball ?? 0) - counts.afterDuplicates;
  }
  if (counts.viaSnowball !== undefined) fig.counts.citations = counts.viaSnowball;
  fig.counts.screened = counts.screened;
  fig.counts.recordsExcluded = counts.excludedAtScreen;
  if (counts.fullText !== undefined) fig.counts.assessed = counts.fullText;
  if (counts.included !== undefined) fig.counts.includedStudies = counts.included;
  return fig;
}
