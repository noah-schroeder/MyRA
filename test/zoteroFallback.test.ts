/**
 * The rule about which way in gets used.
 *
 * The interesting case is the one the user hit: Zotero running, its own
 * settings pane saying the API is available, and nothing on the machine able to
 * reach the port because the Flatpak sandbox holds it. From outside, that is
 * indistinguishable from Zotero being closed -- so the fallback has to trigger
 * on "nothing answered", and the reply has to say which route it took.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { connect } from "node:net";
import { rmSync } from "node:fs";

import { buildLibrary } from "./zoteroFixture.ts";
import { forgetZoteroSnapshot } from "../src/main/runtime/zoteroSqlite.ts";
import { libraryRoute, librarySearch, libraryCollections } from "../src/main/runtime/zoteroLibrary.ts";
import { ZOTERO_HOST, ZOTERO_PORT } from "../src/core/library/zotero.ts";

/** Is a real Zotero listening here? If so these assertions do not apply. */
function somethingIsListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: ZOTERO_HOST, port: ZOTERO_PORT });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

let dir = "";
let live = false;

before(async () => {
  live = await somethingIsListening();
  dir = buildLibrary([
    {
      key: "AAAA1111",
      fields: { title: "Working memory and the testing effect", DOI: "10.1234/wm" },
      creators: ["Chi, Michelene"],
    },
  ]);
  process.env["KAREN_ZOTERO_DIR"] = dir;
  forgetZoteroSnapshot();
});

after(() => {
  delete process.env["KAREN_ZOTERO_DIR"];
  forgetZoteroSnapshot();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("when the local API cannot be reached", () => {
  it("answers from the database file instead of failing", async (t) => {
    if (live) {
      t.skip(`something is listening on ${ZOTERO_HOST}:${ZOTERO_PORT}; the API route wins`);
      return;
    }
    const items = await librarySearch({ query: "memory" });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Working memory and the testing effect");
    assert.equal(libraryRoute(), "database");
  });

  it("lists collections from the same place", async (t) => {
    if (live) {
      t.skip("a real Zotero is answering");
      return;
    }
    assert.deepEqual(await libraryCollections(), []);
    assert.equal(libraryRoute(), "database");
  });
});

/* ------------------------------------------------- what the reply says --- */

import { searchLibraryTool, setLibraryHost } from "../src/core/agent/tools/library.ts";
import { DATABASE_ROUTE_NOTE } from "../src/core/library/zoteroDb.ts";
import { parseItems } from "../src/core/library/zotero.ts";

const ONE_ITEM = [
  { key: "AAAA1111", data: { key: "AAAA1111", itemType: "journalArticle", title: "A paper", DOI: "10.1/x" } },
];

async function toolTextVia(route: "api" | "database"): Promise<string> {
  setLibraryHost({
    collections: () => Promise.resolve([]),
    search: () => Promise.resolve(parseItems(ONE_ITEM)),
    route: () => route,
  });
  try {
    const res = await searchLibraryTool.handler({ query: "memory" }, {} as never);
    return String((res as { content: string }).content);
  } finally {
    setLibraryHost(undefined);
  }
}

describe("saying which route answered", () => {
  it("warns that PDF text was not searched when the file was read", async () => {
    const text = await toolTextVia("database");
    assert.ok(text.includes(DATABASE_ROUTE_NOTE), "the model must be told what was not searched");
    assert.ok(text.includes("A paper"), "and still get the results");
  });

  it("says nothing extra when the API answered, because nothing was missed", async () => {
    const text = await toolTextVia("api");
    assert.ok(!text.includes("database file"));
  });
});
