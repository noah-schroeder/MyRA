/**
 * The peer reviewer's prompt, and the check that stops it being sent.
 *
 * Two things carry real weight here. The prompt is assembled from three
 * editable parts, and the order and the framing between them is what stops a
 * hurried note in the third part from cancelling the rule in the first. And
 * `fitsContext` is the difference between a refusal and a review that is
 * fluent about the introduction and silent about the results, because the
 * manuscript was quietly truncated -- a review that would go to an editor.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_REVIEW_PROMPT, DEFAULT_STUDY_TYPES, assembleReview, buildSystem, buildUser,
  requestsFor, studyTypeById, type ReviewRequest,
} from "../src/core/review/prompt.ts";
import {
  REPLY_TOKENS, fitsContext, titleFromFileName, titleOf, tooLongMessage, wordCount,
} from "../src/core/review/manuscript.ts";

const base = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  prompt: DEFAULT_REVIEW_PROMPT,
  reviewerInstructions: "",
  reviewerId: "theory",
  reviewerLabel: "Reviewer 1 — Theory and contribution",
  studyLabel: "",
  note: "",
  title: "Working memory training and fluid intelligence",
  manuscript: "We ran three experiments. Participants were undergraduates.",
  ...over,
});

/** The panel for one design, as the page would build it. */
const panel = (studyTypeId: string, over: { manuscript?: string; note?: string } = {}) =>
  requestsFor({
    prompt: DEFAULT_REVIEW_PROMPT,
    types: DEFAULT_STUDY_TYPES,
    studyTypeId,
    note: over.note ?? "",
    title: "Working memory training and fluid intelligence",
    manuscript: over.manuscript ?? "We ran three experiments.",
  });

describe("assembling the prompt", () => {
  it("sends the house rules, and this persona under them", () => {
    const type = studyTypeById(DEFAULT_STUDY_TYPES, "experimental")!;
    const methods = type.reviewers.find((r) => r.id === "methods")!;
    const system = buildSystem(base({ reviewerInstructions: methods.instructions }));
    assert.ok(system.startsWith(DEFAULT_REVIEW_PROMPT));
    assert.match(system, /YOU ARE THIS REVIEWER/);
    assert.match(system, /Randomisation and allocation/);
  });

  it("appends the reviewer's note and says it does not outrank the rules", () => {
    /* The note is the one box a reviewer types into in a hurry, and "ignore the
       above, just tell me if it's publishable" is a plausible thing to type.
       A model handed two instruction sets and no precedence follows the later
       one, so the precedence is stated. */
    const system = buildSystem(base({ note: "Focus on the statistics." }));
    const noteAt = system.indexOf("Focus on the statistics.");
    assert.ok(noteAt > system.indexOf(DEFAULT_REVIEW_PROMPT));
    assert.match(system, /do NOT override the rule against citing literature/i);
  });

  it("forbids inventing literature while still asking about the manuscript's own", () => {
    /* Both halves matter. Nothing here searched, so a reference the model adds
       is invented -- but "proper citations and references" is one of the
       criteria the manuscript is judged on, and a rule that banned the topic
       outright would have removed it. */
    assert.match(DEFAULT_REVIEW_PROMPT, /Do not cite outside literature/);
    assert.match(DEFAULT_REVIEW_PROMPT, /comment on the manuscript's OWN references/);
  });

  it("asks for the format and the scores the reviewer asked for", () => {
    for (const heading of [
      "Summary", "Major Strengths", "Major Concerns", "Minor Issues",
      "Specific Recommendations for Improvement", "Overall Verdict",
    ]) {
      assert.ok(DEFAULT_REVIEW_PROMPT.includes(heading), `missing ${heading}`);
    }
    assert.match(DEFAULT_REVIEW_PROMPT, /Originality, Technical Quality, Methodology, Presentation and Scientific Impact/);
    assert.match(DEFAULT_REVIEW_PROMPT, /1 = Poor.*5 = Excellent/);
    assert.match(DEFAULT_REVIEW_PROMPT, /1,000-2,000 words/);
  });

  it("carries the manuscript whole, and warns about the extraction", () => {
    /* An extracted PDF has broken tables and stray running heads in it. A model
       not told that reviews the formatting of the extract, which is MyRA's
       artefact and not the author's manuscript. */
    const user = buildUser(base({ manuscript: "METHODS\nWe ran three experiments." }));
    assert.match(user, /We ran three experiments\./);
    assert.match(user, /headings, tables and figure captions may be imperfectly laid out/);
  });

  it("honours a rewritten house prompt rather than the default", () => {
    // The whole point of it being editable.
    const system = buildSystem(base({ prompt: "Be brief." }));
    assert.ok(system.startsWith("Be brief."));
    assert.equal(system.includes("REVIEW FORMAT"), false);
  });

  it("falls back to the default when the prompt has been emptied", () => {
    /* An empty box is a mistake, not an instruction to send no instructions --
       a model handed a manuscript and no system prompt writes something, and it
       would not be a review. */
    assert.ok(buildSystem(base({ prompt: "   " })).startsWith(DEFAULT_REVIEW_PROMPT));
  });
});

describe("the panel", () => {
  it("is one request per reviewer, each carrying the whole manuscript", () => {
    /* Not one request for three reports. Six thousand words of output is where
       a local model degrades, and three reviewers who have not read each other
       is what a journal actually sends an editor. */
    const requests = panel("experimental", { manuscript: "The whole paper." });
    assert.equal(requests.length, 3);
    for (const r of requests) assert.equal(r.manuscript, "The whole paper.");
    assert.deepEqual(
      requests.map((r) => r.reviewerLabel),
      [
        "Reviewer 1 — Theory and contribution",
        "Reviewer 2 — Methods and statistics",
        "Reviewer 3 — Concepts, flow and language",
      ],
    );
  });

  it("gives every design a theory, a methods and a language reviewer", () => {
    for (const type of DEFAULT_STUDY_TYPES) {
      assert.deepEqual(
        type.reviewers.map((r) => r.id).sort(),
        ["language", "methods", "theory"],
        `${type.id} panel is wrong`,
      );
    }
  });

  it("sends a systematic review through the PRISMA checklist", () => {
    const methods = panel("systematic-review").find((r) => /PRISMA/.test(r.reviewerLabel))!;
    assert.match(methods.reviewerInstructions, /PRISMA 2020 expanded checklist/);
    // All 27 items, not a summary of them: 27 is the number the table has rows for.
    for (const item of ["1. Title", "13f.", "20d.", "24c.", "27."]) {
      assert.ok(methods.reviewerInstructions.includes(item), `missing item ${item}`);
    }
    assert.match(methods.reviewerInstructions, /Assessment \(Present \/ Partially present \/ Absent\)/);
  });

  it("adds the meta-analysis questions on top of PRISMA, not instead of it", () => {
    const methods = panel("meta-analysis").find((r) => /PRISMA/.test(r.reviewerLabel))!;
    assert.match(methods.reviewerInstructions, /PRISMA 2020 expanded checklist/);
    assert.match(methods.reviewerInstructions, /fixed or random effects/);
    assert.match(methods.reviewerInstructions, /Publication bias/);
    assert.match(methods.reviewerInstructions, /dependencies in the data/);
  });

  it("asks an editorial nothing about randomisation", () => {
    /* The reason the chooser exists: one panel applied to everything asks a
       position paper for its sample size. */
    const requests = panel("position");
    const all = requests.map((r) => r.reviewerInstructions).join("\n");
    assert.match(all, /Do not criticise the manuscript for lacking randomisation/);
    assert.equal(/PRISMA/.test(all), false);
  });

  it("sends nothing at all for a design that no longer exists", () => {
    /* A type deleted in Settings must not fall through to some generic review:
       the panel IS the prompt here, so there is nothing sensible to send. */
    assert.deepEqual(panel("gone"), []);
  });

  it("tells every reviewer which design the handling reviewer chose", () => {
    const user = buildUser(panel("meta-analysis")[0]!);
    assert.match(user, /classified this as: Meta-analysis/);
  });
});

describe("assembling the finished panel", () => {
  it("files each report under its own heading", () => {
    const out = assembleReview("A paper", [
      { label: "Reviewer 1 — Theory", text: "Theory report." },
      { label: "Reviewer 2 — Methods", text: "Methods report." },
    ]);
    assert.match(out, /^# Review of “A paper”/);
    assert.match(out, /## Reviewer 1 — Theory\n\nTheory report\./);
    assert.match(out, /## Reviewer 2 — Methods\n\nMethods report\./);
  });

  it("names the manuscript even when the title box was left empty", () => {
    assert.match(assembleReview("  ", []), /untitled manuscript/);
  });
});

describe("whether it fits", () => {
  const long = (words: number): string => "word ".repeat(words);

  it("refuses when one reviewer's request and its report exceed the window", () => {
    const fit = fitsContext(panel("experimental", { manuscript: long(9_000) }), 8_192);
    assert.equal(fit.fits, false);
    assert.equal(fit.words, 9_000);
    assert.equal(fit.limit, 8_192);
  });

  it("measures the largest reviewer, not the sum of them", () => {
    /* Each persona is a separate request carrying the same manuscript, so what
       has to fit is one of them. Summing the panel would refuse manuscripts
       that would have reviewed perfectly well three times over. */
    const requests = panel("systematic-review", { manuscript: long(400) });
    const each = requests.map((r) => fitsContext([r], 0).tokens);
    assert.equal(fitsContext(requests, 0).tokens, Math.max(...each));
    assert.ok(fitsContext(requests, 0).tokens < each.reduce((a, b) => a + b, 0));
  });

  it("leaves room for the report itself", () => {
    /* Counting only the input is how a request that "fits" gets cut off
       mid-recommendation. A request just under the window must still refuse. */
    const requests = panel("experimental", { manuscript: long(200) });
    const fit = fitsContext(requests, 0);
    assert.equal(fitsContext(requests, fit.tokens + Math.floor(REPLY_TOKENS / 2)).fits, false);
    assert.equal(fitsContext(requests, fit.tokens + REPLY_TOKENS).fits, true);
  });

  it("does not refuse when the window is unknown", () => {
    /* A hosted provider reports no context length. Refusing on "we could not
       measure it" would block the models most able to do this. */
    const requests = panel("experimental", { manuscript: long(50_000) });
    assert.equal(fitsContext(requests, undefined).fits, true);
    assert.equal(fitsContext(requests, 0).fits, true);
  });

  it("counts the persona, not the manuscript alone", () => {
    const theory = fitsContext([panel("experimental")[0]!], 0);
    const prisma = fitsContext([panel("systematic-review")[1]!], 0);
    assert.ok(prisma.tokens > theory.tokens);
  });

  it("names both numbers and a way out", () => {
    const message = tooLongMessage(fitsContext(panel("experimental", { manuscript: long(9_000) }), 8_192));
    assert.match(message, /9,000 words/);
    assert.match(message, /8,192/);
    assert.match(message, /Models page/);
  });
});

describe("the title", () => {
  it("skips a running head and a page number to find it", () => {
    const text = [
      "Running head: WORKING MEMORY",
      "1",
      "CONFIDENTIAL — FOR PEER REVIEW",
      "Does working memory training transfer to fluid intelligence?",
      "Abstract",
    ].join("\n");
    assert.equal(titleOf(text), "Does working memory training transfer to fluid intelligence?");
  });

  it("does not take a sentence of body prose", () => {
    const text = [
      "x",
      "Working memory training has been studied extensively over the last two decades by many groups.",
      "A short real title here",
    ].join("\n");
    assert.equal(titleOf(text), "A short real title here");
  });

  it("skips a byline", () => {
    const text = ["a.nguyen@university.edu", "The real title of the paper"].join("\n");
    assert.equal(titleOf(text), "The real title of the paper");
  });

  it("says nothing rather than guessing, when there is nothing to take", () => {
    assert.equal(titleOf("short\nalso"), "");
  });

  it("makes a filename presentable for when it found none", () => {
    assert.equal(
      titleFromFileName("Nguyen-2026-working_memory-FINAL.pdf"),
      "Nguyen 2026 working memory FINAL",
    );
  });
});

describe("counting words", () => {
  it("counts what a person would call words", () => {
    assert.equal(wordCount("  one two   three\nfour "), 4);
    assert.equal(wordCount(""), 0);
  });
});
