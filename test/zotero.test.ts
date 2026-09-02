/**
 * The Zotero library search.
 *
 * Written against the documented shape of the local API rather than against a
 * running Zotero: there is none on this machine, so every claim here is about
 * how Karen handles a response, not proof that Zotero sends one. The parts that
 * matter are the ones where a wrong guess would be invisible -- a year read out
 * of free text, a missing abstract presented as an absent paper, and the two
 * unreachable states, which look identical and have different fixes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchLibraryTool, setLibraryHost } from "../src/core/agent/tools/library.ts";
import { harvestSources } from "../src/renderer/restore.ts";

import {
  collectionTree, descendantKeys, describeFailure, formatCreators, formatItems, linkFor,
  MAX_FANOUT, parseCollections, parseItems, searchPath, yearOf, ZOTERO_PORT,
} from "../src/core/library/zotero.ts";

/* ------------------------------------------------------------ the query --- */

test("a search asks the local prefix, not a zotero.org account", () => {
  // "users/0" is the documented local prefix and is not anybody's user id.
  const path = searchPath({ query: "working memory" });
  assert.match(path, /^\/api\/users\/0\/items\?/);
  assert.match(path, /q=working\+memory/);
});

test("everything is the default, because it is what reaches the PDFs", () => {
  assert.match(searchPath({ query: "x" }), /qmode=everything/);
  assert.match(searchPath({ query: "x", mode: "titleCreatorYear" }), /qmode=titleCreatorYear/);
});

test("attachments and notes are excluded, so parents do not look duplicated", () => {
  assert.match(searchPath({ query: "x" }), /itemType=-attachment\+%7C%7C\+note/);
});

test("the plain tier sends only what every Zotero must accept", () => {
  /* The reported failure: the collection listing worked and the search did not,
     on the same host, port and /api/ prefix, through the same function. The
     only difference between those two requests is the query string, so the
     extras are what a refusal is about. */
  const plain = searchPath({ query: "working memory" }, "plain");
  assert.match(plain, /^\/api\/users\/0\/items\?/);
  assert.match(plain, /q=working\+memory/);
  assert.match(plain, /qmode=everything/);
  assert.match(plain, /limit=25/);
  for (const dropped of ["itemType", "sort", "direction"]) {
    assert.doesNotMatch(plain, new RegExp(dropped), `${dropped} must not survive the fallback`);
  }
  // The scope is not an extra: dropping it would search somewhere else.
  assert.match(
    searchPath({ query: "x", collection: "AAAAAAAA" }, "plain"),
    /^\/api\/users\/0\/collections\/AAAAAAAA\/items\?/,
  );
});

test("attachments and notes are dropped again on the way in", () => {
  // Belt and braces on purpose: the plain tier never sends the itemType filter,
  // so without this a fallback search reads as duplicated results -- every
  // paper once, plus its PDF and its note as separate rows.
  const parsed = parseItems([
    ITEM,
    { data: { key: "PDFPDFPD", itemType: "attachment", title: "Full Text PDF" } },
    { data: { key: "NOTENOTE", itemType: "note", title: "My note" } },
  ]);
  assert.deepEqual(parsed.map((i) => i.key), ["ABCD1234"]);
});

test("the limit is clamped rather than trusted", () => {
  assert.match(searchPath({ query: "x", limit: 5000 }), /limit=100/);
  assert.match(searchPath({ query: "x", limit: 0 }), /limit=1/);
  assert.match(searchPath({ query: "x", limit: 12.7 }), /limit=12/);
  assert.match(searchPath({ query: "x" }), /limit=25/);
});

/* ------------------------------------------------------------- parsing --- */

const ITEM = {
  key: "ABCD1234",
  meta: { parsedDate: "2016-04-01", creatorSummary: "Melby-Lervåg et al." },
  data: {
    key: "ABCD1234",
    itemType: "journalArticle",
    title: "Working memory training does not improve performance",
    creators: [
      { creatorType: "author", firstName: "Monica", lastName: "Melby-Lervåg" },
      { creatorType: "author", firstName: "Charles", lastName: "Hulme" },
    ],
    abstractNote: "A meta-analytic review of the transfer evidence.",
    publicationTitle: "Perspectives on Psychological Science",
    date: "April 2016",
    DOI: "10.1177/1745691616635612",
    url: "https://example.org/paper",
    tags: [{ tag: "transfer" }, { tag: "meta-analysis" }],
    collections: ["COLLA", "COLLB"],
  },
};

test("an item is read into the fields a citation needs", () => {
  const [item] = parseItems([ITEM]);
  assert.equal(item!.key, "ABCD1234");
  assert.equal(item!.creators, "Melby-Lervåg, Hulme");
  assert.equal(item!.year, "2016");
  assert.equal(item!.doi, "10.1177/1745691616635612");
  assert.equal(item!.publication, "Perspectives on Psychological Science");
  assert.deepEqual(item!.tags, ["transfer", "meta-analysis"]);
});

test("free-text dates give up a year or nothing, never a guess", () => {
  // Zotero preserves whatever the source said, so `date` is not a date.
  assert.equal(yearOf({ date: "April 2016" }, {}), "2016");
  assert.equal(yearOf({ date: "2016-03-15" }, {}), "2016");
  assert.equal(yearOf({ date: "n.d." }, {}), "");
  assert.equal(yearOf({ date: "in press" }, {}), "");
  // parsedDate is Zotero's own normalisation and wins over the raw text.
  assert.equal(yearOf({ date: "n.d." }, { parsedDate: "1999-01-01" }), "1999");
});

test("a creator list is capped the way it would be cited", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ lastName: `A${i}` }));
  assert.equal(formatCreators(many), "A0, A1, A2 et al.");
  // A bad translator puts the whole name in one field; that is still a name.
  assert.equal(formatCreators([{ name: "World Health Organization" }]), "World Health Organization");
  assert.equal(formatCreators([]), "");
  assert.equal(formatCreators(undefined), "");
});

test("a record with neither key nor title is not something to show anyone", () => {
  assert.deepEqual(parseItems([{ data: { itemType: "journalArticle" } }, "nonsense", null]), []);
});

test("a body that is not a list is not an error, just nothing", () => {
  assert.deepEqual(parseItems({ error: "no" }), []);
  assert.deepEqual(parseItems(undefined), []);
});

/* ---------------------------------------------------------- formatting --- */

test("a missing abstract is stated, never omitted", () => {
  /* The whole reason to search a personal library is that its records are
     trustworthy. Silently dropping an empty abstract would leave the model
     unable to tell "none stored" from "not shown", and it would fill the gap. */
  const [item] = parseItems([{ ...ITEM, data: { ...ITEM.data, abstractNote: "" } }]);
  const text = formatItems([item!], "memory");
  assert.match(text, /no abstract stored in Zotero/);
});

test("the count of stored abstracts is said up front", () => {
  // Because it is the thing most likely to disappoint: a library can hold
  // hundreds of items with titles and no abstracts at all.
  const withAbstract = parseItems([ITEM])[0]!;
  const without = parseItems([{ ...ITEM, data: { ...ITEM.data, abstractNote: "" } }])[0]!;
  assert.match(formatItems([withAbstract, without], "x"), /2 item\(s\).*1 with an abstract stored/s);
});

test("an empty result says so plainly rather than returning nothing", () => {
  assert.match(formatItems([], "quantum socks"), /Nothing in the Zotero library matches "quantum socks"/);
});

test("a very long abstract is truncated rather than allowed to fill the reply", () => {
  const long = parseItems([{ ...ITEM, data: { ...ITEM.data, abstractNote: "x".repeat(3000) } }])[0]!;
  const text = formatItems([long], "x");
  assert.ok(text.length < 1500, `abstract should be trimmed, got ${text.length} chars`);
  assert.match(text, /…/);
});

/* ------------------------------------------------------------ failures --- */

test("Zotero closed and Zotero locked down are different problems", () => {
  /* They are indistinguishable from the reply and have completely different
     fixes, so they must not share a message. */
  assert.match(describeFailure(undefined), /does not appear to be reachable/);
  assert.match(describeFailure(undefined), new RegExp(String(ZOTERO_PORT)));
  /* Both addresses named. "localhost" is two of them, and reporting only the
     v4 one told a user with a v6-bound Zotero that it was not running while it
     sat there running. */
  assert.match(describeFailure(undefined), /127\.0\.0\.1/);
  assert.match(describeFailure(undefined), /\[::1\]/);
  // The sandbox case, because Zotero saying "available" and nothing reaching it
  // is otherwise a dead end for anyone running it from Flatpak or Snap.
  assert.match(describeFailure(undefined), /Flatpak/);
  assert.match(describeFailure(403), /Allow other applications/);
  assert.match(describeFailure(404), /Zotero 7 or newer/);
  assert.match(describeFailure(500), /answered 500/);
});

test("an unexplained refusal repeats what Zotero actually said", () => {
  /* "Zotero answered 400" was the entire message. It says a request was
     refused without saying which part of it was, which left the user and me
     guessing at a local server that had already written the answer down. */
  assert.match(describeFailure(400, "Invalid parameter 'itemType'"), /Invalid parameter 'itemType'/);
  assert.match(describeFailure(400, "  a\n\n  b  "), /answered 400: a b\.$/);
  assert.match(describeFailure(400, ""), /with no explanation/);
  assert.ok(describeFailure(400, "x".repeat(5000)).length < 400, "a body is not a place to hide a wall of text");
  // The two that name their own fix keep their own words.
  assert.match(describeFailure(403, "nope"), /Allow other applications/);
});

/* --------------------------------------------------------- collections --- */

const COLS = [
  { key: "AAAAAAAA", data: { key: "AAAAAAAA", name: "Projects", parentCollection: false } },
  { key: "BBBBBBBB", data: { key: "BBBBBBBB", name: "2026", parentCollection: "AAAAAAAA" } },
  { key: "CCCCCCCC", data: { key: "CCCCCCCC", name: "Memory", parentCollection: "BBBBBBBB" } },
  { key: "DDDDDDDD", data: { key: "DDDDDDDD", name: "Archive", parentCollection: false } },
];

test("a collection needs both a key and a name to be offered", () => {
  const parsed = parseCollections([
    ...COLS,
    { data: { key: "EEEEEEEE", name: "" } },
    { data: { name: "no key" } },
    { data: { key: "lowercase", name: "wrong shape" } },
    "nonsense",
  ]);
  assert.deepEqual(parsed.map((c) => c.key), ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD"]);
  assert.equal(parsed[1]!.parent, "AAAAAAAA");
  // `false` is Zotero's encoding of "top level", not a parent to carry around.
  assert.equal(parsed[0]!.parent, undefined);
});

test("the tree reads the way the collection list reads in Zotero", () => {
  const tree = collectionTree(parseCollections(COLS));
  assert.deepEqual(
    tree.map((c) => `${"  ".repeat(c.depth)}${c.name}`),
    ["Archive", "Projects", "  2026", "    Memory"],
  );
  assert.equal(tree[3]!.path, "Projects › 2026 › Memory");
  // The count is what tells a user that choosing "Projects" reaches further.
  assert.equal(tree[1]!.children, 2);
  assert.equal(tree[0]!.children, 0);
});

test("a collection whose parent is not in the library is still shown", () => {
  // A dangling parent key would otherwise drop the collection from the tree
  // entirely -- present in Zotero, absent from the picker, and unchoosable.
  const tree = collectionTree(parseCollections([
    { data: { key: "FFFFFFFF", name: "Orphan", parentCollection: "ZZZZZZZZ" } },
  ]));
  assert.deepEqual(tree.map((c) => [c.name, c.depth]), [["Orphan", 0]]);
});

test("a cycle in the parent chain comes out flat, not as a hang", () => {
  /* This is another program's database and the loop would be a bug there, but
     "Karen freezes when you click Library" is not an acceptable way to find out. */
  const cyclic = parseCollections([
    { data: { key: "AAAAAAAA", name: "A", parentCollection: "BBBBBBBB" } },
    { data: { key: "BBBBBBBB", name: "B", parentCollection: "AAAAAAAA" } },
  ]);
  /* Both have a parent, so neither is a root and the walk reaches neither.
     They are still real collections, so they are offered at the top level. */
  assert.deepEqual(collectionTree(cyclic).map((c) => [c.name, c.depth]), [["A", 0], ["B", 0]]);
  assert.deepEqual(descendantKeys(cyclic, "AAAAAAAA"), ["AAAAAAAA", "BBBBBBBB"]);
});

test("choosing a collection also searches what is filed below it", () => {
  /* Zotero's own API is not recursive: asking for "Projects" returns nothing
     that lives in "Projects › 2026". Someone who files one level down would be
     told their collection is empty, which is false and unfalsifiable from the
     answer. */
  const cols = parseCollections(COLS);
  assert.deepEqual(descendantKeys(cols, "AAAAAAAA"), ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"]);
  assert.deepEqual(descendantKeys(cols, "CCCCCCCC"), ["CCCCCCCC"]);
  assert.deepEqual(descendantKeys(cols, "DDDDDDDD"), ["DDDDDDDD"]);
});

test("the fan-out is capped rather than unbounded", () => {
  const wide = parseCollections([
    { data: { key: "AAAAAAAA", name: "Root", parentCollection: false } },
    ...Array.from({ length: 60 }, (_, i) => ({
      data: { key: `K${String(i).padStart(7, "0")}`, name: `c${i}`, parentCollection: "AAAAAAAA" },
    })),
  ]);
  assert.equal(descendantKeys(wide, "AAAAAAAA").length, MAX_FANOUT);
});

test("a scoped search asks the collection's own items endpoint", () => {
  assert.match(
    searchPath({ query: "memory", collection: "AAAAAAAA" }),
    /^\/api\/users\/0\/collections\/AAAAAAAA\/items\?/,
  );
});

test("a key that is not a key searches the whole library, not a made-up path", () => {
  /* The one value that reaches the URL PATH, where URLSearchParams cannot
     escape it. Widening is the safe direction: a wider answer cannot be
     mistaken for a narrower one, and the header says which was searched. */
  for (const bad of ["../../secrets", "AAAA AAAA", "", "aaaaaaaa", "AAAAAAAAA"]) {
    assert.match(searchPath({ query: "x", collection: bad }), /^\/api\/users\/0\/items\?/);
  }
});

test("an empty scoped result says the rest of the library was not searched", () => {
  // Otherwise "nothing found" reads as "you do not have this paper", which is a
  // different and much stronger claim than the search actually made.
  const text = formatItems([], "attention", "Projects (and 2 collection(s) below it)");
  assert.match(text, /Nothing in the Zotero collection "Projects/);
  assert.match(text, /the rest of their library was not looked at/);
});

test("a scoped result names its scope in the header", () => {
  const [item] = parseItems([ITEM]);
  const text = formatItems([item!], "memory", "Archive");
  assert.match(text, /1 item\(s\) from the Zotero collection "Archive"/);
  assert.match(text, /No other collection was searched/);
  // And the unscoped header is unchanged, so nothing implies a scope there.
  assert.match(formatItems([item!], "memory"), /from the user's own Zotero library/);
});

/* ----------------------------------------------------- the tool's scope --- */

/**
 * The scope is a setting, so the MODEL must not be able to widen it, and the
 * collection is somebody else's database, so it must not be assumed to still be
 * there. Both are checked in the tool rather than the client, because that is
 * where the stored choice and the live library meet.
 */

async function runTool(
  cfg: Record<string, unknown>,
  cols: { key: string; name: string; parent?: string }[],
  params: Record<string, unknown> = { query: "memory" },
): Promise<{ text: string; asked: string[] | undefined; error?: string }> {
  const file = join(mkdtempSync(join(tmpdir(), "karen-lib-")), "research.json");
  writeFileSync(file, JSON.stringify({ v: 2, category: "science", ...cfg }));
  const previous = process.env["KAREN_RESEARCH_CONFIG"];
  process.env["KAREN_RESEARCH_CONFIG"] = file;

  let asked: string[] | undefined;
  setLibraryHost({
    collections: () => Promise.resolve(cols),
    search: (opts) => {
      asked = opts.collections;
      return Promise.resolve(parseItems([ITEM]));
    },
  });
  try {
    const res = await searchLibraryTool.handler(params, {} as never);
    return { text: String((res as { content: string }).content), asked };
  } catch (err) {
    return { text: "", asked, error: err instanceof Error ? err.message : String(err) };
  } finally {
    setLibraryHost(undefined);
    if (previous === undefined) delete process.env["KAREN_RESEARCH_CONFIG"];
    else process.env["KAREN_RESEARCH_CONFIG"] = previous;
  }
}

const TREE = [
  { key: "AAAAAAAA", name: "Projects" },
  { key: "BBBBBBBB", name: "2026", parent: "AAAAAAAA" },
  { key: "DDDDDDDD", name: "Archive" },
];

test("with no collection chosen the whole library is searched", async () => {
  const { asked, text } = await runTool({ mode: "library" }, TREE);
  assert.equal(asked, undefined);
  assert.match(text, /from the user's own Zotero library/);
});

test("the chosen collection is searched with everything below it", async () => {
  const { asked, text } = await runTool(
    { mode: "library", collection: "AAAAAAAA", collectionName: "Projects" }, TREE,
  );
  assert.deepEqual(asked, ["AAAAAAAA", "BBBBBBBB"]);
  assert.match(text, /Projects \(and 1 collection\(s\) below it\)/);
});

test("the model cannot widen the scope the user chose", async () => {
  /* Same rule as effectiveCategory: a setting the model can quietly override is
     not a setting. There is no parameter for this, and adding one to the call
     must not create one. */
  const { asked } = await runTool(
    { mode: "library", collection: "DDDDDDDD", collectionName: "Archive" }, TREE,
    { query: "memory", collection: "", collections: [], scope: "all" },
  );
  assert.deepEqual(asked, ["DDDDDDDD"]);
});

test("the scope's NAME comes from Zotero, not from the stored setting", async () => {
  // Zotero is another program and the collection can be renamed between the
  // choice and the search. Reporting the stale name would misstate what was
  // searched, which is the one thing a library search is for.
  const { text } = await runTool(
    { mode: "library", collection: "DDDDDDDD", collectionName: "Old name" }, TREE,
  );
  assert.match(text, /"Archive"/);
  assert.doesNotMatch(text, /Old name/);
});

test("a collection Zotero no longer has is an error, not a silent whole-library search", async () => {
  /* Falling back to everything would answer a question nobody asked, and the
     user would have no way to notice their scope had quietly gone. */
  const { error, asked } = await runTool(
    { mode: "library", collection: "CCCCCCCC", collectionName: "Deleted" }, TREE,
  );
  assert.equal(asked, undefined, "nothing should have been searched");
  assert.match(String(error), /no longer in the library/);
});

/* --------------------------------------------------------- citability --- */

test("a library result is read back by the same harvester as a web result", () => {
  /* The whole point of item 1. Library results printed "1. Title", which the
     app's citation machinery cannot see -- so a perfectly good Zotero record
     with a DOI could never become a [1] the reader can click. This asserts
     against the renderer's own harvester, not a copy of its regex. */
  const items = parseItems([ITEM]);
  const text = formatItems(items, "memory", "", [4]);
  const found = harvestSources(text);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.n, 4, "the ledger's number, not the position in the list");
  assert.equal(found[0]!.url, "https://doi.org/10.1177/1745691616635612");
  assert.match(found[0]!.title, /Working memory training/);
});

test("an item with no DOI and no URL gets no number rather than a dead marker", () => {
  /* A marker that resolves to nothing is the one thing this app must never
     render, so the item is still listed and still discussable -- by author and
     year -- and the reply says so plainly instead of leaving it to be guessed. */
  const bare = parseItems([
    { ...ITEM, data: { ...ITEM.data, key: "NOLINK01", DOI: "", url: "", title: "A book with no identifiers" } },
  ]);
  const text = formatItems(bare, "memory", "", []);
  assert.deepEqual(harvestSources(text), []);
  assert.doesNotMatch(text, /\[\d+\]/);
  assert.match(text, /no DOI or URL stored in Zotero/);
  assert.match(text, /by author and year/);
});

test("a mixed page numbers only the items a marker could resolve", () => {
  const items = parseItems([
    { ...ITEM, data: { ...ITEM.data, key: "HASDOI01" } },
    { ...ITEM, data: { ...ITEM.data, key: "NOLINK01", DOI: "", url: "", title: "Untraceable" } },
    { ...ITEM, data: { ...ITEM.data, key: "HASURL01", DOI: "", url: "https://example.org/p", title: "By URL" } },
  ]);
  const text = formatItems(items, "memory", "", [7, 8]);
  assert.deepEqual(harvestSources(text).map((s) => [s.n, s.url]), [
    [7, "https://doi.org/10.1177/1745691616635612"],
    [8, "https://example.org/p"],
  ]);
  assert.match(text, /1 of these has no DOI or URL/);
});

test("a DOI already written as a URL is not doubled up", () => {
  const [item] = parseItems([
    { ...ITEM, data: { ...ITEM.data, DOI: "https://doi.org/10.1234/abc" } },
  ]);
  assert.equal(linkFor(item!), "https://doi.org/10.1234/abc");
});

test("the collection scope applies only at the rung that shows the picker", async () => {
  /* The picker sits under Library alone -- Quick and Deep are questions about
     the literature, and a Zotero collection control beneath them reads as
     though the two were one feature. Once the control is gone the setting has
     to go with it, or a scope keeps narrowing results at a rung with nothing
     on screen to see or change it. */
  const { collectionScope } = await import("../src/core/agent/tools/library.ts");
  const cfg = { category: "science", collection: "AAAAAAAA", collectionName: "Projects" };
  assert.equal(collectionScope({ ...cfg, mode: "library" }), "AAAAAAAA");
  for (const mode of ["web", "deep"] as const) {
    assert.equal(collectionScope({ ...cfg, mode }), undefined, mode);
  }
});
