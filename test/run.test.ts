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

const root = () => mkdtemp(join(tmpdir(), "karen-runs-"));

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
