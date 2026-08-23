/**
 * Tests for the research tools' pure logic.
 *
 * The parsing and normalisation here is where the bugs actually live: every
 * failure found while building these tools was a wrong assumption about a
 * response shape, not a mistake in the plumbing.
 *
 * Live-network tests are opt-in via KAREN_TEST_NETWORK=1, so the default run
 * stays deterministic and offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, htmlToText } from "../src/core/research/html.ts";
import { dedupe } from "../src/core/research/types.ts";
import { abstractFromInverted, venueOf } from "../src/core/research/openalex.ts";
import { parseArxivEntries } from "../src/core/research/arxiv.ts";

test("canonicalUrl collapses the ways one page is written", () => {
  const same = [
    "https://Example.com/a/b/",
    "https://www.example.com/a/b",
    "https://example.com/a/b#section",
    "https://example.com/a/b?utm_source=news&utm_medium=email",
  ].map(canonicalUrl);
  assert.equal(new Set(same).size, 1, `expected one canonical form, got ${JSON.stringify(same)}`);
});

test("canonicalUrl keeps parameters that identify the page", () => {
  assert.notEqual(
    canonicalUrl("https://example.com/view?id=1"),
    canonicalUrl("https://example.com/view?id=2"),
  );
});

test("dedupe keeps first-seen order and drops repeats", () => {
  const hits = [
    { url: "https://a.test/x", title: "A", content: "" },
    { url: "https://b.test/y", title: "B", content: "" },
    { url: "https://www.a.test/x?utm_source=z", title: "A again", content: "" },
  ];
  const out = dedupe(hits);
  assert.deepEqual(out.map((h: { url: string; title: string }) => h.title), ["A", "B"]);
});

test("abstractFromInverted rebuilds prose from OpenAlex's position index", () => {
  // OpenAlex ships {word: [positions]}; a repeated word carries two positions.
  const index = { Deep: [0], learning: [1, 4], "is": [2], not: [3], magic: [5] };
  assert.equal(abstractFromInverted(index), "Deep learning is not learning magic");
});

test("abstractFromInverted tolerates a missing abstract", () => {
  assert.equal(abstractFromInverted(undefined), "");
  assert.equal(abstractFromInverted(null), "");
});

test("venueOf falls back to raw_source_name when source is null", () => {
  // Very common for conference papers: OpenAlex has the proceedings title but
  // has not matched it to a source record. Reading only `source` reported
  // "venue unknown" for work that plainly has one.
  assert.equal(
    venueOf({ primary_location: { source: null, raw_source_name: "Proceedings of EACL" } }),
    "Proceedings of EACL",
  );
  assert.equal(venueOf({ primary_location: { source: { display_name: "Nature" } } }), "Nature");
  assert.equal(venueOf({}), "(venue unknown)");
});

test("parseArxivEntries reads a pdf link regardless of attribute order", () => {
  // arXiv writes href BEFORE title. An earlier regex assumed the opposite and
  // silently dropped every pdf link.
  const xml = `<feed><entry>
    <id>http://arxiv.org/abs/2505.04680v1</id>
    <title>A Paper About Things</title>
    <summary>We did some work.</summary>
    <published>2025-05-07T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="https://arxiv.org/abs/2505.04680v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2505.04680v1" rel="related" type="application/pdf" title="pdf"/>
  </entry></feed>`;

  const entry = parseArxivEntries(xml)[0]!;
  assert.equal(entry.title, "A Paper About Things");
  assert.equal(entry.pdf, "https://arxiv.org/pdf/2505.04680v1");
  assert.deepEqual(entry.authors, ["Ada Lovelace", "Alan Turing"]);
  assert.equal(entry.published, "2025-05-07");
});

test("parseArxivEntries returns nothing for an empty feed", () => {
  assert.deepEqual(parseArxivEntries("<feed></feed>"), []);
});

test("htmlToText drops chrome and keeps the article", () => {
  const html = `<html><head><title>The Title</title><style>.x{color:red}</style></head>
    <body>
      <nav>Home About Contact</nav>
      <header>Site banner</header>
      <article><p>First paragraph.</p><p>Second &amp; final.</p></article>
      <footer>Copyright 2026</footer>
      <script>alert('hi')</script>
    </body></html>`;

  const { title, text } = htmlToText(html);
  assert.equal(title, "The Title");
  assert.match(text, /First paragraph\./);
  assert.match(text, /Second & final\./, "entities should be decoded");
  for (const chrome of ["Home About Contact", "Site banner", "Copyright 2026", "alert"]) {
    assert.doesNotMatch(text, new RegExp(chrome), `"${chrome}" should have been stripped`);
  }
});

test("htmlToText keeps list structure as separate lines", () => {
  const { text } = htmlToText("<main><ul><li>alpha</li><li>beta</li></ul></main>");
  assert.match(text, /- alpha/);
  assert.match(text, /- beta/);
  assert.notEqual(text.indexOf("alpha"), text.indexOf("beta"));
});

/* ------------------------------------------------------------------ *
 * Live endpoints. Opt in with KAREN_TEST_NETWORK=1.                    *
 * ------------------------------------------------------------------ */

const live = process.env["KAREN_TEST_NETWORK"] === "1";

test("OpenAlex still returns the fields the formatter reads", { skip: !live }, async () => {
  const url =
    "https://api.openalex.org/works?search=retrieval+augmented+generation&per_page=1" +
    "&select=id,doi,title,publication_year,cited_by_count,authorships,primary_location," +
    "open_access,abstract_inverted_index,referenced_works";
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200);
  const work = ((await res.json()) as { results: Record<string, unknown>[] }).results[0]!;

  for (const field of ["title", "publication_year", "cited_by_count", "authorships"]) {
    assert.ok(work[field] !== undefined, `OpenAlex no longer returns ${field}`);
  }
  assert.ok(
    work.abstract_inverted_index === undefined ||
      typeof work.abstract_inverted_index === "object",
    "abstract must still be an inverted index, not prose",
  );
});

test("arXiv still returns a parseable Atom feed", { skip: !live }, async () => {
  const url =
    "http://export.arxiv.org/api/query?search_query=" +
    encodeURIComponent('all:"retrieval augmented generation"') +
    "&start=0&max_results=2&sortBy=relevance";
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200);

  const entries = parseArxivEntries(await res.text());
  assert.ok(entries.length > 0, "arXiv returned no entries");
  assert.ok(entries[0]!.title, "entry has no title");
  assert.ok(entries[0]!.pdf.startsWith("http"), "entry has no pdf link");
});

/* ------------------------------------------------------------------ *
 * GUI-driven research mode                                            *
 * ------------------------------------------------------------------ */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResearchConfig } from "../src/core/research/config.ts";


function configFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "karen-research-"));
  const path = join(dir, "research.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

test("readResearchConfig defaults to off when there is no file", () => {
  assert.deepEqual(readResearchConfig(join(tmpdir(), "definitely-not-here.json")), {
    mode: "off",
    category: "general",
  });
});

test("readResearchConfig reads a GUI selection", () => {
  const cfg = readResearchConfig(configFile({ mode: "deep", category: "science" }));
  assert.equal(cfg.mode, "deep");
  assert.equal(cfg.category, "science");
});

test("readResearchConfig refuses to trust a malformed file", () => {
  // A corrupt or hand-edited file must degrade to "off", never to a random
  // mode that silently changes which tools the model can reach.
  for (const bad of ["not json at all", { mode: "wat", category: 42 }, { mode: null }]) {
    const cfg = readResearchConfig(configFile(bad));
    assert.equal(cfg.mode, "off", `mode should be off for ${JSON.stringify(bad)}`);
    assert.equal(typeof cfg.category, "string");
  }
});

/*
 * The research mode control in the GUI gates which tools the model can reach.
 *
 * v1 did this by having the pi extension unregister tools at session_start,
 * which meant the test had to load the extension into a stub of pi's API and
 * re-import it per case to defeat module caching. The registry evaluates
 * `enabled()` per call instead, so a settings change takes effect on the next
 * message with no restart -- and the test is just a function call.
 */
test("the mode button really removes the other research tool", async () => {
  const { ToolRegistry } = await import("../src/core/agent/registry.ts");
  const { RESEARCH_TOOL_DEFS } = await import("../src/core/agent/tools/research.ts");

  // An unrelated tool must survive every gating decision.
  const readDocument = {
    name: "read_document", description: "", risk: "safe" as const,
    parameters: { type: "object" as const, properties: {} },
    handler: async () => ({ content: "" }),
  };

  for (const [mode, expected, gone] of [
    ["web", "web_search", "deep_research"],
    ["deep", "deep_research", "web_search"],
  ] as const) {
    process.env["KAREN_RESEARCH_CONFIG"] = configFile({ mode, category: "science" });
    const registry = new ToolRegistry();
    for (const def of RESEARCH_TOOL_DEFS) registry.register(def);
    registry.register(readDocument);

    const active = registry.activeNames();
    assert.ok(active.includes(expected), `${mode}: ${expected} should be active`);
    assert.ok(!active.includes(gone), `${mode}: ${gone} must NOT be reachable`);
    // Gating research must never strip the unrelated tools.
    assert.ok(active.includes("read_document") && active.includes("fetch_page"),
      `${mode}: non-research tools must survive`);

    // Gated off is refused, not ignored: silently returning nothing teaches the
    // model that the call succeeded.
    await assert.rejects(() => registry.dispatch(gone, {}), /not enabled/);
  }
  delete process.env["KAREN_RESEARCH_CONFIG"];
});

test("off leaves every research tool available", async () => {
  const { ToolRegistry } = await import("../src/core/agent/registry.ts");
  const { RESEARCH_TOOL_DEFS } = await import("../src/core/agent/tools/research.ts");
  process.env["KAREN_RESEARCH_CONFIG"] = configFile({ mode: "off", category: "general" });
  const registry = new ToolRegistry();
  for (const def of RESEARCH_TOOL_DEFS) registry.register(def);
  const active = registry.activeNames();
  for (const t of ["web_search", "deep_research", "academic_research"]) {
    assert.ok(active.includes(t), `${t} should be available in off mode`);
  }
  delete process.env["KAREN_RESEARCH_CONFIG"];
});

test("a tool name the model invented is refused, not ignored", async () => {
  const { ToolRegistry, UnknownToolError } = await import("../src/core/agent/registry.ts");
  const registry = new ToolRegistry();
  await assert.rejects(() => registry.dispatch("bash", { command: "rm -rf /" }), UnknownToolError);
  await assert.rejects(() => registry.dispatch("write_file", { path: "/etc/passwd" }), UnknownToolError);
});

test("parseCategories splits SearXNG's comma form and drops blanks and repeats", async () => {
  const { parseCategories } = await import("../src/core/research/config.ts");
  assert.deepEqual(parseCategories("science"), ["science"]);
  assert.deepEqual(parseCategories("science,news"), ["science", "news"]);
  assert.deepEqual(parseCategories("science, news ,"), ["science", "news"]);
  assert.deepEqual(parseCategories("science,science"), ["science"]);
  assert.deepEqual(parseCategories(""), []);
  assert.deepEqual(parseCategories(" , , "), []);
});

test("a multi-category selection survives a round trip through the plan document", async () => {
  const { renderPlan, parsePlan } = await import("../src/core/research/plan.ts");
  const plan = {
    scope: { question: "q", subQuestions: ["a"], include: ["i"], exclude: ["e"] },
    category: "science,news",
    queries: ["one"],
    pages: 2,
    screenTop: 50,
    fullTexts: 10,
    roles: {
      screener: "local/qwen", analyst: "local/qwen",
      synthesist: "local/qwen", reviewer: "local/qwen",
    },
  };
  const text = renderPlan(plan as never);
  // Rendered for a human to read...
  assert.match(text, /category: science, news/);
  // ...and parsed back to exactly what SearXNG wants on the wire.
  assert.equal(parsePlan(text, plan as never).category, "science,news");
});

test("the GUI's time range wins over the model's, and 'any time' clears it", async () => {
  const { effectiveTimeRange } = await import("../src/core/research/config.ts");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");

  const dir = mkdtempSync(join(tmpdir(), "karen-tr-"));
  const path = join(dir, "research.json");
  const orig = process.env["KAREN_RESEARCH_CONFIG"];
  process.env["KAREN_RESEARCH_CONFIG"] = path;
  try {
    // Research on, no time range chosen: "any time" is a real choice and
    // overrides the model. This is the case that returned zero results.
    writeFileSync(path, JSON.stringify({ mode: "web", category: "science" }));
    assert.equal(effectiveTimeRange("year"), "");

    // Research on with an explicit range: the user's choice, not the model's.
    writeFileSync(path, JSON.stringify({ mode: "web", category: "news", timeRange: "week" }));
    assert.equal(effectiveTimeRange("year"), "week");

    // Research off: no GUI control is in play, so the model decides.
    writeFileSync(path, JSON.stringify({ mode: "off", category: "general" }));
    assert.equal(effectiveTimeRange("year"), "year");
    assert.equal(effectiveTimeRange(undefined), "");
  } finally {
    if (orig === undefined) delete process.env["KAREN_RESEARCH_CONFIG"];
    else process.env["KAREN_RESEARCH_CONFIG"] = orig;
  }
});
