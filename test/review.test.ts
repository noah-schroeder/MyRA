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
  DEFAULT_REVIEW_PROMPT, DEFAULT_STUDY_TYPES, buildSystem, buildUser, requestFor,
  studyTypeById, type ReviewRequest,
} from "../src/core/review/prompt.ts";
import {
  REPLY_TOKENS, fitsContext, titleFromFileName, titleOf, tooLongMessage, wordCount,
} from "../src/core/review/manuscript.ts";

const base = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  prompt: DEFAULT_REVIEW_PROMPT,
  studyGuidance: "",
  studyLabel: "",
  note: "",
  title: "Working memory training and fluid intelligence",
  manuscript: "We ran three experiments. Participants were undergraduates.",
  ...over,
});

describe("assembling the prompt", () => {
  it("sends the base instructions, and the study guidance under them", () => {
    const type = studyTypeById(DEFAULT_STUDY_TYPES, "experimental")!;
    const system = buildSystem(base({ studyGuidance: type.guidance }));
    assert.ok(system.startsWith(DEFAULT_REVIEW_PROMPT));
    assert.match(system, /FOR THIS KIND OF PAPER/);
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

  it("forbids inventing literature, in the shipped default", () => {
    // Nothing in this flow searches, so any reference produced here is invented.
    assert.match(DEFAULT_REVIEW_PROMPT, /DO NOT cite literature/);
    assert.match(DEFAULT_REVIEW_PROMPT, /never name a paper, author or year/i);
  });

  it("says nothing about a study type when none was chosen", () => {
    const system = buildSystem(base());
    assert.equal(system.includes("FOR THIS KIND OF PAPER"), false);
    assert.equal(buildUser(base()).includes("classified this as"), false);
  });

  it("carries the manuscript whole, and warns about the extraction", () => {
    /* An extracted PDF has broken tables and stray running heads in it. A model
       not told that reviews the formatting of the extract, which is Karen's
       artefact and not the author's manuscript. */
    const user = buildUser(base({ manuscript: "METHODS\nWe ran three experiments." }));
    assert.match(user, /We ran three experiments\./);
    assert.match(user, /headings, tables and figure captions may be imperfectly laid out/);
  });

  it("honours a rewritten base prompt rather than the default", () => {
    // The whole point of it being editable.
    const system = buildSystem(base({ prompt: "Be brief." }));
    assert.ok(system.startsWith("Be brief."));
    assert.equal(system.includes("ABSOLUTE RULES"), false);
  });

  it("falls back to the default when the prompt has been emptied", () => {
    /* An empty box is a mistake, not an instruction to send no instructions --
       a model handed a manuscript and no system prompt writes something, and it
       would not be a review. */
    assert.ok(buildSystem(base({ prompt: "   " })).startsWith(DEFAULT_REVIEW_PROMPT));
  });
});

describe("choosing a study type", () => {
  it("resolves the guidance and the label together", () => {
    const request = requestFor({
      prompt: "P",
      types: DEFAULT_STUDY_TYPES,
      studyTypeId: "meta-analysis",
      note: "",
      title: "T",
      manuscript: "M",
    });
    assert.equal(request.studyLabel, "Meta-analysis");
    assert.match(request.studyGuidance, /Publication bias/);
  });

  it("asks an editorial nothing about randomisation", () => {
    /* The reason the chooser exists: one checklist applied to everything asks
       a position paper for its sample size. */
    const position = studyTypeById(DEFAULT_STUDY_TYPES, "position")!;
    assert.match(position.guidance, /Do not criticise it for lacking methods/);
    assert.equal(/randomisation/i.test(position.guidance), false);
  });

  it("adds nothing at all for an id that no longer exists", () => {
    // A type deleted in Settings must not resurrect as a stale guidance block.
    const request = requestFor({
      prompt: "P", types: DEFAULT_STUDY_TYPES, studyTypeId: "gone",
      note: "", title: "T", manuscript: "M",
    });
    assert.equal(request.studyGuidance, "");
    assert.equal(request.studyLabel, "");
  });
});

describe("whether it fits", () => {
  const long = (words: number): string => "word ".repeat(words);

  it("refuses when the manuscript and the review together exceed the window", () => {
    const fit = fitsContext(base({ manuscript: long(9_000) }), 8_192);
    assert.equal(fit.fits, false);
    assert.equal(fit.words, 9_000);
    assert.equal(fit.limit, 8_192);
  });

  it("leaves room for the review itself", () => {
    /* Counting only the input is how a request that "fits" gets cut off
       mid-recommendation. A request just under the window must still refuse. */
    const request = base({ manuscript: long(200) });
    const fit = fitsContext(request, 0);
    const justUnder = fitsContext(request, fit.tokens + Math.floor(REPLY_TOKENS / 2));
    assert.equal(justUnder.fits, false);
    assert.equal(fitsContext(request, fit.tokens + REPLY_TOKENS).fits, true);
  });

  it("does not refuse when the window is unknown", () => {
    /* A hosted provider reports no context length. Refusing on "we could not
       measure it" would block the models most able to do this. */
    assert.equal(fitsContext(base({ manuscript: long(50_000) }), undefined).fits, true);
    assert.equal(fitsContext(base({ manuscript: long(50_000) }), 0).fits, true);
  });

  it("counts the whole request, not the manuscript alone", () => {
    const bare = fitsContext(base({ manuscript: "x" }), 0);
    const withGuidance = fitsContext(
      base({ manuscript: "x", studyGuidance: DEFAULT_STUDY_TYPES[0]!.guidance }),
      0,
    );
    assert.ok(withGuidance.tokens > bare.tokens);
  });

  it("names both numbers and a way out", () => {
    const message = tooLongMessage(fitsContext(base({ manuscript: long(9_000) }), 8_192));
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
