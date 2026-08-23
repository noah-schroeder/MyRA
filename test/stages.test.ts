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

test("the embeddings endpoint survives the trip through research.json", async () => {
  const { readResearchConfig } = await import("../src/core/research/config.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const p = join(mkdtempSync(join(tmpdir(), "rcfg-")), "research.json");
  // Exactly what the bridge writes when Settings changes.
  writeFileSync(p, JSON.stringify({
    mode: "deep", category: "science",
    embeddings: { baseUrl: "http://10.0.2.2:8890/v1", envVar: "KAREN_EMBED_KEY", model: "nomic-embed" },
  }));
  const cfg = readResearchConfig(p);
  // The parser rebuilds field by field, so an unlisted field is silently lost.
  assert.equal(cfg.embeddings?.baseUrl, "http://10.0.2.2:8890/v1");
  assert.equal(cfg.embeddings?.model, "nomic-embed");
  assert.equal(cfg.embeddings?.envVar, "KAREN_EMBED_KEY");
});

test("a half-configured embeddings endpoint is treated as absent", async () => {
  const { readResearchConfig } = await import("../src/core/research/config.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "rcfg2-"));
  const p = join(dir, "research.json");
  // A base URL with no model cannot be called, so ranking must be skipped
  // rather than attempted and failed mid-run.
  writeFileSync(p, JSON.stringify({ mode: "deep", category: "science", embeddings: { baseUrl: "http://x/v1" } }));
  assert.equal(readResearchConfig(p).embeddings, undefined);
});

test("a missing embeddings key is reported as a key problem, not a network one", async () => {
  const { configuredEmbeddingEndpoint } = await import("../src/core/research/embed.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const p = join(mkdtempSync(join(tmpdir(), "rcfg3-")), "research.json");
  writeFileSync(p, JSON.stringify({
    mode: "deep", category: "science",
    embeddings: { baseUrl: "http://x/v1", envVar: "KAREN_TEST_EMBED_KEY_ABSENT", model: "m" },
  }));
  const prev = process.env["KAREN_RESEARCH_CONFIG"];
  process.env["KAREN_RESEARCH_CONFIG"] = p;
  try {
    assert.throws(() => configuredEmbeddingEndpoint(), /has not reached the VM/);
  } finally {
    if (prev === undefined) delete process.env["KAREN_RESEARCH_CONFIG"];
    else process.env["KAREN_RESEARCH_CONFIG"] = prev;
  }
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
