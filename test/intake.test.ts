/**
 * The research-project setup chat's prompts and parsers.
 *
 * Mirrors test/questions.test.ts's own concern: these decide what a person is
 * shown, and a small model returning junk must still leave a usable dialog.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildOffersPrompt, buildTaskQuestionsPrompt, buildTaskResultPrompt, FIXED_TASKS, parseOffers,
  parseTaskQuestions, parseTaskResult, SETUP_GREETING,
} from "../src/core/projects/intake.ts";
import { newMemory } from "../src/core/projects/memory.ts";

describe("SETUP_GREETING", () => {
  it("is canned text, not something that depends on a model call", () => {
    assert.match(SETUP_GREETING, /Tell me about it/);
  });
});

describe("parsing offers", () => {
  it("keeps well-formed items and offers", () => {
    const reply = JSON.stringify({
      items: [{ slot: "aims", text: "Understand why X happens" }],
      offers: [
        { label: "Brainstorm research questions", why: "You have an aim but no questions yet." },
        { label: "Suggest guiding theories", why: "Nothing theoretical was mentioned." },
      ],
    });
    const draft = parseOffers(reply);
    assert.equal(draft.items.length, 1);
    assert.equal(draft.items[0]!.slot, "aims");
    assert.equal(draft.offers.length, 2);
    assert.equal(draft.offers[0]!.label, "Brainstorm research questions");
  });

  it("drops an item with a slot outside the fixed vocabulary", () => {
    const reply = JSON.stringify({ items: [{ slot: "vibes", text: "x" }], offers: [] });
    assert.equal(parseOffers(reply).items.length, 0);
  });

  it("falls back to the fixed menu when the model proposes fewer than two usable offers", () => {
    const reply = JSON.stringify({ items: [], offers: [{ label: "", why: "blank label" }] });
    const draft = parseOffers(reply);
    assert.deepEqual(draft.offers, [...FIXED_TASKS]);
  });

  it("falls back to the fixed menu on malformed JSON entirely", () => {
    const draft = parseOffers("not json at all");
    assert.deepEqual(draft.offers, [...FIXED_TASKS]);
    assert.deepEqual(draft.items, []);
  });

  it("the prompt names the project's own description", () => {
    const prompt = buildOffersPrompt("Whether pair programming improves retention in CS1.");
    assert.match(prompt, /Whether pair programming improves retention in CS1\./);
  });
});

describe("a task's questions", () => {
  const task = FIXED_TASKS[0]!;

  it("cleans options the same way scoping does, and drops 'Other'", () => {
    const reply = JSON.stringify({
      questions: [{ ask: "Which population?", options: ["Undergraduates", "Other", "Adults in work"] }],
    });
    const questions = parseTaskQuestions(reply);
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0]!.options, ["Undergraduates", "Adults in work"]);
  });

  it("drops a question with no text", () => {
    const reply = JSON.stringify({ questions: [{ ask: "  ", options: [] }] });
    assert.equal(parseTaskQuestions(reply).length, 0);
  });

  it("returns nothing usable from malformed JSON, rather than throwing", () => {
    assert.deepEqual(parseTaskQuestions("garbage"), []);
  });

  it("the prompt names the chosen task and what is already known", () => {
    const memory = { ...newMemory(), items: [{ id: "a", slot: "aims" as const, text: "Study X", source: "you" as const, at: "" }] };
    const prompt = buildTaskQuestionsPrompt(task, "A project about X", memory);
    assert.match(prompt, new RegExp(task.label));
    assert.match(prompt, /Study X/);
  });
});

describe("a task's result", () => {
  const task = FIXED_TASKS[0]!;

  it("keeps items tagged with a real slot", () => {
    const reply = JSON.stringify({
      items: [
        { slot: "questions", text: "Does pairing improve retention for novices specifically?" },
        { slot: "not-a-slot", text: "dropped" },
      ],
    });
    const items = parseTaskResult(reply);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.slot, "questions");
  });

  it("the prompt includes the researcher's answers", () => {
    const prompt = buildTaskResultPrompt(
      task,
      "A project about X",
      [{ ask: "Which population?", answer: "Undergraduates" }],
      newMemory(),
    );
    assert.match(prompt, /Undergraduates/);
  });
});
