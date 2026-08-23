/**
 * Stage 4: scoping, the editable plan, and resumability.
 *
 * The plan is the last point at which a mistake is cheap. Everything here is
 * about catching one there — a typo'd model, an emptied section — rather than
 * forty minutes into a run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, renderPlan, PlanError, type Plan } from "../src/core/research/plan.ts";
import { applyAnswers, parseScopeDraft, type ScopeQuestion } from "../src/core/research/scope.ts";
import { ResearchRun } from "../src/core/research/run.ts";

const plan: Plan = {
  scope: {
    question: "Does working memory training transfer?",
    subQuestions: ["near transfer?", "far transfer?"],
    population: "school-age children",
    timeframe: "2010 onwards",
    include: ["randomised design"],
    exclude: ["animal studies"],
  },
  category: "science",
  queries: ["working memory training transfer", "n-back training far transfer"],
  pages: 2,
  screenTop: 150,
  fullTexts: 30,
  roles: { screener: "local/small", analyst: "local/mid", synthesist: "local/big", reviewer: "local/other" },
  embedModel: "nomic-embed",
};

test("a plan survives a render and parse round trip unchanged", () => {
  const back = parsePlan(renderPlan(plan), plan);
  assert.deepEqual(back, plan);
});

test("edits made in the dialog are what the run actually uses", () => {
  const edited = renderPlan(plan)
    .replace("full_texts: 30", "full_texts: 12")
    .replace("synthesist: local/big", "synthesist: local/other")
    .replace("- animal studies", "- animal studies\n- conference abstracts");
  const back = parsePlan(edited, plan);
  assert.equal(back.fullTexts, 12);
  assert.equal(back.roles.synthesist, "local/other");
  assert.deepEqual(back.scope.exclude, ["animal studies", "conference abstracts"]);
});

test("a typo'd model is caught at the plan, not forty minutes in", () => {
  const edited = renderPlan(plan).replace("analyst: local/mid", "analyst: local/mdi");
  assert.throws(
    () => parsePlan(edited, plan, ["local/small", "local/mid", "local/big", "local/other"]),
    (err: Error) => err instanceof PlanError && /not a configured model/.test(err.message),
  );
});

test("a model without a provider is rejected rather than guessed at", () => {
  const edited = renderPlan(plan).replace("reviewer: local/other", "reviewer: other");
  assert.throws(() => parsePlan(edited, plan), (e: Error) => /use provider\/id/.test(e.message));
});

test("emptying a section that the run needs fails loudly", () => {
  const noQueries = renderPlan(plan).replace(/## Queries\n[\s\S]*?\n\n/, "## Queries\n\n");
  assert.throws(() => parsePlan(noQueries, plan), (e: Error) => /no queries/.test(e.message));

  const noSubs = renderPlan(plan).replace(/## Sub-questions\n[\s\S]*?\n\n/, "## Sub-questions\n\n");
  assert.throws(() => parsePlan(noSubs, plan), (e: Error) => /no sub-questions/.test(e.message));
});

test("placeholders are read as absent, not as content", () => {
  const bare = { ...plan, scope: { ...plan.scope } };
  delete (bare.scope as { population?: string }).population;
  delete (bare.scope as { timeframe?: string }).timeframe;
  const rendered = renderPlan({ ...bare, queries: plan.queries });
  assert.match(rendered, /\(not specified\)/);
  const back = parsePlan(rendered, plan);
  assert.equal(back.scope.population, undefined);
  assert.equal(back.scope.timeframe, undefined);
});

test("caps are clamped rather than trusted", () => {
  const silly = renderPlan(plan).replace("full_texts: 30", "full_texts: 99999");
  assert.equal(parsePlan(silly, plan).fullTexts, 100);
  const bad = renderPlan(plan).replace("pages: 2", "pages: none");
  assert.throws(() => parsePlan(bad, plan), (e: Error) => /positive number/.test(e.message));
});

test("scoping pre-fills what the question already answered", () => {
  const draft = parseScopeDraft(
    JSON.stringify({
      subQuestions: ["a", "b"],
      population: "school-age children",
      include: ["randomised"],
      exclude: ["animal"],
      questions: [{ slot: "timeframe", ask: "How far back should I look?" }],
    }),
    "Does WM training transfer in children?",
  );
  // The population was stated, so it is filled in and NOT asked about.
  assert.equal(draft.population, "school-age children");
  assert.equal(draft.questions.length, 1);
  assert.equal(draft.questions[0]!.slot, "timeframe");
});

test("a skipped question keeps what the model inferred", () => {
  const q: ScopeQuestion = { slot: "timeframe", ask: "How far back?" };
  const draft = { subQuestions: ["a"], include: [], exclude: [], timeframe: "2010 onwards", questions: [q] };
  const scope = applyAnswers(draft, "Q", new Map([[q, "   "]]));
  assert.equal(scope.timeframe, "2010 onwards");
  const answered = applyAnswers(draft, "Q", new Map([[q, "since 2015"]]));
  assert.equal(answered.timeframe, "since 2015");
});

test("an answer with nowhere structured to go still constrains the run", () => {
  const q: ScopeQuestion = { slot: "other", ask: "Anything else?" };
  const scope = applyAnswers(
    { subQuestions: ["a"], include: [], exclude: [], questions: [q] },
    "Q",
    new Map([[q, "English-language only"]]),
  );
  assert.deepEqual(scope.include, ["English-language only"]);
});

test("a crashed stage does not look finished on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "resume-"));
  const run = await ResearchRun.create("q", root);
  await run.appendPartial("candidates.jsonl", { id: 1 });
  await run.appendPartial("candidates.jsonl", { id: 2 });
  // Output file is also the done-marker, so a half-written one would be fatal:
  // the run would carry on with two thirds of its candidates and never know.
  assert.equal(run.isDone("discover"), false);
  assert.equal((await run.readPartial("candidates.jsonl")).length, 2);
  await run.finalize("candidates.jsonl");
  assert.equal(run.isDone("discover"), true);
  assert.equal((await run.readJsonl("candidates.jsonl")).length, 2);
});

test("a stage that produced nothing still marks itself done", async () => {
  const root = mkdtempSync(join(tmpdir(), "empty-"));
  const run = await ResearchRun.create("q", root);
  await run.finalize("claims.jsonl");
  assert.equal(run.isDone("extract"), true);
  assert.deepEqual(await run.readJsonl("claims.jsonl"), []);
});

test("pause is a file, so it survives a crash and a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "pause-"));
  const run = await ResearchRun.create("q", root);
  assert.equal(run.isPaused(), false);
  await run.pause();
  assert.equal(run.isPaused(), true);
  const reopened = await ResearchRun.open(run.id, root);
  assert.equal(reopened.isPaused(), true);
  await reopened.resume();
  assert.equal(run.isPaused(), false);
});

test("the run resumes at the first stage with no output", async () => {
  const root = mkdtempSync(join(tmpdir(), "next-"));
  const run = await ResearchRun.create("q", root);
  assert.equal(run.nextStage(), "scope");
  await run.writeJson("scope.json", { question: "q" });
  await run.write("plan.md", "# plan");
  assert.equal(run.nextStage(), "discover");
});
