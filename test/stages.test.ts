/**
 * The two stages where a quiet failure would be invisible.
 *
 * Screening decides what gets read, so a candidate the model forgot to mention
 * must not simply disappear. Extraction feeds the synthesist, so a passage the
 * model composed rather than copied must not reach it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenPrompt, parseDecisions, type Candidate } from "../src/core/research/screen.ts";
import { locateClaims } from "../src/core/research/extract.ts";
import { buildRequest, extractJson, parseJsonReply } from "../src/core/llm/chat.ts";
import { findVerbatim } from "../src/core/research/sources.ts";

const batch: Candidate[] = [
  { id: 1, title: "Working memory training", url: "https://a", abstract: "n-back training" },
  { id: 2, title: "Perovskite stability", url: "https://b", abstract: "degradation" },
  { id: 3, title: "Memory span in children", url: "https://c" },
];

test("a candidate the model never mentioned is kept, not lost", () => {
  const out = parseDecisions('[{"id":1,"include":true,"reason":"on topic"},{"id":2,"include":false,"reason":"wrong field"}]', batch);
  assert.equal(out.length, 3);
  const three = out.find((d) => d.id === 3)!;
  // Screening decides what gets read at all. Silence must never mean exclusion.
  assert.equal(three.include, true);
  assert.equal(three.defaulted, true);
});

test("decisions for candidates that were never sent are discarded", () => {
  const out = parseDecisions('[{"id":99,"include":true,"reason":"hallucinated"},{"id":1,"include":false,"reason":"off topic"}]', batch);
  assert.equal(out.length, 3);
  assert.equal(out.some((d) => d.id === 99), false);
  assert.equal(out.find((d) => d.id === 1)!.include, false);
});

test("a duplicated id keeps the first decision rather than the last", () => {
  const out = parseDecisions('[{"id":1,"include":true,"reason":"first"},{"id":1,"include":false,"reason":"second"}]', batch);
  assert.equal(out.find((d) => d.id === 1)!.reason, "first");
});

test("the screening prompt carries the criteria the decision is judged against", () => {
  const p = buildScreenPrompt(
    { question: "Does X help Y?", include: ["measures Y directly"], exclude: ["animal studies"] },
    batch,
  );
  assert.match(p, /Does X help Y\?/);
  assert.match(p, /measures Y directly/);
  assert.match(p, /animal studies/);
  assert.match(p, /\(no abstract available\)/); // candidate 3 has none
});

const SOURCE = `Results and Discussion

The intervention produced a reliable improvement on the trained task,
but transfer to untrained measures was not observed at either follow-up.

We therefore caution against strong claims of generalisation.`;

test("an extracted passage is located by real offsets into the stored text", () => {
  const reply = JSON.stringify([
    { question: "does it transfer?", claim: "no transfer to untrained tasks",
      quote: "transfer to untrained measures was not observed at either follow-up" },
  ]);
  const { claims, dropped } = locateClaims(reply, 7, SOURCE);
  assert.equal(dropped.length, 0);
  assert.equal(claims.length, 1);
  const c = claims[0]!;
  assert.equal(c.source, 7);
  // The offsets must point into the stored file, or "check this" opens the wrong place.
  assert.equal(SOURCE.slice(c.start, c.end), "transfer to untrained measures was not observed at either follow-up");
});

test("a quote spanning a line break still locates, with offsets spanning it", () => {
  const reply = JSON.stringify([
    { question: "q", claim: "c", quote: "improvement on the trained task, but transfer" },
  ]);
  const { claims } = locateClaims(reply, 1, SOURCE);
  assert.equal(claims.length, 1);
  // pdftotext breaks lines mid-sentence; a model quoting the paper will not.
  assert.match(SOURCE.slice(claims[0]!.start, claims[0]!.end), /improvement on the trained task,\s+but transfer/);
});

test("a passage that is not in the source is dropped with a reason", () => {
  const reply = JSON.stringify([
    { question: "q", claim: "transfer was observed", quote: "transfer to untrained measures was clearly observed" },
  ]);
  const { claims, dropped } = locateClaims(reply, 3, SOURCE);
  assert.equal(claims.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.reason, /not found verbatim/);
});

test("findVerbatim returns undefined rather than a wrong span", () => {
  assert.equal(findVerbatim(SOURCE, "entirely absent sentence"), undefined);
  assert.equal(findVerbatim(SOURCE, ""), undefined);
});

test("JSON is recovered from the wrappers models actually produce", () => {
  assert.deepEqual(parseJsonReply('```json\n[{"id":1}]\n```'), [{ id: 1 }]);
  assert.deepEqual(parseJsonReply('Sure! Here you go:\n[{"id":2}]\nLet me know if you need more.'), [{ id: 2 }]);
  // A brace inside a string must not end the scan early.
  assert.deepEqual(parseJsonReply('[{"reason":"uses a } brace"}]'), [{ reason: "uses a } brace" }]);
  assert.equal(extractJson("no json here at all"), undefined);
});

test("subagent stages run sealed off by default", () => {
  // v1 asserted the pi flags that sealed a stage off: --no-tools,
  // --no-extensions, --no-skills, --no-context-files, --no-session. None of
  // those exist any more because none of those capabilities do -- a stage is
  // one HTTP request carrying exactly the messages it was given. What still
  // needs asserting is that nothing else rides along, and that a stage is not
  // quietly creative: a warm model invents owners for action items.
  const body = buildRequest({ model: "m", messages: [{ role: "user", content: "go" }] });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream", "temperature"]);
  assert.deepEqual(body.messages, [{ role: "user", content: "go" }]);
  assert.equal(body.stream, false);
  assert.ok(body.temperature <= 0.2, `temperature ${body.temperature} is too warm for extraction`);
});


test("unassigned roles fall back to the model the user is already using", async () => {
  const { resolveRoles, reviewerIsSynthesist } = await import("../src/core/research/roles.ts");
  const roles = resolveRoles({ models: { synthesist: "local/big" } }, "local/current");
  // First run must work with zero configuration — that is the whole point of
  // falling back to the header dropdown rather than demanding a setup screen.
  assert.equal(roles.synthesist, "local/big");
  assert.equal(roles.screener, "local/current");
  assert.equal(roles.analyst, "local/current");
  assert.equal(reviewerIsSynthesist(roles), false);
  assert.equal(reviewerIsSynthesist(resolveRoles({ models: {} }, "local/one")), true);
});

test("a role config with a bare model id is ignored, not half-used", async () => {
  const { readRoleConfig } = await import("../src/core/research/roles.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const p = join(mkdtempSync(join(tmpdir(), "roles-")), "roles.json");
  // "big-model" has no provider, so pi could not resolve it; a stage silently
  // running on the wrong model is worse than a stage falling back visibly.
  writeFileSync(p, JSON.stringify({ models: { synthesist: "big-model", reviewer: "local/ok" } }));
  const cfg = readRoleConfig(p);
  assert.equal(cfg.models.synthesist, undefined);
  assert.equal(cfg.models.reviewer, "local/ok");
});

/*
 * The embeddings endpoint lives in Settings, and only in Settings.
 *
 * It used to be duplicated into research.json, which is how the ranking stage
 * came to be permanently skipped: the GUI wrote settings.json, the pipeline
 * read research.json, and neither ever mentioned the other.
 */
test("the embeddings endpoint is read from Settings, not research.json", async () => {
  const { configuredEmbeddingEndpoint } = await import("../src/core/research/embed.ts");
  const endpoint = configuredEmbeddingEndpoint({
    embeddings: { baseUrl: "http://127.0.0.1:8890/v1/", envVar: "", model: "nomic-embed", timeoutMs: 0 },
  });
  assert.equal(endpoint?.model, "nomic-embed");
  // The trailing slash is stripped, or every request doubles it.
  assert.equal(endpoint?.baseUrl, "http://127.0.0.1:8890/v1");
});

test("a half-configured embeddings endpoint is treated as absent", async () => {
  const { configuredEmbeddingEndpoint } = await import("../src/core/research/embed.ts");
  // A base URL with no model cannot be called, so ranking must be skipped
  // rather than attempted and failed mid-run.
  assert.equal(
    configuredEmbeddingEndpoint({
      embeddings: { baseUrl: "http://x/v1", envVar: "", model: "", timeoutMs: 0 },
    }),
    undefined,
  );
  assert.equal(
    configuredEmbeddingEndpoint({
      embeddings: { baseUrl: "", envVar: "", model: "nomic-embed", timeoutMs: 0 },
    }),
    undefined,
  );
});

test("a missing embeddings key is reported as a key problem, not a network one", async () => {
  const { configuredEmbeddingEndpoint } = await import("../src/core/research/embed.ts");
  assert.throws(
    () =>
      configuredEmbeddingEndpoint({
        embeddings: {
          baseUrl: "http://x/v1",
          envVar: "KAREN_TEST_EMBED_KEY_ABSENT",
          model: "m",
          timeoutMs: 0,
        },
      }),
    /has not been unlocked/,
  );
});

test("screening batches are worked out before any of them runs", async () => {
  const { batchRanges } = await import("../src/core/research/screen.ts");
  // A batch can take minutes on a modest endpoint, so the boundaries have to be
  // known up front — reporting only on completion made the first batch
  // indistinguishable from a hang.
  assert.deepEqual(batchRanges(7, 3), [
    { n: 1, of: 3, from: 1, to: 3 },
    { n: 2, of: 3, from: 4, to: 6 },
    { n: 3, of: 3, from: 7, to: 7 },
  ]);
  assert.deepEqual(batchRanges(150, 50).map((r) => `${r.n}/${r.of} ${r.from}-${r.to}`),
    ["1/3 1-50", "2/3 51-100", "3/3 101-150"]);
  assert.deepEqual(batchRanges(0, 50), []);
});

test("a stage that cannot reach its endpoint fails loudly", async () => {
  // The failure mode this guards is silence: v1 carried an empty string forward
  // into the next stage, so a dead endpoint produced a confident, sourceless
  // report instead of an error.
  const { runSubagent } = await import("../src/core/llm/chat.ts");
  await assert.rejects(
    () =>
      runSubagent({
        model: "m",
        prompt: "x",
        idleTimeoutMs: 200,
        // Reserved by RFC 6761 and guaranteed not to resolve.
        endpoint: { baseUrl: "http://unreachable.invalid:9/v1", envVar: "K", timeoutMs: 200 },
      }),
    (err: Error) => err.name === "SubagentError" && !/0 minutes/.test(err.message),
  );
});

/*
 * Truncating the candidate list must not throw away whole queries.
 *
 * Without an embeddings model the shortlist was `slice(0, screenTop)`, and
 * candidates accumulate query by query -- so the plan's later queries were
 * never screened, never counted in the funnel, and left no record of having
 * been dropped. The plan asks for seven queries because different fields name
 * the same construct differently; keeping only the first two defeats that.
 */
test("without embeddings, the shortlist still represents every query", async () => {
  const { fairShortlist } = await import("../src/core/research/screen.ts");
  // Seven queries, twenty hits each, in the order discovery produced them.
  const candidates = Array.from({ length: 7 }, (_, q) =>
    Array.from({ length: 20 }, (_, i) => ({ id: q * 20 + i + 1, foundBy: q })),
  ).flat();

  const kept = fairShortlist(candidates, 70);
  assert.equal(kept.length, 70);

  const perQuery = new Map<number, number>();
  for (const c of kept) perQuery.set(c.foundBy, (perQuery.get(c.foundBy) ?? 0) + 1);
  assert.equal(perQuery.size, 7, "a query was dropped entirely");
  for (const [q, n] of perQuery) assert.equal(n, 10, `query ${q} got ${n}`);

  // The old behaviour, for contrast: the last four queries never got screened.
  const naive = candidates.slice(0, 70);
  assert.equal(new Set(naive.map((c) => c.foundBy)).size, 4);
});

test("a query that found little does not lose its hits to one that found a lot", async () => {
  const { fairShortlist } = await import("../src/core/research/screen.ts");
  const candidates = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: i + 1, foundBy: 0 })),
    { id: 41, foundBy: 1 },
    { id: 42, foundBy: 2 },
  ];
  const kept = fairShortlist(candidates, 10);
  assert.ok(kept.some((c) => c.id === 41), "the single hit from query 1 was dropped");
  assert.ok(kept.some((c) => c.id === 42), "the single hit from query 2 was dropped");
  assert.equal(kept.length, 10);
});

test("a shortlist longer than the list is the list, in its original order", async () => {
  const { fairShortlist } = await import("../src/core/research/screen.ts");
  const candidates = [
    { id: 1, foundBy: 0 },
    { id: 2, foundBy: 1 },
    { id: 3, foundBy: 0 },
  ];
  assert.deepEqual(fairShortlist(candidates, 50), candidates);
  // Output order always follows input order, so run ids stay readable.
  assert.deepEqual(fairShortlist(candidates, 2).map((c) => c.id), [1, 2]);
});

test("candidates with no recorded query share one bucket rather than starving the rest", async () => {
  const { fairShortlist } = await import("../src/core/research/screen.ts");
  const candidates: { id: number; foundBy?: number }[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: i + 11, foundBy: 0 })),
  ];
  const kept = fairShortlist(candidates, 10);
  assert.equal(kept.filter((c) => c.foundBy === undefined).length, 5);
  assert.equal(kept.filter((c) => c.foundBy === 0).length, 5);
});

/*
 * A long paper is extracted in parts.
 *
 * Retrieval truncates at 60k characters and the whole thing went to the model
 * in one call: ~15k tokens, which overflows a 32k-context local model once the
 * reply is accounted for, and on a long paper the truncation lands in the
 * results and discussion -- the half the question is answered from.
 */
test("chunking splits on paragraph boundaries, never mid-sentence", async () => {
  const { chunkText } = await import("../src/core/research/extract.ts");
  const para = (n: number) => `Paragraph ${n}. ${"word ".repeat(40)}`.trim();
  const text = Array.from({ length: 30 }, (_, i) => para(i)).join("\n\n");

  const chunks = chunkText(text, 1_000);
  assert.ok(chunks.length > 1, "a long document should be split");
  for (const c of chunks) {
    // A boundary landing mid-sentence would make any passage spanning it
    // unlocatable: the model quotes across the join and the verbatim check
    // correctly rejects it.
    assert.match(c.trimStart(), /^Paragraph \d+\./);
    assert.ok(c.trimEnd().endsWith("word"));
  }
  // Nothing is lost or duplicated in the split.
  assert.equal(chunks.join("\n\n"), text);
});

test("a short source is one chunk, unchanged", async () => {
  const { chunkText } = await import("../src/core/research/extract.ts");
  assert.deepEqual(chunkText("short text", 1_000), ["short text"]);
});

test("a single oversized paragraph is passed through whole rather than cut", async () => {
  const { chunkText } = await import("../src/core/research/extract.ts");
  // A PDF extracted with no blank lines. An oversized chunk is recoverable;
  // an unlocatable quote is not.
  const huge = "x".repeat(5_000);
  assert.deepEqual(chunkText(huge, 1_000), [huge]);
});

test("passages are located against the whole file, not against their chunk", async () => {
  const { locateClaims } = await import("../src/core/research/extract.ts");
  const head = "Introduction. ".repeat(200);
  const finding = "The effect was absent in the replication sample.";
  const full = `${head}\n\n${finding}`;

  // A claim extracted from the SECOND chunk, located against the full text.
  const located = locateClaims(
    JSON.stringify([{ question: "q", claim: "no effect", quote: finding }]),
    1,
    full,
  );
  assert.equal(located.claims.length, 1);
  assert.equal(full.slice(located.claims[0]!.start, located.claims[0]!.end), finding);
  // Offsets must point past the first chunk, or "open this citation" opens the
  // wrong part of the document.
  assert.ok(located.claims[0]!.start > head.length - 1);
});
