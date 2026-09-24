/**
 * The PRISMA diagram, whose numbers are the point.
 *
 * A flow diagram in a systematic review is a claim about what was searched and
 * what was thrown away, read by a reviewer checking the arithmetic. So the
 * assertions here are about which boxes appear and what is in them -- and in
 * particular about what is left out, because a box reading zero is a claim that
 * a stage ran and found nothing, which is a different statement from a stage
 * that never ran.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { figureFromCounts, prismaCounts } from "../src/core/research/prisma.ts";
import { prismaLayout } from "../src/core/prisma/layout.ts";
import { toSvg } from "../src/core/diagrams/svg.ts";

const decisions = (include: number, exclude: number): { include: boolean }[] => [
  ...Array.from({ length: include }, () => ({ include: true })),
  ...Array.from({ length: exclude }, () => ({ include: false })),
];

test("the counts come off the stage files, not off each other", () => {
  const got = prismaCounts({
    candidates: new Array(842).fill(0),
    snowball: new Array(17).fill(0),
    screened: decisions(24, 131),
    sources: new Array(24).fill(0),
    distinct: 803,
  });
  assert.equal(got.identified, 842);
  assert.equal(got.afterDuplicates, 803);
  assert.equal(got.viaSnowball, 17);
  assert.equal(got.screened, 155);
  assert.equal(got.excludedAtScreen, 131);
  assert.equal(got.included, 24);
});

test("screened is the shortlist, which is not the number identified", () => {
  /* Without an embeddings model the pipeline screens a slice taken across the
     queries. A diagram claiming all 842 were screened would be false in exactly
     the way a reviewer checks. */
  const got = prismaCounts({
    candidates: new Array(842).fill(0),
    snowball: [],
    screened: decisions(10, 40),
    sources: new Array(10).fill(0),
  });
  assert.equal(got.identified, 842);
  assert.equal(got.screened, 50);
});

test("a stage that did not run gets no box, rather than a box reading zero", () => {
  const got = prismaCounts({
    candidates: new Array(20).fill(0), snowball: undefined, screened: decisions(5, 15), sources: undefined,
  });
  assert.equal(got.viaSnowball, undefined, "no citation search happened");
  assert.equal(got.fullText, undefined, "nothing was retrieved in full");
  assert.equal(got.included, undefined, "nothing reached the synthesis because retrieve never ran");
  const fig = figureFromCounts(got);
  assert.equal(fig.counts.citations, undefined);
  assert.equal(fig.counts.assessed, undefined);
  assert.equal(fig.counts.includedStudies, undefined);
});

test("a stage that ran and found nothing draws a measured zero, not a missing box", () => {
  /* The bug this replaces used array length to decide "did this run", so a
     citation search that ran and turned up nothing was indistinguishable from
     one that never happened -- silently dropping the "other methods" column
     and, separately, showing an "Included (n = 0)" box with no "assessed" box
     above it, since fullText used the same length-truthy check while included
     did not. Passing an empty (not undefined) array is "ran, found zero". */
  const got = prismaCounts({
    candidates: new Array(20).fill(0), snowball: [], screened: decisions(5, 15), sources: [],
  });
  assert.equal(got.viaSnowball, 0, "the citation search ran and found nothing");
  assert.equal(got.fullText, 0, "retrieval ran and nothing was retrieved");
  assert.equal(got.included, 0, "nothing reached the synthesis, measured");
  const fig = figureFromCounts(got);
  assert.equal(fig.variant, "new+other", "a snowball round that ran, even finding nothing, is still +other");
  assert.equal(fig.counts.citations, 0);
  assert.equal(fig.counts.assessed, 0);
  assert.equal(fig.counts.includedStudies, 0);
});

test("de-duplication is reported only when it actually removed something", () => {
  const none = prismaCounts({
    candidates: new Array(20).fill(0), snowball: [], screened: decisions(5, 15),
    sources: new Array(5).fill(0), distinct: 20,
  });
  assert.equal(none.afterDuplicates, undefined, "nothing was removed, so nothing is claimed");
  assert.equal(figureFromCounts(none).counts.duplicates, undefined);
});

test("duplicates is how many were removed, not how many were left", () => {
  // afterDuplicates (803) is the count REMAINING; the box wants the count
  // removed -- the gap between everything found and what survived.
  const got = prismaCounts({
    candidates: new Array(842).fill(0),
    snowball: new Array(17).fill(0),
    screened: decisions(24, 131),
    sources: new Array(24).fill(0),
    distinct: 803,
  });
  const fig = figureFromCounts(got);
  assert.equal(fig.counts.duplicates, 842 + 17 - 803);
});

test("a snowball round makes it a +other review, on the citation-searching row", () => {
  const withSnowball = figureFromCounts(prismaCounts({
    candidates: new Array(20).fill(0), snowball: new Array(3).fill(0),
    screened: decisions(5, 15), sources: [],
  }));
  assert.equal(withSnowball.variant, "new+other");
  assert.equal(withSnowball.counts.citations, 3);

  const without = figureFromCounts(prismaCounts({
    candidates: new Array(20).fill(0), snowball: undefined, screened: decisions(5, 15), sources: undefined,
  }));
  assert.equal(without.variant, "new");
});

test("a run is never claimed as an updated review, and never claims totals it cannot support", () => {
  const fig = figureFromCounts(prismaCounts({
    candidates: new Array(20).fill(0), snowball: [], screened: decisions(5, 15), sources: new Array(5).fill(0),
  }));
  assert.ok(fig.variant.startsWith("new"));
  assert.equal(fig.counts.totalStudies, undefined);
  assert.equal(fig.counts.previousStudies, undefined);
});

test("the figure it produces is one MyRA can actually draw and read the numbers back off", () => {
  const fig = figureFromCounts(prismaCounts({
    candidates: new Array(842).fill(0),
    snowball: new Array(17).fill(0),
    screened: decisions(24, 131),
    sources: new Array(24).fill(0),
    distinct: 803,
  }));
  const svg = toSvg(prismaLayout(fig));
  assert.match(svg, /\(n = 842\)/);
  assert.match(svg, /\(n = 131\)/);
  assert.match(svg, /\(n = 24\)/);
});

test("counts are printed with thousands separators, because they are read", () => {
  const fig = figureFromCounts({ identified: 1842, screened: 155, excludedAtScreen: 131, included: 24 });
  const svg = toSvg(prismaLayout(fig));
  assert.ok(svg.includes("(n = 1,842)"));
});

test("a measured zero draws -- screening out none of them is a fact, not an unmeasured stage", () => {
  /* The 2009-era prismaMermaid specifically hid this box at zero, which was
     really a workaround for excludedAtScreen having no way to express "never
     measured" at all -- it is always a definite number on PrismaCounts. The
     2020 figure's rule is presence, not value: a measured zero is exactly
     what "the screener excluded none of them" is, and it draws. */
  const fig = figureFromCounts({ identified: 10, screened: 10, excludedAtScreen: 0, included: 10 });
  const svg = toSvg(prismaLayout(fig));
  assert.ok(svg.includes("Records excluded"));
  assert.ok(svg.includes("(n = 0)"));
});
