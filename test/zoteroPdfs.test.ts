/**
 * Reading the PDF behind a Zotero item.
 *
 * What is pinned: a storage attachment is read only through the jail, so a
 * path Zotero's database claims cannot walk out of `storage/`; a linked file
 * is read only where the database itself lists it, and only if it ends at a
 * regular `.pdf`; a web link is never read; a trashed attachment is gone; and
 * when pdftotext cannot help, Zotero's own index text is used and said to have
 * no page numbers.
 */

import { strict as assert } from "node:assert";
import { after, afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLibrary, type FakeItem } from "./zoteroFixture.ts";
import { buildPdf } from "./pdfFixture.ts";
import { forgetZoteroSnapshot } from "../src/main/runtime/zoteroSqlite.ts";
import { indexZoteroPdf, locatePdfs, readZoteroPdf, realPdf } from "../src/main/runtime/zoteroFulltext.ts";
import { locate, primaryAttachment, type AttachmentRow } from "../src/core/library/zoteroFulltext.ts";
import { baseAttachmentFromPrefs } from "../src/core/library/zoteroProfile.ts";

const built: string[] = [];
function use(items: FakeItem[]): string {
  const dir = buildLibrary(items);
  built.push(dir);
  process.env["MYRA_ZOTERO_DIR"] = dir;
  forgetZoteroSnapshot();
  return dir;
}
afterEach(() => forgetZoteroSnapshot());
after(() => {
  delete process.env["MYRA_ZOTERO_DIR"];
  for (const dir of built) rmSync(dir, { recursive: true, force: true });
});

const row = (over: Partial<AttachmentRow>): AttachmentRow => ({
  parentKey: "PARENT01", key: "ATTACH01", linkMode: 0, contentType: "application/pdf", path: "storage:paper.pdf", ...over,
});

describe("where the database says the file is", () => {
  it("storage files are relative to their own attachment folder", () => {
    assert.deepEqual(locate(row({}), undefined), {
      kind: "storage", key: "ATTACH01", parentKey: "PARENT01", relative: "ATTACH01/paper.pdf",
    });
  });

  it("linked files are absolute, or relative to Zotero's base folder when it names one", () => {
    assert.equal((locate(row({ linkMode: 2, path: "/home/me/Papers/a.pdf" }), undefined) as { absolute: string }).absolute, "/home/me/Papers/a.pdf");
    assert.equal(
      (locate(row({ linkMode: 2, path: "attachments:2020/Smith.pdf" }), "/home/me/Zotero Attachments") as { absolute: string }).absolute,
      "/home/me/Zotero Attachments/2020/Smith.pdf",
    );
    assert.equal(locate(row({ linkMode: 2, path: "attachments:x.pdf" }), undefined).kind, "unreadable");
    assert.equal(locate(row({ linkMode: 2, path: "relative/x.pdf" }), undefined).kind, "unreadable");
  });

  it("never reads a web link, a non-PDF, or a row whose keys are not keys", () => {
    assert.equal(locate(row({ linkMode: 3, path: "https://example.com" }), undefined).kind, "unreadable");
    assert.equal(locate(row({ contentType: "text/html", path: "storage:page.html" }), undefined).kind, "unreadable");
    assert.equal(locate(row({ key: "../../x" }), undefined).kind, "unreadable");
  });

  it("prefers the file in Zotero's storage over a linked one", () => {
    const linked = locate(row({ key: "LINKED01", linkMode: 2, path: "/x.pdf" }), undefined);
    const stored = locate(row({ key: "STORED01" }), undefined);
    assert.equal(primaryAttachment([linked, stored])?.key, "STORED01");
  });

  it("reads the base folder from prefs.js", () => {
    const prefs = 'user_pref("extensions.zotero.baseAttachmentPath", "/home/me/Zotero Attachments");';
    assert.equal(baseAttachmentFromPrefs(prefs), "/home/me/Zotero Attachments");
    assert.equal(baseAttachmentFromPrefs("nothing here"), undefined);
  });
});

describe("the file itself", () => {
  const paper = (attachments: NonNullable<FakeItem["attachments"]>): FakeItem => ({
    key: "PAPER001", fields: { title: "A paper" }, attachments,
  });

  it("finds a stored PDF through the snapshot and reads it by page", async () => {
    const dir = use([paper([{ key: "ATTACH01", linkMode: 0, path: "storage:paper.pdf" }])]);
    mkdirSync(join(dir, "storage", "ATTACH01"), { recursive: true });
    writeFileSync(join(dir, "storage", "ATTACH01", "paper.pdf"), buildPdf([["Page one."], ["2. Methods", "Page two."]]));
    const loc = (await locatePdfs(["PAPER001"])).get("PAPER001")!;
    assert.equal(loc.kind, "storage");
    const got = await readZoteroPdf(loc);
    assert.ok("text" in got);
    assert.equal(got.text.pages.length, 2);
    assert.equal(got.text.paged, true);
    // Read once, it is cached and the index uses the pages from then on.
    const indexed = await indexZoteroPdf(loc);
    assert.ok("text" in indexed && indexed.text.paged);
  });

  it("a trashed attachment is gone", async () => {
    use([paper([{ key: "ATTACH01", linkMode: 0, path: "storage:paper.pdf", trashed: true }])]);
    assert.equal((await locatePdfs(["PAPER001"])).size, 0);
  });

  it("a storage path that climbs out of storage is refused by the jail", async () => {
    const dir = use([paper([{ key: "ATTACH01", linkMode: 0, path: "storage:../../../etc/passwd.pdf" }])]);
    const loc = (await locatePdfs(["PAPER001"])).get("PAPER001")!;
    const got = await realPdf(loc);
    assert.ok("error" in got, `refused, not read from ${dir}`);
  });

  it("a symlink inside storage that points outside it is refused", async () => {
    const dir = use([paper([{ key: "ATTACH01", linkMode: 0, path: "storage:paper.pdf" }])]);
    const outside = mkdtempSync(join(tmpdir(), "myra-outside-"));
    built.push(outside);
    writeFileSync(join(outside, "secret.pdf"), buildPdf([["secret"]]));
    mkdirSync(join(dir, "storage", "ATTACH01"), { recursive: true });
    symlinkSync(join(outside, "secret.pdf"), join(dir, "storage", "ATTACH01", "paper.pdf"));
    const got = await realPdf((await locatePdfs(["PAPER001"])).get("PAPER001")!);
    assert.ok("error" in got);
  });

  it("a linked file is read where Zotero lists it -- and only if it is a regular PDF", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "myra-linked-"));
    built.push(elsewhere);
    writeFileSync(join(elsewhere, "linked.pdf"), buildPdf([["Linked page."]]));
    writeFileSync(join(elsewhere, "notes.txt"), "not a pdf");
    symlinkSync(join(elsewhere, "notes.txt"), join(elsewhere, "disguised.pdf.lnk"));
    use([
      paper([{ key: "ATTACH01", linkMode: 2, path: join(elsewhere, "linked.pdf") }]),
      { key: "PAPER002", fields: { title: "B" }, attachments: [{ key: "ATTACH02", linkMode: 2, path: join(elsewhere, "disguised.pdf.lnk") }] },
    ]);
    const located = await locatePdfs(["PAPER001", "PAPER002"]);
    const good = await readZoteroPdf(located.get("PAPER001")!);
    assert.ok("text" in good && /Linked page/.test(good.text.pages[0]!));
    const bad = await realPdf(located.get("PAPER002")!);
    assert.ok("error" in bad, "a link that does not end at a .pdf is not opened");
  });

  it("falls back to Zotero's index text, and says it has no pages", async () => {
    const dir = use([paper([{ key: "ATTACH01", linkMode: 0, path: "storage:missing.pdf" }])]);
    mkdirSync(join(dir, "storage", "ATTACH01"), { recursive: true });
    writeFileSync(join(dir, "storage", "ATTACH01", ".zotero-ft-cache"), "Text Zotero extracted earlier.");
    const loc = (await locatePdfs(["PAPER001"])).get("PAPER001")!;
    const got = await readZoteroPdf(loc);
    assert.ok("text" in got);
    assert.equal(got.text.paged, false);
    assert.match(got.text.pages[0]!, /extracted earlier/);
    const indexed = await indexZoteroPdf(loc);
    assert.ok("text" in indexed && indexed.stamp.startsWith("index:"));
  });
});
