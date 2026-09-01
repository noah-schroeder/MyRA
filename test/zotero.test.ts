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

import {
  describeFailure, formatCreators, formatItems, parseItems, searchPath, yearOf,
  ZOTERO_PORT,
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
  assert.match(describeFailure(undefined), /does not appear to be running/);
  assert.match(describeFailure(undefined), new RegExp(String(ZOTERO_PORT)));
  assert.match(describeFailure(403), /Allow other applications/);
  assert.match(describeFailure(404), /Zotero 7 or newer/);
  assert.match(describeFailure(500), /answered 500/);
});
