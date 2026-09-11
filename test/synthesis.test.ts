/**
 * Stage 3: synthesis, verification, review, revision.
 *
 * The tests here are about what must NOT happen — a citation pointing at
 * nothing, a claim silently passing as verified, a revision quietly inventing
 * a source. Those are the failures that would reach the final report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSynthesisPrompt, formatClaims, DanglingCitationError } from "../src/core/research/synthesize.ts";
import {
  buildVerifyPrompt, pairsToCheck, parseVerdicts, splitCitedSentences, summarizeChecks,
} from "../src/core/research/verify.ts";
import { buildRevisionPrompt, formatFlags } from "../src/core/research/review.ts";
import { auditCitations, makeSourceRecord, type SourceRecord } from "../src/core/research/sources.ts";
import type { Claim } from "../src/core/research/extract.ts";

const sources: SourceRecord[] = [1, 2].map((n) =>
  makeSourceRecord(n, `text ${n}`, { url: `https://s${n}`, title: `Source ${n}`, via: "pdf" }),
);

const claims: Claim[] = [
  { source: 1, question: "does it work?", claim: "improves the trained task", quote: "gains on the trained task were reliable", start: 0, end: 10 },
  { source: 1, question: "does it transfer?", claim: "no transfer", quote: "no transfer to untrained measures", start: 20, end: 30 },
  { source: 2, question: "does it transfer?", claim: "some transfer", quote: "modest transfer was observed", start: 5, end: 15 },
];

test("the synthesist is given located claims, never raw sources", () => {
  const p = buildSynthesisPrompt({ question: "Does training transfer?", subQuestions: ["short term?"], claims, sources });
  assert.match(p, /SOURCE \[1\]/);
  assert.match(p, /"gains on the trained task were reliable"/);
  // Whatever is not in the claims table cannot be cited, because it is not shown.
  assert.match(p, /do not write author names, years, venues, URLs or a reference list/);
  assert.match(p, /Where sources disagree, say so and cite both/);
});

test("claims are grouped by source so one paper reads as one voice", () => {
  const out = formatClaims(claims);
  assert.equal((out.match(/SOURCE \[1\]/g) ?? []).length, 1);
  assert.ok(out.indexOf("SOURCE [1]") < out.indexOf("SOURCE [2]"));
});

test("a draft citing a source that does not exist is a hard error", () => {
  const audit = auditCitations("Training works [1] and generalises [9].", sources);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.dangling, [9]);
  // Neither dropping the marker nor renumbering it is safe: one leaves an
  // unsupported sentence, the other attaches it to an unrelated source.
  const err = new DanglingCitationError(audit.dangling);
  assert.match(err.message, /cites 1 source\(s\) that do not exist: \[9\]/);
});

const DRAFT = `# Findings

Training reliably improves the trained task [1]. Transfer to untrained measures was not seen [1].

A second study reports modest transfer [2]. Both agree the effect is small [1][2].

This sentence has no citation and is not verified here.`;

test("only cited sentences are checked, and each keeps its citations", () => {
  const s = splitCitedSentences(DRAFT);
  assert.equal(s.length, 4);
  assert.equal(s.some((x) => x.text.includes("no citation")), false);
  assert.deepEqual(s[3]!.citations, [1, 2]);
  // A sentence citing two sources is two separate questions.
  assert.equal(pairsToCheck(s).length, 5);
});

test("headings are not mistaken for claims", () => {
  assert.equal(splitCitedSentences("# Heading [1]\n\nReal sentence [1].").length, 1);
});

test("a bulleted quote list is one claim per bullet, not one claim for the whole list", () => {
  // Real shape from synthesis: one quoted passage per bullet, each ending in
  // "[n]" with no full stop. Without a list-item split, all four bullets glue
  // into one "sentence" and every source is then checked against the other
  // three bullets it was never cited for.
  const draft = [
    "**1. Does it work?**  ",
    '- "effect sizes related more to the outcome than the agent" [1]  ',
    '- "we found small positive effects on learning" [2]  ',
    '- "significant positive impacts on student learning" [4]  ',
  ].join("\n");
  const s = splitCitedSentences(draft);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.citations), [[1], [2], [4]]);
  // The heading carries no citation and is dropped, not glued to bullet one.
  assert.equal(s.every((x) => !x.text.includes("Does it work")), true);
  assert.equal(pairsToCheck(s).length, 3);
});

test("a pair the verifier skipped is unchecked, never assumed supported", () => {
  const pairs = pairsToCheck(splitCitedSentences(DRAFT));
  const checks = parseVerdicts('[{"n":1,"verdict":"supports","note":"direct"}]', pairs);
  assert.equal(checks.length, pairs.length);
  assert.equal(checks[0]!.verdict, "supports");
  // Presenting an unverified claim as verified is the failure this stage exists
  // to prevent, so silence must be visible.
  assert.equal(checks[1]!.verdict, "unchecked");
  assert.match(checks[1]!.note, /no verdict returned/);
});

test("verdict wording is normalised, and nonsense is not guessed at", () => {
  const pairs = pairsToCheck(splitCitedSentences("A [1]. B [1]. C [1]. D [1]."));
  const checks = parseVerdicts(
    '[{"n":1,"verdict":"Supported"},{"n":2,"verdict":"CONTRADICTS"},{"n":3,"verdict":"does not address it"},{"n":4,"verdict":"banana"}]',
    pairs,
  );
  assert.deepEqual(checks.map((c) => c.verdict), ["supports", "contradicts", "does not address", "unchecked"]);
});

test("the verifier sees only the passages of the source it is judging against", () => {
  const pairs = pairsToCheck(splitCitedSentences("Modest transfer occurred [2]."));
  const p = buildVerifyPrompt(pairs, claims);
  assert.match(p, /SOURCE \[2\]/);
  assert.doesNotMatch(p, /SOURCE \[1\]/);
  assert.match(p, /not your own knowledge of the topic/);
});

test("the summary counts every verdict, including the unchecked ones", () => {
  const out = summarizeChecks([
    { sentenceIndex: 0, sentence: "a", source: 1, verdict: "supports", note: "" },
    { sentenceIndex: 1, sentence: "b", source: 1, verdict: "unchecked", note: "" },
    { sentenceIndex: 2, sentence: "c", source: 2, verdict: "contradicts", note: "" },
  ]);
  assert.match(out, /supports\s+1/);
  assert.match(out, /contradicts\s+1/);
  assert.match(out, /unchecked\s+1/);
});

test("revision is told exactly which numbers are citable", () => {
  const p = buildRevisionPrompt({
    question: "Q", draft: DRAFT, review: "Overreaches in paragraph two.",
    flagged: [{ sentenceIndex: 1, sentence: "Transfer was not seen [1].", source: 1, verdict: "does not address", note: "passage is about training gains" }],
    sources,
  });
  assert.match(p, /Valid source numbers are: 1, 2/);
  assert.match(p, /must be weakened to what the/);
  // The reviser has no new evidence, so a new citation would be invented.
  assert.match(p, /do not add citations to sources that were not/);
  assert.match(p, /Where the reviewer is wrong, keep your position/);
});

test("clean verification is stated plainly rather than left blank", () => {
  assert.match(formatFlags([]), /every cited statement was judged supported/);
});

test("the PRISMA funnel and summary are derived from the files, not tracked", async () => {
  const { ResearchRun } = await import("../src/core/research/run.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "funnel-"));
  const run = await ResearchRun.create("does training transfer", root);

  for (const [i, key] of ["a", "b", "b", "c"].entries()) {
    await run.append("candidates.jsonl", { url: `https://${i}`, dedupeKey: key });
  }
  await run.append("screened.jsonl", { id: 1, include: true });
  await run.append("screened.jsonl", { id: 2, include: false });
  await run.saveSource(
    makeSourceRecord(1, "body", { url: "https://a", title: "A", via: "pdf" }),
    "body",
  );
  await run.write("report.md", "Only source one is cited here [1].");
  await run.append("verification.jsonl", { verdict: "supports" });
  await run.append("verification.jsonl", { verdict: "does not address" });
  await run.append("dropped-claims.jsonl", { reason: "not found verbatim" });

  // 4 candidates but only 3 distinct urls, and one screened in.
  assert.equal(await run.funnel(), "4 found → 3 deduped → 1 screened in → 1 read in full → 1 cited");
  const summary = await run.summary();
  assert.match(summary, /1 supported, 0 contradicted, 1 unsupported/);
  assert.match(summary, /1 extracted passage\(s\) discarded/);
});
