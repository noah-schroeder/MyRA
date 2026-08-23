import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertArgs, extensionOf, FORMATS, isReadable, outputName, resolveFormat, safeRelativePath, slugName,
} from "../src/core/documents/formats.ts";

test("formats are named the several ways a model will name them", () => {
  assert.equal(resolveFormat("docx")?.ext, "docx");
  assert.equal(resolveFormat("Word")?.ext, "docx");
  assert.equal(resolveFormat(".DOCX")?.ext, "docx");
  assert.equal(resolveFormat("markdown")?.ext, "md");
  assert.equal(resolveFormat("text")?.ext, "txt");
  assert.equal(resolveFormat("pages"), undefined);
});

test("docx is written through an explicit filter", () => {
  // Without it LibreOffice reaches for the Word 97 binary writer, and the
  // result is a .docx that some readers refuse to open.
  assert.equal(FORMATS["docx"]!.convertTo, "docx:MS Word 2007 XML");
});

test("a conversion keeps the stem and changes the extension", () => {
  assert.equal(outputName("memo.md", FORMATS["docx"]!), "memo.docx");
  assert.equal(outputName("/a/b/notes.docx", FORMATS["pdf"]!), "notes.pdf");
  assert.equal(outputName("no-extension", FORMATS["odt"]!), "no-extension.odt");
  // A dot inside the stem is not an extension boundary.
  assert.equal(outputName("v1.2-draft.md", FORMATS["pdf"]!), "v1.2-draft.pdf");
});

test("conversions never run in place", () => {
  // The finding this guards: LibreOffice writes beside its input under the same
  // stem, so converting report.docx to Markdown destroys report.md next to it.
  // Observed against a real install, not theorised.
  const args = convertArgs({
    source: "/w/report.docx",
    format: FORMATS["md"]!,
    outDir: "/w/out",
    profileDir: "/tmp/profile",
  });
  assert.ok(args.includes("--outdir"), "every conversion must be given an output directory");
  assert.equal(args[args.indexOf("--outdir") + 1], "/w/out");
  // And the profile lock: a conversion started while the user has LibreOffice
  // open fails outright without its own profile.
  assert.ok(args.some((a) => a.startsWith("-env:UserInstallation=file:///tmp/profile")));
  assert.ok(args.includes("--headless"));
  assert.equal(args[args.length - 1], "/w/report.docx", "the source is the last argument");
});

test("a path that leaves the documents folder is refused", () => {
  assert.equal(safeRelativePath("memo.docx"), "memo.docx");
  assert.equal(safeRelativePath("drafts/memo.docx"), "drafts/memo.docx");
  assert.equal(safeRelativePath("/etc/passwd"), "etc/passwd", "a leading slash is stripped, not honoured");
  assert.equal(safeRelativePath("../../.ssh/id_rsa"), undefined);
  assert.equal(safeRelativePath("drafts/../../out.docx"), undefined);
  // Even when the climb would come back inside: nobody types that on purpose.
  assert.equal(safeRelativePath("drafts/../memo.docx"), undefined);
  assert.equal(safeRelativePath(""), undefined);
  assert.equal(safeRelativePath("   "), undefined);
  assert.equal(safeRelativePath("a\0b"), undefined);
});

test("a title becomes a filename that will not surprise anyone", () => {
  assert.equal(slugName("Q3 Planning / Roadmap", "docx"), "q3-planning-roadmap.docx");
  assert.equal(slugName("Café résumé", "pdf"), "cafe-resume.pdf");
  assert.equal(slugName("", "md"), "document.md");
  assert.equal(slugName("///", "odt"), "document.odt");
  assert.ok(!slugName("a".repeat(200), "pdf").startsWith("-"));
});

test("what can be read back as text", () => {
  assert.ok(isReadable("a.docx"));
  assert.ok(isReadable("a.pdf"), "PDFs are read with pdftotext, not LibreOffice");
  assert.ok(isReadable("a.md"));
  assert.ok(!isReadable("a.png"));
  assert.ok(!isReadable("noextension"));
  assert.equal(extensionOf("/a/b.c/file.TXT"), "txt");
  assert.equal(extensionOf(".hidden"), "", "a dotfile has no extension");
});

test("scratch space is inside the workspace, never /tmp", async () => {
  // Not a style preference. LibreOffice here is a snap and snaps get a PRIVATE
  // /tmp: a conversion given --outdir /tmp/... reports success and writes the
  // file into a namespace this process cannot see, so the output looks like it
  // vanished. Found by doing exactly that.
  const { scratchRoot, workspaceRoot, documentsDir } = await import("../src/core/documents/office.ts");
  assert.ok(scratchRoot().startsWith(workspaceRoot() + "/"), `scratch was ${scratchRoot()}`);
  assert.ok(!scratchRoot().startsWith("/tmp"));
  // And no hidden directories: snap confinement refuses those under $HOME too.
  assert.ok(!scratchRoot().split("/").some((s) => s.startsWith(".")), scratchRoot());
  assert.ok(!documentsDir().split("/").some((s) => s.startsWith(".")), documentsDir());
});

test("the documents folder is the only place these tools reach", async () => {
  const { inWorkspace, documentsDir, DocsError } = await import("../src/core/documents/office.ts");
  assert.equal(inWorkspace("memo.docx"), documentsDir() + "/memo.docx");
  // safeRelativePath refuses these first; inWorkspace is the second lock.
  assert.throws(() => inWorkspace("../../.ssh/id_rsa"), DocsError);
  assert.throws(() => inWorkspace("/etc/passwd"), DocsError);
});
