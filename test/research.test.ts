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
import {
  readResearchConfig, readsDocuments, readsLibrary, reaches, RESEARCH_MODES, searches,
  serializeResearchConfig, type ResearchMode,
} from "../src/core/research/config.ts";


/**
 * Put KAREN_RESEARCH_CONFIG back where test/setup.ts left it.
 *
 * Deleting it instead -- which two tests here used to do -- does not restore
 * the default, it removes the isolation: the path then falls back to the real
 * ~/.config/karen/research.json, and every later test in the file starts
 * reading whatever the developer last clicked in the running app.
 */
function restoreResearchConfig(): void {
  process.env["KAREN_RESEARCH_CONFIG"] = join(process.env["KAREN_CONFIG_DIR"] ?? tmpdir(), "research.json");
}

function configFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "karen-research-"));
  const path = join(dir, "research.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

test("readResearchConfig defaults to the document rung when there is no file", () => {
  assert.deepEqual(readResearchConfig(join(tmpdir(), "definitely-not-here.json")), {
    // Not "off". Nothing egresses at this rung that would not egress at "off" --
    // the document tools are local and jailed -- so defaulting a rung down buys
    // no privacy and costs the user half of what Karen is for.
    mode: "assistant",
    // Not "general": that category has no provider in this build, and storing
    // it means a run asks for a backend nobody serves.
    category: "science",
  });
});

test("an unversioned \"off\" is read under the meaning it was written with", () => {
  // Every install predating the rungs has mode "off" on disk -- it was the
  // default -- and it meant "do not search", not "no tools at all". Reading it
  // literally would take document writing away from people who never touched
  // the control.
  const cfg = readResearchConfig(configFile({ mode: "off", category: "science" }));
  assert.equal(cfg.mode, "assistant");
});

test("a versioned \"off\" is taken at its word", () => {
  const cfg = readResearchConfig(configFile({ v: 2, mode: "off", category: "science" }));
  assert.equal(cfg.mode, "off");
});

test("serializeResearchConfig stamps the version, so a chosen off survives", () => {
  const written = serializeResearchConfig({ mode: "off", category: "science" });
  assert.equal(written["mode"], "off");
  const cfg = readResearchConfig(configFile(written));
  assert.equal(cfg.mode, "off", "a round trip must not reinterpret what the user just chose");
});

test("serializeResearchConfig keeps every field the reader looks for", () => {
  // The two halves used to live in different files. A field that survives one
  // and not the other is dropped in silence, which is worse than never offering
  // the setting at all.
  const cfg = readResearchConfig(
    configFile(serializeResearchConfig({ mode: "deep", category: "science", timeRange: "year" })),
  );
  assert.deepEqual(cfg, { mode: "deep", category: "science", timeRange: "year" });
});

test("the Zotero collection scope survives a round trip", () => {
  const cfg = readResearchConfig(
    configFile(serializeResearchConfig({
      mode: "library", category: "science",
      collection: "AAAAAAAA", collectionName: "Projects",
    })),
  );
  assert.deepEqual(cfg, {
    mode: "library", category: "science",
    collection: "AAAAAAAA", collectionName: "Projects",
  });
});

test("a collection scope is only kept when both halves are there", () => {
  /* A key with no name gives the user a control that says nothing; a name with
     no key would claim a search happened somewhere it did not. Neither half is
     usable alone, so neither is kept alone -- the search falls back to the
     whole library, which is the wider answer and cannot be mistaken for the
     narrower one. */
  const partial = [
    { collection: "AAAAAAAA" },
    { collectionName: "Projects" },
    { collection: "not a key", collectionName: "Projects" },
    { collection: "AAAAAAAA", collectionName: "   " },
  ];
  for (const extra of partial) {
    const cfg = readResearchConfig(configFile({ v: 2, mode: "library", category: "science", ...extra }));
    assert.equal(cfg.collection, undefined, JSON.stringify(extra));
    assert.equal(cfg.collectionName, undefined, JSON.stringify(extra));
  }
});

test("clearing the collection back to the whole library is expressible", () => {
  // exactOptionalPropertyTypes makes this a real question: a bare optional
  // could not be assigned undefined, so "all collections" would be unsayable
  // and the scope would be a one-way door.
  const written = serializeResearchConfig({
    mode: "library", category: "science", collection: undefined, collectionName: undefined,
  });
  assert.equal("collection" in written, false);
  assert.equal(readResearchConfig(configFile(written)).collection, undefined);
});

test("searches() is false for every mode that has no network tool", () => {
  assert.equal(searches("off"), false);
  // The one that matters: `mode !== "off"` was true here, which would have
  // handed fetch_page to the rung that must not reach the web.
  assert.equal(searches("assistant"), false);
  // And again, for the same reason, one rung later. "library" searches — it
  // searches loopback — so a gate that asked "does this mode search?" instead
  // of "does it reach the network?" would put Zotero users on the web.
  assert.equal(searches("library"), false);
  assert.equal(searches("web"), true);
  assert.equal(searches("deep"), true);
});

test("the ladder is ordered, and every gate is a rank on it", () => {
  /* The order IS the semantics: `reaches` indexes RESEARCH_MODES, so a rung
     added out of place changes what every gate means. Pinned here because that
     failure would be silent everywhere else. */
  assert.deepEqual([...RESEARCH_MODES], ["off", "assistant", "library", "web", "deep"]);

  assert.equal(reaches("deep", "off"), true);
  assert.equal(reaches("off", "assistant"), false);
  assert.equal(reaches("library", "assistant"), true, "rungs are supersets");
  assert.equal(reaches("library", "web"), false, "the library does not reach outward");
  assert.equal(reaches("web", "library"), true, "but searching keeps the library");
  assert.equal(reaches("deep", "deep"), true, "at least means at least");
});

test("the three capability questions agree with the ladder", () => {
  const table: [ResearchMode, boolean, boolean, boolean][] = [
    // mode          documents  library  network
    ["off", false, false, false],
    ["assistant", true, false, false],
    ["library", true, true, false],
    /* Not a rank. "Quick" is a question about the literature -- search
       OpenAlex, cite it, seconds -- and the personal library is a different
       question; offering both there made one feature out of two. Deep keeps it
       until it has a control of its own. See ladder.ts and RESEARCH-REWORK.md. */
    ["web", true, false, true],
    ["deep", true, true, true],
  ];
  for (const [mode, docs, lib, net] of table) {
    assert.equal(readsDocuments(mode), docs, `${mode}: documents`);
    assert.equal(readsLibrary(mode), lib, `${mode}: library`);
    assert.equal(searches(mode), net, `${mode}: network`);
  }
});

test("a stored rung is not coerced away just because it is new", () => {
  /* storedMode once enumerated the modes by hand, which would have quietly
     turned a saved "library" back into the default and left the user wondering
     why their choice never stuck. */
  const cfg = readResearchConfig(configFile({ v: 2, mode: "library", category: "science" }));
  assert.equal(cfg.mode, "library");
  assert.equal(serializeResearchConfig({ mode: "library", category: "science" })["mode"], "library");
});

test("a stored category with no backend is corrected on read", () => {
  // "general" was the default for a while, so it is written to disk on existing
  // installs and would otherwise survive there forever.
  const cfg = readResearchConfig(configFile({ mode: "web", category: "general" }));
  assert.equal(cfg.category, "science");
});

test("readResearchConfig reads a GUI selection", () => {
  const cfg = readResearchConfig(configFile({ mode: "deep", category: "science" }));
  assert.equal(cfg.mode, "deep");
  assert.equal(cfg.category, "science");
});

test("readResearchConfig refuses to trust a malformed file", () => {
  // A corrupt or hand-edited file must degrade to the default, never to a
  // random mode that silently changes which tools the model can reach. What it
  // must never degrade to is a searching mode: that would put a machine on the
  // network because a file was truncated.
  for (const bad of ["not json at all", { mode: "wat", category: 42 }, { mode: null }]) {
    const cfg = readResearchConfig(configFile(bad));
    assert.equal(cfg.mode, "assistant", `mode should be the default for ${JSON.stringify(bad)}`);
    assert.equal(searches(cfg.mode), false, "a malformed file must never enable searching");
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

  /* academic_research rather than deep_research: the deep general-web tool is
   * gated off entirely while no general-web backend exists, so it can no longer
   * stand in for "the deep tool" here. */
  for (const [mode, expected, gone] of [
    ["web", "web_search", "academic_research"],
    ["deep", "academic_research", "web_search"],
  ] as const) {
    process.env["KAREN_RESEARCH_CONFIG"] = configFile({ mode, category: "science" });
    const registry = new ToolRegistry();
    for (const def of RESEARCH_TOOL_DEFS) registry.register(def);
    registry.register(readDocument);

    const active = registry.activeNames();
    assert.ok(active.includes(expected), `${mode}: ${expected} should be active`);
    assert.ok(!active.includes(gone), `${mode}: ${gone} must NOT be reachable`);
    // Gating research must never strip the unrelated tools. fetch_page stays
    // in both searching modes: it is how a result gets read.
    assert.ok(active.includes("read_document") && active.includes("fetch_page"),
      `${mode}: non-research tools must survive`);

    // Gated off is refused, not ignored: silently returning nothing teaches the
    // model that the call succeeded.
    await assert.rejects(() => registry.dispatch(gone, {}), /not enabled/);
  }
  restoreResearchConfig();
});

/*
 * Off is not "the model decides".
 *
 * It used to be, and the model decided: asked why the sky is blue with search
 * off, it ran two failed web searches and then started a literature review. A
 * setting called off that leaves the capability in place is not a setting, it
 * is a hint -- so the tools leave the schema entirely and the reply is the
 * model's own.
 *
 * Versioned, because an unversioned "off" is deliberately read as "assistant":
 * without the stamp this test would be checking the rung above the one it
 * names, and would keep passing if "off" stopped gating anything.
 */
async function registryFor(cfg: Record<string, unknown>) {
  const { ToolRegistry } = await import("../src/core/agent/registry.ts");
  const { RESEARCH_TOOL_DEFS } = await import("../src/core/agent/tools/research.ts");
  const { DOCUMENT_TOOL_DEFS } = await import("../src/core/agent/tools/documents.ts");
  const { LIBRARY_TOOL_DEFS } = await import("../src/core/agent/tools/library.ts");
  process.env["KAREN_RESEARCH_CONFIG"] = configFile(cfg);
  const registry = new ToolRegistry();
  for (const def of [...RESEARCH_TOOL_DEFS, ...DOCUMENT_TOOL_DEFS, ...LIBRARY_TOOL_DEFS]) {
    registry.register(def);
  }
  return registry;
}

const NETWORK_TOOLS = ["web_search", "academic_research", "deep_research", "fetch_page"];
const DOCUMENT_TOOLS = ["write_document", "read_document", "convert_document"];
const LIBRARY_TOOLS = ["search_library"];

test("off leaves the model with no tool of any kind", async () => {
  const registry = await registryFor({ v: 2, mode: "off", category: "science" });

  // The whole point. An empty list is not "the model probably will not call
  // anything" -- chat() omits `tools` from the request body entirely when the
  // list is empty, so there is no name for the model to emit. That is the
  // difference between an instruction a 2.6B model may ignore and a guarantee.
  assert.deepEqual(registry.activeNames(), [], "off must send an empty schema");
  assert.deepEqual(registry.schemas(), []);

  for (const t of [...NETWORK_TOOLS, ...DOCUMENT_TOOLS, ...LIBRARY_TOOLS]) {
    await assert.rejects(() => registry.dispatch(t, {}), /not enabled/, `${t} must be refused at off`);
  }
  restoreResearchConfig();
});

test("the document rung gets the documents and nothing that reaches the network", async () => {
  const registry = await registryFor({ v: 2, mode: "assistant", category: "science" });
  const active = registry.activeNames();

  for (const t of DOCUMENT_TOOLS) assert.ok(active.includes(t), `${t} should be active`);
  /* Not the library. It was reachable here once, with nothing on screen saying
     so -- which a user cannot tell apart from the feature not existing. It has
     its own rung now, and a rung is a control. */
  assert.ok(!active.includes("search_library"), "the library needs its own rung to be honest");
  for (const t of NETWORK_TOOLS) {
    // fetch_page is the one that nearly slipped through: it was gated on
    // `mode !== "off"`, which was true for exactly one mode when it was written
    // and became true for this one the moment the rung was added.
    assert.ok(!active.includes(t), `${t} must NOT be reachable without searching on`);
    await assert.rejects(() => registry.dispatch(t, {}), /not enabled/);
  }
  restoreResearchConfig();
});

test("the library rung searches Zotero and still cannot reach the web", async () => {
  const registry = await registryFor({ v: 2, mode: "library", category: "science" });
  const active = registry.activeNames();

  assert.ok(active.includes("search_library"), "the rung exists to enable this");
  for (const t of DOCUMENT_TOOLS) assert.ok(active.includes(t), `${t} must survive: rungs are supersets`);
  for (const t of NETWORK_TOOLS) {
    /* The point of placing the library BELOW "web": Zotero answers on loopback,
       so this rung searches without anything leaving the machine. A rung that
       quietly brought the web with it would defeat the reason it exists. */
    assert.ok(!active.includes(t), `${t} must NOT be reachable at the library rung`);
    await assert.rejects(() => registry.dispatch(t, {}), /not enabled/);
  }
  restoreResearchConfig();
});

test("the library is offered where it is a sensible question, and nowhere else", async () => {
  /* Deliberately not "every rung above the library keeps it". Quick is the
     fast literature lookup, and a personal-library search sitting inside it
     made two features read as one. Deep keeps it because reading what you
     already have belongs in a long run -- but it needs its own on/off and
     collection choice first, which is why this is written out per mode rather
     than as a rank. */
  for (const [mode, expected] of [
    ["library", true], ["web", false], ["deep", true],
  ] as const) {
    const registry = await registryFor({ v: 2, mode, category: "science" });
    assert.equal(
      registry.activeNames().includes("search_library"),
      expected,
      `${mode}: search_library`,
    );
  }
  restoreResearchConfig();
});

test("searching keeps the document tools, because they are unrelated to it", async () => {
  const registry = await registryFor({ v: 2, mode: "web", category: "science" });
  const active = registry.activeNames();
  for (const t of DOCUMENT_TOOLS) assert.ok(active.includes(t), `${t} must survive a searching mode`);
  assert.ok(active.includes("web_search") && active.includes("fetch_page"));
  restoreResearchConfig();
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

/*
 * Paging has to actually reach the provider.
 *
 * The pipeline has always looped pages 1..plan.pages, but neither provider read
 * the parameter: page 2 re-ran the identical query, returned the identical
 * results, deduped them all away -- and still spent 10 OpenAlex credits. Two
 * pages across seven queries is 140 of the 1000 free daily credits, for nothing.
 */
test("a page request reaches OpenAlex as a page parameter", async () => {
  const { openAlexSearch } = await import("../src/core/research/openalex.ts");
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await openAlexSearch("working memory", 50, undefined, 3);
    await openAlexSearch("working memory", 50, undefined, 1);
  } finally {
    globalThis.fetch = real;
  }
  assert.match(seen[0]!, /[?&]page=3(&|$)/);
  assert.match(seen[0]!, /per_page=50/);
  // Page 1 is the default, so it is left off rather than sent redundantly.
  assert.ok(!/[?&]page=/.test(seen[1]!), `page= should be absent on page 1: ${seen[1]}`);
});

test("arXiv pages by result offset, not by page number", async () => {
  const { arxivSearch } = await import("../src/core/research/arxiv.ts");
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response("<feed></feed>", { status: 200 });
  }) as typeof fetch;
  try {
    await arxivSearch("working memory", 50, undefined, 3);
  } finally {
    globalThis.fetch = real;
  }
  // start is an offset into the result list: page 3 of 50 begins at 100.
  assert.match(seen[0]!, /start=100/);
  assert.match(seen[0]!, /max_results=50/);
});

/*
 * A tool the app cannot serve must not be offered.
 *
 * deep_research forces the general-web category, and this build ships only
 * scholarly providers. Offering it meant the model chose it for any
 * non-scholarly question and the user discovered the problem after answering
 * four scoping dialogs and approving a plan -- discovery returned nothing and
 * the run died with "no candidates found".
 */
test("deep_research is not offered while no general-web backend exists", async () => {
  // Config is isolated for the whole run by test/setup.ts; without it this
  // read the developer's real research.json and failed whenever they had last
  // left the app in Quick mode.
  const { RESEARCH_TOOL_DEFS } = await import("../src/core/agent/tools/research.ts");
  const byName = new Map(RESEARCH_TOOL_DEFS.map((d) => [d.name, d]));

  // In Deep, where it would otherwise be the tool of choice.
  process.env["KAREN_RESEARCH_CONFIG"] = configFile({ mode: "deep", category: "general" });

  const deep = byName.get("deep_research");
  assert.ok(deep, "deep_research should still be defined, just gated");
  assert.equal(deep.enabled?.(), false);

  // The scholarly one is the whole point of the app and must stay reachable.
  const academic = byName.get("academic_research");
  assert.ok(academic);
  assert.notEqual(academic.enabled?.(), false);
  restoreResearchConfig();

  // check_citations was registered with a handler that always threw. Gone.
  assert.equal(byName.has("check_citations"), false);
});

test("the scholarly tool describes the providers it actually searches", async () => {
  const { RESEARCH_TOOL_DEFS } = await import("../src/core/agent/tools/research.ts");
  const academic = RESEARCH_TOOL_DEFS.find((d) => d.name === "academic_research")!;
  // It claimed Crossref and Semantic Scholar. Crossref is never called at all,
  // and Semantic Scholar only resolves PDFs -- it is not a search backend.
  assert.ok(!/Crossref/i.test(academic.description), academic.description);
  assert.match(academic.description, /OpenAlex and arXiv/);
});
