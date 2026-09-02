/**
 * Reading a Zotero library from the file, which is the only way in when Zotero
 * is sandboxed.
 *
 * Run against a database built to Zotero's published schema, because there is
 * no Zotero on the machine this was written on -- and because the failures that
 * matter here (the trash, group libraries, child items) are all about rows that
 * exist and must not be returned.
 */

import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLibrary, type FakeItem } from "./zoteroFixture.ts";
import { collectionsFromDb, findZoteroDataDir, forgetZoteroSnapshot, searchDb } from "../src/main/runtime/zoteroSqlite.ts";
import { chunk, dataDirCandidates, likeParam, searchTerms } from "../src/core/library/zoteroDb.ts";

const built: string[] = [];

/** Point the reader at a fresh library. */
function use(
  items: FakeItem[],
  collections: Parameters<typeof buildLibrary>[1] = [],
  opts: Parameters<typeof buildLibrary>[2] = {},
): string {
  const dir = buildLibrary(items, collections, opts);
  built.push(dir);
  process.env["KAREN_ZOTERO_DIR"] = dir;
  /* The snapshot is cached against the source file's size and mtime, and two
     fixtures built in the same millisecond can collide. Tests say so. */
  forgetZoteroSnapshot();
  return dir;
}

afterEach(() => {
  forgetZoteroSnapshot();
});

after(() => {
  delete process.env["KAREN_ZOTERO_DIR"];
  for (const dir of built) rmSync(dir, { recursive: true, force: true });
});

const PAPER: FakeItem = {
  key: "AAAA1111",
  fields: {
    title: "Working memory and the testing effect",
    abstractNote: "A study of retrieval practice in undergraduates.",
    date: "2019-03-04",
    DOI: "10.1234/wm.2019",
    publicationTitle: "Journal of Memory",
  },
  creators: ["Chi, Michelene", "Hattie, John"],
  tags: ["retrieval practice", "education"],
};

describe("finding items", () => {
  it("matches a word in the title", async () => {
    use([PAPER]);
    const items = await searchDb({ query: "testing" });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Working memory and the testing effect");
  });

  it("requires every word, the way Zotero's own quick search does", async () => {
    use([PAPER]);
    assert.equal((await searchDb({ query: "memory hattie" })).length, 1);
    // "hattie" is there; "elephant" is not, so the item is not a match.
    assert.equal((await searchDb({ query: "memory elephant" })).length, 0);
  });

  it("matches an author's surname", async () => {
    use([PAPER]);
    assert.equal((await searchDb({ query: "hattie" })).length, 1);
  });

  it("matches note text and tags in everything mode, and neither in titleCreatorYear", async () => {
    use([{ ...PAPER, note: "The moderator here is prior knowledge." }]);
    assert.equal((await searchDb({ query: "moderator" })).length, 1);
    assert.equal((await searchDb({ query: "retrieval" })).length, 1);
    assert.equal(
      (await searchDb({ query: "moderator", mode: "titleCreatorYear" })).length,
      0,
      "titleCreatorYear must not reach note text",
    );
    assert.equal((await searchDb({ query: "memory", mode: "titleCreatorYear" })).length, 1);
  });

  it("treats LIKE's own wildcards as ordinary characters", async () => {
    use([PAPER, { key: "BBBB2222", fields: { title: "100% recall" } }]);
    // Unescaped, "%" would match every item in the library.
    const items = await searchDb({ query: "100%" });
    assert.deepEqual(items.map((i) => i.key), ["BBBB2222"]);
  });
});

describe("rows that exist and must not be returned", () => {
  it("leaves trashed items in the trash", async () => {
    use([{ ...PAPER, trashed: true }]);
    assert.equal((await searchDb({ query: "memory" })).length, 0);
  });

  it("does not read a group library, because the API route does not", async () => {
    use([{ ...PAPER, key: "GGGG1111", library: 2 }]);
    assert.equal((await searchDb({ query: "memory" })).length, 0);
  });

  it("does not return attachments or notes as results of their own", async () => {
    use([
      PAPER,
      { key: "PDFF1111", type: "attachment", fields: { title: "Full text of memory paper" } },
      { key: "NOTE1111", type: "note", fields: { title: "memory jottings" } },
    ]);
    const items = await searchDb({ query: "memory" });
    assert.deepEqual(items.map((i) => i.key), ["AAAA1111"]);
  });
});

describe("the shape of a result", () => {
  it("reads authors, year, DOI and publication the way the API route does", async () => {
    use([PAPER]);
    const item = (await searchDb({ query: "testing" }))[0]!;
    assert.equal(item.creators, "Chi, Hattie");
    assert.equal(item.year, "2019");
    assert.equal(item.doi, "10.1234/wm.2019");
    assert.equal(item.publication, "Journal of Memory");
    assert.equal(item.itemType, "journalArticle");
    assert.deepEqual(item.tags, ["education", "retrieval practice"]);
  });

  it("reads a one-field name as one name rather than a surname", async () => {
    use([{ key: "CCCC3333", fields: { title: "Report on schools" }, creators: ["OECD"] }]);
    const item = (await searchDb({ query: "schools" }))[0]!;
    assert.equal(item.creators, "OECD");
  });

  it("counts the collections an item is filed in", async () => {
    use(
      [{ ...PAPER, collections: ["COL00001", "COL00002"] }],
      [
        { key: "COL00001", name: "Projects" },
        { key: "COL00002", name: "2026", parent: "COL00001" },
      ],
    );
    assert.equal((await searchDb({ query: "memory" }))[0]!.collections, 2);
  });

  it("returns the newest first, as the API route asks for", async () => {
    use([
      { key: "OLD00001", fields: { title: "memory one" }, modified: "2020-01-01 00:00:00" },
      { key: "NEW00001", fields: { title: "memory two" }, modified: "2026-01-01 00:00:00" },
    ]);
    assert.deepEqual((await searchDb({ query: "memory" })).map((i) => i.key), [
      "NEW00001",
      "OLD00001",
    ]);
  });
});

describe("collections", () => {
  it("lists them with their parents, and leaves deleted ones out", async () => {
    use(
      [PAPER],
      [
        { key: "COL00001", name: "Projects" },
        { key: "COL00002", name: "2026", parent: "COL00001" },
        { key: "COL00003", name: "Old", deleted: true },
        { key: "COL00004", name: "Shared", library: 2 },
      ],
    );
    const cols = await collectionsFromDb();
    assert.deepEqual(
      cols.map((c) => [c.name, c.parent ?? ""]),
      [
        ["2026", "COL00001"],
        ["Projects", ""],
      ],
    );
  });

  it("searches inside one collection when asked, and only that one", async () => {
    use(
      [
        { key: "INSIDE01", fields: { title: "memory inside" }, collections: ["COL00001"] },
        { key: "OUTSIDE1", fields: { title: "memory outside" } },
      ],
      [{ key: "COL00001", name: "Projects" }],
    );
    const items = await searchDb({ query: "memory", collections: ["COL00001"] });
    assert.deepEqual(items.map((i) => i.key), ["INSIDE01"]);
  });
});

describe("not damaging the library", () => {
  it("writes nothing into the Zotero data directory", async () => {
    const dir = use([PAPER]);
    const before = statSync(join(dir, "zotero.sqlite"));
    const listedBefore = readdirSync(dir).sort();
    await searchDb({ query: "memory" });
    await collectionsFromDb();
    const after = statSync(join(dir, "zotero.sqlite"));
    assert.deepEqual(readdirSync(dir).sort(), listedBefore, "no new files beside the library");
    assert.equal(after.mtimeMs, before.mtimeMs, "the library file must not be written to");
    assert.equal(after.size, before.size);
  });

  it("reads what is still in the write-ahead log, which is where Zotero puts it", async () => {
    /* A real Zotero keeps its database in WAL mode the whole time it runs, so
       the most recently added papers live in the -wal file rather than in
       zotero.sqlite. A snapshot that skipped the log would answer for a
       library the user last saw some time ago -- and say nothing about it. */
    use([{ key: "WALL1111", fields: { title: "Added while Zotero was running" } }], [], { wal: true });
    const items = await searchDb({ query: "running" });
    assert.deepEqual(items.map((i) => i.key), ["WALL1111"]);
  });

  it("survives a library larger than SQLite's parameter limit in one search", async () => {
    /* Every one of these matches, so the id list handed back to the next query
       is far past the number of host parameters a statement may carry. Before
       batching, this threw rather than returning results. */
    const many: FakeItem[] = [];
    for (let i = 0; i < 950; i++) {
      many.push({ key: `K${String(i).padStart(7, "0")}`, fields: { title: `memory paper ${i}` } });
    }
    use(many);
    const items = await searchDb({ query: "memory", limit: 100 });
    assert.equal(items.length, 100);
  });
});

describe("where to look", () => {
  it("offers the sandboxed locations, which are the ones that need it", () => {
    const dirs = dataDirCandidates("/home/someone");
    assert.ok(dirs.includes("/home/someone/Zotero"));
    assert.ok(
      dirs.some((d) => d.includes(".var/app/org.zotero.Zotero")),
      "a Flatpak Zotero is exactly the case the API cannot serve",
    );
    assert.ok(dirs.some((d) => d.includes("snap")));
  });

  it("finds nothing when the named directory holds no library", () => {
    process.env["KAREN_ZOTERO_DIR"] = "/nonexistent/nowhere";
    assert.equal(findZoteroDataDir(), undefined);
  });

  it("finds a library the sandbox put somewhere unexpected", () => {
    /* Being one directory wrong is the same as having no fallback, so when the
       fixed guesses miss, the two sandbox homes are searched. */
    const home = mkdtempSync(join(tmpdir(), "karen-home-"));
    const buried = join(home, ".var", "app", "org.zotero.Zotero", "config", "Zotero");
    mkdirSync(buried, { recursive: true });
    writeFileSync(join(buried, "zotero.sqlite"), "");
    /* A directory that must not be walked into: one per attachment in a real
       library, and none of them can hold the database. */
    mkdirSync(join(buried, "storage", "AAAAAAAA"), { recursive: true });

    const realHome = process.env["HOME"];
    delete process.env["KAREN_ZOTERO_DIR"];
    process.env["HOME"] = home;
    try {
      assert.equal(findZoteroDataDir(), buried);
    } finally {
      if (realHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the pieces on their own", () => {
  it("splits a query into the words that must all match", () => {
    assert.deepEqual(searchTerms("  Working   Memory "), ["working", "memory"]);
    assert.deepEqual(searchTerms(""), []);
  });

  it("escapes wildcards but keeps the term", () => {
    assert.equal(likeParam("50%"), "%50\\%%");
    assert.equal(likeParam("a_b"), "%a\\_b%");
  });

  it("batches only when there is something to batch", () => {
    assert.deepEqual(chunk([], 2), []);
    assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
  });
});
