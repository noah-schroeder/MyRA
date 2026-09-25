/**
 * Papers uploaded into a project, on disk.
 *
 * `source.json` is the done-marker and is written last, so a listing never
 * shows a paper whose text is not there; a paper whose text could not be read
 * is still kept, and marked; files are private; and an id that comes back
 * from the window or a model is held to the one shape before it reaches a
 * path, because the delete is `rm -rf`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSourceId, doiFrom, editSource, parseSource, sourceExtension, sourceId, titleGuess,
} from "../src/core/sources/source.ts";
import {
  addSource, listSources, readSource, readSourceText, removeSource, SOURCE_JSON, TEXT_JSON, type Extractor,
} from "../src/core/sources/store.ts";
import { extractPages as extractPagesForTest } from "../src/main/extractPages.ts";
import { buildPdf } from "./pdfFixture.ts";

const root = (): string => mkdtempSync(join(tmpdir(), "myra-sources-"));
const pagesOf = (pages: string[]): Extractor => async () => ({ pages, paged: true });
const bytes = new TextEncoder().encode("%PDF-1.4 not really");

describe("keeping a paper", () => {
  it("writes the file and its text, then the record, all private", async () => {
    const dir = root();
    const source = await addSource(
      dir,
      "venkatesh2003.pdf",
      bytes,
      pagesOf(["Journal of Things\nUser acceptance of information technology\ndoi:10.2307/30036540."]),
    );
    assert.equal(source.title, "User acceptance of information technology");
    assert.equal(source.doi, "10.2307/30036540");
    assert.equal(source.text, "ok");
    assert.equal(source.pages, 1);
    const files = (await readdir(join(dir, source.id))).sort();
    assert.deepEqual(files, [SOURCE_JSON, "original.pdf", TEXT_JSON].sort());
    for (const f of files) assert.equal(statSync(join(dir, source.id, f)).mode & 0o077, 0, `${f} is private`);
    assert.equal(statSync(join(dir, source.id)).mode & 0o077, 0, "its directory is private");
    assert.match((await readSourceText(dir, source.id))!.pages[0]!, /User acceptance/);
  });

  it("keeps a paper whose text could not be read, and marks it", async () => {
    const dir = root();
    const scanned = await addSource(dir, "scan.pdf", bytes, async () => ({ error: "probably scanned images", scanned: true }));
    assert.equal(scanned.text, "scanned");
    assert.match(scanned.textError ?? "", /scanned/);
    assert.equal(await readSourceText(dir, scanned.id), undefined);
    const failed = await addSource(dir, "broken.pdf", bytes, async () => {
      throw new Error("pdftotext exploded");
    });
    assert.equal(failed.text, "failed");
    assert.equal((await listSources(dir)).length, 2);
  });

  it("refuses what it cannot read, and what is empty", async () => {
    const dir = root();
    await assert.rejects(addSource(dir, "movie.mp4", bytes, pagesOf(["x"])), /not a file MyRA can read/);
    await assert.rejects(addSource(dir, "empty.pdf", new Uint8Array(0), pagesOf(["x"])), /empty/);
  });

  it("does not list an add that was interrupted before its record", async () => {
    const dir = root();
    mkdirSync(join(dir, "20260101-0000-half-done"), { recursive: true });
    writeFileSync(join(dir, "20260101-0000-half-done", "original.pdf"), "x");
    await addSource(dir, "done.pdf", bytes, pagesOf(["A finished paper about things"]));
    assert.deepEqual((await listSources(dir)).map((s) => s.originalName), ["done.pdf"]);
  });

  it("deletes the whole directory, and refuses an id that is not one", async () => {
    const dir = root();
    const source = await addSource(dir, "a.pdf", bytes, pagesOf(["A paper about the thing"]));
    await removeSource(dir, source.id);
    assert.equal(await readSource(dir, source.id), undefined);
    for (const bad of ["..", "../../etc", "a/b", "", "x".repeat(200)]) {
      await assert.rejects(removeSource(dir, bad), /no paper named/, bad);
    }
  });

  it("reads a real PDF by page, through the extractor main uses", async () => {
    const dir = root();
    const pdf = buildPdf([["A study of nurse adoption"], ["2. Methods", "We surveyed nurses."]]);
    const source = await addSource(dir, "real.pdf", pdf, extractPagesForTest);
    assert.equal(source.pages, 2);
    assert.equal(source.paged, true);
    const text = await readSourceText(dir, source.id);
    assert.equal(text?.sections[0]?.name, "2. Methods");
    assert.equal(text?.sections[0]?.page, 2);
  });
});

describe("the record", () => {
  it("guesses a title past running headers, and falls back to the file name", () => {
    assert.equal(titleGuess(["Journal of Nursing Vol. 12\nhttps://doi.org/x\nWhy nurses adopt records late"], "f.pdf"), "Why nurses adopt records late");
    assert.equal(titleGuess([""], "Smith 2020 adoption.pdf"), "Smith 2020 adoption");
  });

  it("reads a DOI off the first two pages only, without trailing punctuation", () => {
    assert.equal(doiFrom(["see (doi: 10.1000/xyz123).", "x"]), "10.1000/xyz123");
    assert.equal(doiFrom(["none", "none", "10.1000/late"]), "");
  });

  it("is rebuilt forgivingly, and never trusts a file name that could leave its folder", () => {
    assert.equal(parseSource({ file: "../x.pdf" }, "id"), undefined);
    assert.equal(parseSource({ file: ".hidden" }, "id"), undefined);
    const s = parseSource({ file: "original.pdf", text: "weird", pages: -3 }, "id")!;
    assert.equal(s.text, "failed");
    assert.equal(s.pages, 0);
    assert.equal(s.title, "Untitled paper");
  });

  it("edits only what a person may correct, and takes a DOI given as a link", () => {
    const s = parseSource({ file: "original.pdf", title: "Old" }, "id")!;
    const e = editSource(s, { title: "  ", authors: " Smith, Jones ", doi: "https://doi.org/10.1/abc" });
    assert.equal(e.title, "Old", "a blank title keeps the old one");
    assert.equal(e.authors, "Smith, Jones");
    assert.equal(e.doi, "10.1/abc");
    assert.equal(e.file, "original.pdf");
  });

  it("ids are legible and asserted", () => {
    assert.match(sourceId("Why Nurses Adopt", new Date(2026, 8, 24, 9, 5), "ab12"), /^20260924-0905-why-nurses-adopt-ab12$/);
    assert.throws(() => assertSourceId("../x"));
    assert.equal(sourceExtension("A.PDF"), "pdf");
    assert.equal(sourceExtension("a.exe"), undefined);
  });
});
