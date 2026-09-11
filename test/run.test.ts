/**
 * Tests for the run directory.
 *
 * The properties that matter are resumability and honesty: a stage must be
 * skipped only when it genuinely finished, and the PRISMA-style counts must be
 * derived from what was actually written rather than tracked separately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchRun, runId, STAGES } from "../src/core/research/run.ts";
import { makeSourceRecord } from "../src/core/research/sources.ts";

const root = () => mkdtemp(join(tmpdir(), "myra-runs-"));

test("runId is dated, readable and unique per run", () => {
  const a = runId("CRISPR off-target effects in human cells");
  assert.match(a, /^\d{4}-\d{2}-\d{2}-crispr-off-target-effects-in-human-[0-9a-f]{4}$/);
  // Two runs of the same question on the same day must not collide.
  assert.notEqual(a, runId("CRISPR off-target effects in human cells"));
});

test("runId survives a question made entirely of punctuation", () => {
  assert.match(runId("?!!! ???"), /^\d{4}-\d{2}-\d{2}-research-[0-9a-f]{4}$/);
});

test("a fresh run starts at the first stage and records the question", async () => {
  const run = await ResearchRun.create("do statins reduce mortality", await root());
  assert.equal(run.nextStage(), STAGES[0]);
  const q = await run.readJson<{ question: string }>("question.json");
  assert.equal(q?.question, "do statins reduce mortality");
});

test("a stage counts as done only once its output exists", async () => {
  const run = await ResearchRun.create("q", await root());
  assert.equal(run.isDone("discover"), false);
  await run.append("candidates.jsonl", { url: "https://a.test", dedupeKey: "a" });
  assert.equal(run.isDone("discover"), true);
  // ...and the run now resumes past it.
  assert.notEqual(run.nextStage(), "discover");
});

test("writes are atomic, so a crash cannot leave a stage looking complete", async () => {
  // The output file is also the done-marker, so a half-written file would make
  // an interrupted stage be skipped on resume.
  const run = await ResearchRun.create("q", await root());
  await run.write("draft.md", "the whole draft");
  assert.equal(await readFile(run.path("draft.md"), "utf8"), "the whole draft");
  assert.ok(!existsSync(`${run.path("draft.md")}.${process.pid}.tmp`), "temp file should be gone");
});

test("a torn JSONL line does not lose the records around it", async () => {
  const run = await ResearchRun.create("q", await root());
  await run.append("candidates.jsonl", { url: "a" });
  await writeFile(run.path("candidates.jsonl"), await readFile(run.path("candidates.jsonl,"), "utf8").catch(() => ""), "utf8").catch(() => {});
  // Simulate a crash mid-append: a valid line, a torn line, then a valid line.
  await writeFile(run.path("candidates.jsonl"), '{"url":"a"}\n{"url":"b"\n{"url":"c"}\n', "utf8");
  const rows = await run.readJsonl<{ url: string }>("candidates.jsonl");
  assert.deepEqual(rows.map((r) => r.url), ["a", "c"]);
});

test("sources are stored with their text and can be read back", async () => {
  const run = await ResearchRun.create("q", await root());
  const text = "The measured effect was large.";
  const rec = makeSourceRecord(1, text, { url: "https://a.test", title: "A", via: "pdf" });
  await run.saveSource(rec, text);

  const back = await run.sources();
  assert.equal(back.length, 1);
  assert.equal(back[0]!.via, "pdf");
  assert.equal(await run.sourceText(1), text);
  assert.equal((await run.sourceTexts()).get(1), text);
});

test("re-saving a source replaces it rather than duplicating it", async () => {
  // Retrying one failed source in a resumed run must not create source [1] twice.
  const run = await ResearchRun.create("q", await root());
  const first = makeSourceRecord(1, "old", { url: "https://a.test", title: "old", via: "html" });
  await run.saveSource(first, "old");
  const second = makeSourceRecord(1, "new", { url: "https://a.test", title: "new", via: "pdf" });
  await run.saveSource(second, "new");

  const back = await run.sources();
  assert.equal(back.length, 1, "should be one source, not two");
  assert.equal(back[0]!.title, "new", "the later write should win");
});

test("the search log records what was asked and what came back", async () => {
  const run = await ResearchRun.create("q", await root());
  await run.logSearch({ query: "a", source: "searxng", category: "science", results: 12 });
  await run.logSearch({ query: "b", source: "searxng", results: 0, error: "timeout" });
  const log = await run.readJsonl<{ query: string; error?: string; at: string }>("search-log.jsonl");
  assert.equal(log.length, 2);
  assert.ok(log[0]!.at, "every entry is timestamped");
  assert.equal(log[1]!.error, "timeout", "failures are recorded, not dropped");
});

test("the PRISMA counts are derived from the files, not tracked separately", async () => {
  const run = await ResearchRun.create("q", await root());
  for (const key of ["a", "b", "b", "c"]) {
    await run.append("candidates.jsonl", { url: key, dedupeKey: key });
  }
  await run.append("screened.jsonl", { n: 1, keep: true });
  await run.append("screened.jsonl", { n: 2, keep: false });
  const text = "x";
  await run.saveSource(makeSourceRecord(1, text, { url: "u1", title: "t", via: "html" }), text);
  await run.saveSource(makeSourceRecord(2, text, { url: "u2", title: "t", via: "html" }), text);
  await run.write("report.md", "Only the first is cited [1].");

  const counts = await run.counts();
  assert.equal(counts.found, 4);
  assert.equal(counts.deduped, 3, "duplicate dedupeKeys collapse");
  assert.equal(counts.screened, 1, "only kept records count as screened-in");
  assert.equal(counts.read, 2);
  assert.equal(counts.cited, 1);
});

test("opening a run that does not exist fails loudly", async () => {
  await assert.rejects(() => ResearchRun.open("nope", "/tmp/definitely-not-here"), /no research run/);
});

test("runs are listed newest first", async () => {
  const dir = await root();
  await ResearchRun.create("alpha", dir);
  await ResearchRun.create("beta", dir);
  const list = await ResearchRun.list(dir);
  assert.equal(list.length, 2);
  assert.deepEqual([...list].sort().reverse(), list, "newest first");
});

/*
 * A run that could not be independently reviewed must say so.
 *
 * resolveRoles falls every unassigned role back to the single configured model,
 * so the default configuration makes the reviewer and the synthesist the same
 * model -- self-review, which is the failure the stage exists to prevent. The
 * summary is where that has to surface: it is what the report carries.
 */
test("the summary reports self-review rather than implying independence", async () => {
  const { ResearchRun } = await import("../src/core/research/run.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "myra-selfreview-"));
  try {
    const run = await ResearchRun.create("does review matter", root);
    await run.writeJson("plan.json", {
      roles: { screener: "a", analyst: "a", synthesist: "big", reviewer: "big" },
    });
    assert.match(await run.summary(), /SELF-REVIEW/);
    assert.match(await run.summary(), /both big/);

    const other = await ResearchRun.create("two models", root);
    await other.writeJson("plan.json", {
      roles: { screener: "a", analyst: "a", synthesist: "big", reviewer: "other" },
    });
    assert.ok(!/SELF-REVIEW/.test(await other.summary()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * The run's provenance has to be readable, or it is not an audit trail.
 *
 * Everything asserted here was already written to disk on every run and was
 * reachable from nowhere in the app. readRun is what makes the requirement
 * ("auditable, accurate, correctly cited") true rather than merely intended.
 */
test("readRun assembles what the run actually wrote", async () => {
  const { ResearchRun, readRun, readRunSource } = await import("../src/core/research/run.ts");
  const { makeSourceRecord } = await import("../src/core/research/sources.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "myra-readrun-"));
  try {
    const run = await ResearchRun.create("does working memory training transfer", root);
    // A stage's OUTPUT file is its done marker, so the earlier ones have to
    // exist or nextStage correctly reports the run as barely started.
    await run.writeJson("scope.json", { question: "q", subQuestions: ["a"], include: [], exclude: [] });
    await run.writeJson("plan.json", {
      queries: ["n-back transfer", "working memory training"],
      roles: { screener: "a", analyst: "a", synthesist: "b", reviewer: "c" },
    });
    await run.write("plan.md", "# Research plan\n");
    await run.logSearch({ query: "n-back transfer", source: "search", page: 1, results: 12, newResults: 12 });
    await run.logSearch({ query: "dead query", source: "search", page: 1, results: 0, error: "429" });

    await run.append("candidates.jsonl", { id: 1, title: "Far transfer of n-back", url: "https://doi.org/10.1/a", year: 2019, foundBy: 0 });
    await run.append("candidates.jsonl", { id: 2, title: "A rat study", url: "https://doi.org/10.1/b", foundBy: 1 });
    await run.append("screened.jsonl", { id: 1, include: true, reason: "measures the outcome directly" });
    await run.append("screened.jsonl", { id: 2, include: false, reason: "animal study, excluded by criteria" });

    const text = "Training produced no far transfer to fluid intelligence in this sample.";
    await run.saveSource(makeSourceRecord(1, text, {
      url: "https://doi.org/10.1/a", title: "Far transfer of n-back", via: "pdf", year: 2019,
    }), text);
    await run.append("claims.jsonl", {
      source: 1, question: "does it transfer", claim: "no far transfer",
      quote: "no far transfer to fluid intelligence", start: 18, end: 55,
    });
    await run.append("dropped-claims.jsonl", { source: 1, quote: "invented", reason: "not found verbatim" });
    await run.finalize("snowball.jsonl"); // traversal off: the stage still completes
    await run.append("verification.jsonl", { sentenceIndex: 0, sentence: "Training does not transfer [1].", source: 1, verdict: "supports", note: "" });
    await run.write("draft.md", "Training does not transfer [1].\n");
    // Deliberately no review.md or report.md: this run stopped after
    // verification, which is what the nextStage assertion below checks.

    const detail = await readRun(run.id, root);
    assert.equal(detail.question, "does working memory training transfer");
    assert.deepEqual(detail.queries, ["n-back transfer", "working memory training"]);

    // A failed query is part of the record: it explains a thin funnel.
    assert.equal(detail.searches.length, 2);
    assert.equal(detail.searches[1]!.error, "429");

    // A screening decision is useless without the paper it decided about.
    const excluded = detail.screened.find((d) => !d.include)!;
    assert.equal(excluded.title, "A rat study");
    assert.match(excluded.reason, /animal study/);

    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0]!.via, "pdf");
    assert.ok(detail.sources[0]!.sha256, "a source with no hash cannot be audited later");
    assert.equal(detail.dropped.length, 1);
    assert.equal(detail.verification[0]!.verdict, "supports");

    // Stage state is what a resume would act on, so it must be reported.
    assert.equal(detail.stages.length, 11);
    assert.equal(detail.stages.find((s) => s.stage === "screen")!.done, true);
    // verification.jsonl exists so verify is done; review.md does not, so the
    // run resumes there.
    assert.equal(detail.nextStage, "review");

    // The located passage resolves to the exact characters in the stored text.
    const source = await readRunSource(run.id, 1, root);
    assert.ok(source);
    assert.equal(source.spans.length, 1);
    assert.equal(
      source.text.slice(source.spans[0]!.start, source.spans[0]!.end),
      "no far transfer to fluid intelligence",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listRuns survives a half-created run directory", async () => {
  const { ResearchRun, listRuns } = await import("../src/core/research/run.ts");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "myra-listruns-"));
  try {
    await ResearchRun.create("a real run", root);
    // A directory with nothing in it: interrupted before question.json landed.
    await mkdir(join(root, "2026-01-01-broken-0000"), { recursive: true });
    const runs = await listRuns(root);
    assert.equal(runs.length, 2);
    assert.ok(runs.some((r) => r.question === "a real run"));
    // The broken one falls back to its id rather than hiding the other.
    assert.ok(runs.some((r) => r.question === "2026-01-01-broken-0000"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Adding a stage must not rewrite the history of finished runs.
 *
 * `snowball` was inserted between screen and retrieve. Without this, every run
 * completed before it existed would report itself as "unfinished at snowball"
 * in the run list -- describing a gap in the middle of a finished run as a
 * stopping point.
 */
test("a run from before a stage existed is not reported as unfinished", async () => {
  const { ResearchRun, STAGES } = await import("../src/core/research/run.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "myra-oldrun-"));
  try {
    const run = await ResearchRun.create("an older run", root);
    // Everything except the stage that did not exist when this run happened.
    await run.writeJson("scope.json", {});
    await run.write("plan.md", "x");
    await run.write("candidates.jsonl", "");
    await run.write("screened.jsonl", "");
    await run.write("sources/index.jsonl", "");
    await run.write("claims.jsonl", "");
    await run.write("draft.md", "x");
    await run.write("verification.jsonl", "");
    await run.write("review.md", "x");
    await run.write("report.md", "x");
    assert.equal(run.isDone("snowball"), false);
    assert.equal(run.nextStage(), undefined, "a finished run has no next stage");

    // A genuinely interrupted run still reports where it stopped.
    const stopped = await ResearchRun.create("an interrupted run", root);
    await stopped.writeJson("scope.json", {});
    await stopped.write("plan.md", "x");
    assert.equal(stopped.nextStage(), "discover");
    assert.equal(STAGES.includes("snowball"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
