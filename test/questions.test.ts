/**
 * The planning conversation's judgement calls.
 *
 * All of these decide what a person is shown or what their answer meant, which
 * is exactly the kind of thing that is easy to get subtly wrong and impossible
 * to notice afterwards.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyRoleAnswer, cleanOptions, DEPTH_PRESETS, DEFAULT_DEPTH, depthFromLabel, depthFromText,
  depthLabel, embedderChoice, EMBEDDER_SLOT, joinAnswers, NO_EMBEDDER, ROLE_SLOTS,
  SAME_MODEL_QUESTION, wantsSeparateModels,
} from "../src/core/research/questions.ts";

describe("options a model proposed", () => {
  it("keeps concrete answers, in order", () => {
    assert.deepEqual(
      cleanOptions(["Undergraduates", "School pupils", "Adults in work"]),
      ["Undergraduates", "School pupils", "Adults in work"],
    );
  });

  it("drops the two the app already provides", () => {
    // "Other" is added by the UI on every question, and skipping is always
    // available; offering either back reads as the app guessing.
    const options = cleanOptions(["Undergraduates", "Other", "All of the above", "None of these"]);
    assert.deepEqual(options, []);
  });

  it("refuses a single option, which is a leading question rather than a choice", () => {
    assert.deepEqual(cleanOptions(["Undergraduates"]), []);
    assert.deepEqual(cleanOptions([]), [], "and no options falls back to the text box");
  });

  it("de-duplicates without caring about case, and caps the list", () => {
    assert.deepEqual(cleanOptions(["Adults", "adults ", "Children"]), ["Adults", "Children"]);
    assert.equal(cleanOptions(["a", "b", "c", "d", "e", "f"]).length, 4);
  });

  it("survives a model that answers with the wrong type entirely", () => {
    assert.deepEqual(cleanOptions("not a list"), []);
    assert.deepEqual(cleanOptions([1, 2, 3]), []);
  });

  it("joins several answers with a separator the answers do not contain", () => {
    // "adults, 18 and over" is one answer, not two, so a comma cannot be it.
    assert.equal(joinAnswers(["adults, 18 and over", "students"]), "adults, 18 and over; students");
    assert.equal(joinAnswers([" ", "one"]), "one");
  });
});

describe("depth", () => {
  it("offers presets whose numbers only ever increase", () => {
    for (let i = 1; i < DEPTH_PRESETS.length; i++) {
      const prev = DEPTH_PRESETS[i - 1]!;
      const here = DEPTH_PRESETS[i]!;
      assert.ok(here.pages >= prev.pages, `${here.name} pages`);
      assert.ok(here.screenTop > prev.screenTop, `${here.name} screened`);
      assert.ok(here.fullTexts > prev.fullTexts, `${here.name} read in full`);
      assert.ok(here.snowball >= prev.snowball, `${here.name} snowball`);
    }
  });

  it("shows the numbers rather than hiding them behind a word", () => {
    const label = depthLabel(DEPTH_PRESETS[2]!);
    assert.match(label, /Thorough/);
    assert.match(label, /3 pages per query/);
    assert.match(label, /250 screened/);
    assert.match(label, /50 read in full/);
    assert.match(label, /1 round of citation traversal/);
  });

  it("reads its own labels back", () => {
    const chosen = depthFromLabel(depthLabel(DEPTH_PRESETS[3]!));
    assert.deepEqual(chosen, { pages: 4, screenTop: 400, fullTexts: 80, snowball: 2 });
    assert.equal(depthFromLabel("something the user typed"), undefined);
  });

  it("defaults to the one the stated priority points at", () => {
    assert.ok(DEPTH_PRESETS.some((p) => p.name === DEFAULT_DEPTH));
  });

  it("reads four numbers typed by hand, in any order, keeping the rest", () => {
    const base = { pages: 2, screenTop: 150, fullTexts: 30, snowball: 0 };
    assert.deepEqual(depthFromText("snowball 2, pages: 5", base), {
      pages: 5, screenTop: 150, fullTexts: 30, snowball: 2,
    });
    assert.deepEqual(depthFromText("screen_top: 300 and full_texts: 40", base), {
      pages: 2, screenTop: 300, fullTexts: 40, snowball: 0,
    });
  });

  it("clamps what a person types to what the pipeline can actually do", () => {
    const base = { pages: 2, screenTop: 150, fullTexts: 30, snowball: 0 };
    const wild = depthFromText("pages 900, screened 9000, read 9000, snowball 9", base);
    assert.deepEqual(wild, { pages: 10, screenTop: 2000, fullTexts: 500, snowball: 3 });
  });

  it("leaves everything alone when the text names no numbers", () => {
    const base = { pages: 2, screenTop: 150, fullTexts: 30, snowball: 0 };
    assert.deepEqual(depthFromText("as deep as you like", base), base);
  });
});

describe("the model question", () => {
  it("puts the better answer first and says why, in trade-offs not adjectives", () => {
    assert.match(SAME_MODEL_QUESTION.options[0]!, /^No —/);
    assert.match(SAME_MODEL_QUESTION.message!, /screening reads/i);
    assert.match(SAME_MODEL_QUESTION.message!, /defends the reasoning it already committed to/);
  });

  it("reads the answer", () => {
    assert.equal(wantsSeparateModels("No — pick a model for each stage"), true);
    assert.equal(wantsSeparateModels("Yes — one model for everything"), false);
    // Typed by hand through "Other", which is always available.
    assert.equal(wantsSeparateModels("no, different ones please"), true);
  });
});

describe("the embedder slot", () => {
  it("is not one of the chat roles, and says so where the choice is made", () => {
    assert.equal(ROLE_SLOTS.some((s) => s.key === "embedder"), false);
    assert.match(EMBEDDER_SLOT.label, /not a chat model/i);
    // What it costs to leave it unset, in what actually changes: the shortlist.
    assert.match(EMBEDDER_SLOT.hint, /search order/i);
  });

  it("keeps the three answers apart", () => {
    // Never shown: leave the configured model alone.
    assert.equal(embedderChoice({ screener: "x" }, "bge-m3"), "bge-m3");
    // Chosen.
    assert.equal(embedderChoice({ embedder: "nomic-embed-text" }, "bge-m3"), "nomic-embed-text");
    // Deliberately none -- which must CLEAR a model that was set before, or
    // "None" would be a control that does nothing.
    assert.equal(embedderChoice({ embedder: NO_EMBEDDER }, "bge-m3"), undefined);
    // An empty dropdown sends "", and that is the same no.
    assert.equal(embedderChoice({ embedder: "" }, "bge-m3"), undefined);
  });

  it("is never folded into the chat roles by the one-model answer", () => {
    const current = { screener: "a", analyst: "a", synthesist: "a", reviewer: "a" };
    const roles = applyRoleAnswer(current, { all: "big", embedder: "bge-m3" });
    assert.deepEqual(roles, {
      screener: "big", analyst: "big", synthesist: "big", reviewer: "big",
    });
    assert.equal(Object.keys(roles).includes("embedder"), false);
  });
});
