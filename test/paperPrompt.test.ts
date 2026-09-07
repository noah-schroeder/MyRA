/**
 * What the paper drafter tells the model, and what it will not be talked out of.
 *
 * The rules under test are not style choices. Nothing in this flow searches, so
 * every reference the model produces here is fabricated by construction -- which
 * is why the prompt forbids citations, placeholders and invented sources, and
 * why the tool this was ported from had a "power-user mode" that replaced the
 * whole prompt and this one deliberately does not.
 *
 * The other half of the file is about the preview dialog. It renders these same
 * two functions over the same request object the main process is handed, so what
 * a user is shown is what is sent. These tests are what stop the two from
 * drifting into a preview that is merely a description.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newPaper, type Paper } from "../src/core/papers/paper.ts";
import {
  buildPaperMessages, buildSystem, buildUser, NO_SAMPLE, requestFor,
} from "../src/core/papers/prompt.ts";

function paper(patch: Partial<Paper> = {}): Paper {
  const base = newPaper({ kind: "paper", title: "Retrieval practice in undergraduate physics" });
  return { ...base, writingSample: "We report a study in which students...", ...patch };
}

describe("the system prompt", () => {
  it("carries the rules that make this safe to use on a paper", () => {
    const system = buildSystem(requestFor(paper(), paper().sections[0]!.id, { mode: "draft" }));
    assert.match(system, /DO NOT include any citations/);
    assert.match(system, /DO NOT insert citation placeholders/);
    assert.match(system, /DO NOT invent specific sources/);
    assert.match(system, /Output ONLY the section's prose/);
  });

  it("puts the author's own writing in it", () => {
    const p = paper({ writingSample: "The present study asks whether spacing survives contact." });
    const system = buildSystem(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.match(system, /spacing survives contact/);
    assert.doesNotMatch(system, /\{writing_sample\}/);
  });

  it("says what it falls back to when there is no sample", () => {
    const p = paper({ writingSample: "   " });
    const system = buildSystem(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.match(system, /No writing sample provided/);
    assert.equal(system.includes(NO_SAMPLE), true);
    /* Never an empty quote block: a model handed `"""\n\n"""` reads it as a
       sample of nothing rather than as an absence. */
    assert.doesNotMatch(system, /"""\s*"""/);
  });

  it("appends the author's paper-wide guidance without displacing the rules", () => {
    const p = paper({ instructions: "Use British spelling." });
    const system = buildSystem(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.match(system, /British spelling/);
    assert.match(system, /do NOT override the no-citations/);
    // The rules still come first, so precedence is never left to the model.
    assert.ok(system.indexOf("DO NOT include any citations") < system.indexOf("British spelling"));
  });

  it("keeps the rules even when there is no guidance at all", () => {
    const p = paper({ instructions: "", writingSample: "" });
    assert.match(buildSystem(requestFor(p, p.sections[0]!.id, { mode: "draft" })), /no citations|DO NOT include any citations/);
  });

  it("does not carry paper-wide guidance into a single-section paper", () => {
    /* A lone section shows one prompt box. Guidance left over from a whole
       paper would be instructions the page does not show. */
    const lone = { ...newPaper({ kind: "section", title: "Methods" }), instructions: "Be terse." };
    const system = buildSystem(requestFor(lone, lone.sections[0]!.id, { mode: "draft" }));
    assert.doesNotMatch(system, /Be terse/);
  });
});

describe("the message", () => {
  it("asks for the section, with the notes as the material", () => {
    const p = paper();
    p.sections[0]!.notes = "students forget the derivation by week six";
    const user = buildUser(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.match(user, /Section to write: Introduction/);
    assert.match(user, /forget the derivation by week six/);
    assert.match(user, /no citations or placeholders of any kind/);
  });

  it("gives the outline for context, and the title", () => {
    const p = paper();
    const user = buildUser(requestFor(p, p.sections[1]!.id, { mode: "draft" }));
    assert.match(user, /Paper title: Retrieval practice/);
    assert.match(user, /Introduction → Background → Methods/);
  });

  it("hands over the preceding section, but only from the second one on", () => {
    const p = paper();
    p.sections[0]!.draft = "The problem is one of durability.";
    const first = buildUser(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    const second = buildUser(requestFor(p, p.sections[1]!.id, { mode: "draft" }));
    assert.doesNotMatch(first, /immediately preceding section/);
    assert.match(second, /immediately preceding section/);
    assert.match(second, /The problem is one of durability/);
    assert.match(second, /do NOT rewrite or repeat it/);
  });

  it("carries this section's own instructions, subordinate to the rules", () => {
    const p = paper();
    p.sections[0]!.guidance = "Open with the broad problem.";
    const user = buildUser(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.match(user, /Open with the broad problem/);
    assert.match(user, /do not override the no-citations/);
  });

  it("refines the draft that is there, to the instruction given", () => {
    const p = paper();
    p.sections[0]!.draft = "A long and winding paragraph.";
    const user = buildUser(
      requestFor(p, p.sections[0]!.id, { mode: "refine", instruction: "make it more concise" }),
    );
    assert.match(user, /Section to revise: Introduction/);
    assert.match(user, /A long and winding paragraph/);
    assert.match(user, /make it more concise/);
    assert.match(user, /Output only the revised prose/);
  });

  it("has something to ask for when refine is pressed with an empty box", () => {
    const p = paper();
    p.sections[0]!.draft = "Something.";
    const user = buildUser(requestFor(p, p.sections[0]!.id, { mode: "refine", instruction: "  " }));
    assert.match(user, /Improve the clarity and flow/);
  });

  it("does not print a one-heading outline as though it were a paper", () => {
    const lone = newPaper({ kind: "section", title: "Methods" });
    lone.sections[0]!.notes = "two conditions, counterbalanced";
    const user = buildUser(requestFor(lone, lone.sections[0]!.id, { mode: "draft" }));
    assert.doesNotMatch(user, /Full section outline/);
    // The title is the section, in a paper of one.
    assert.match(user, /Section to write: Methods/);
  });
});

describe("the request", () => {
  it("is the two messages the model is sent, in order", () => {
    const p = paper();
    p.sections[0]!.notes = "notes";
    const messages = buildPaperMessages(requestFor(p, p.sections[0]!.id, { mode: "draft" }));
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
  });

  it("refuses a section that is not in the paper rather than drafting another", () => {
    const p = paper();
    /* A stale id must not quietly become section one: the author would watch
       the wrong section be overwritten. */
    assert.throws(() => requestFor({ ...p, sections: [] }, "gone", { mode: "draft" }));
  });
});
