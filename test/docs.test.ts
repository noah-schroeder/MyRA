import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, posix, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  baseName, extensionOf, FORMATS, isReadable, looksAbsolute, looksLikeEscape, outputName, pandocArgs,
  resolveFormat,
  safeRelativePath, slugName, withExtension,
} from "../src/core/documents/formats.ts";

test("formats are named the several ways a model will name them", () => {
  assert.equal(resolveFormat("docx")?.ext, "docx");
  assert.equal(resolveFormat("Word")?.ext, "docx");
  assert.equal(resolveFormat(".DOCX")?.ext, "docx");
  assert.equal(resolveFormat("markdown")?.ext, "md");
  assert.equal(resolveFormat("text")?.ext, "txt");
  assert.equal(resolveFormat("pages"), undefined);
});

test("every writable format names a pandoc writer, and PDF deliberately does not", () => {
  for (const [name, format] of Object.entries(FORMATS)) {
    if (name === "pdf") continue;
    assert.ok(format.pandocTo, `${name} has no pandoc writer`);
  }
  // PDF has none on purpose: pandoc's PDF writers need a LaTeX toolchain, so
  // PDF goes through HTML and the app's own browser engine instead. A writer
  // here would send it down a path that fails on a machine without LaTeX.
  assert.equal(FORMATS["pdf"]!.pandocTo, undefined);
});

test("plain text is written as plain text, not as different markup", () => {
  // `markdown` here would answer a request for .txt with asterisks and hashes.
  assert.equal(FORMATS["txt"]!.pandocTo, "plain");
});

test("a conversion keeps the stem and changes the extension", () => {
  assert.equal(outputName("memo.md", FORMATS["docx"]!), "memo.docx");
  assert.equal(outputName("/a/b/notes.docx", FORMATS["pdf"]!), "notes.pdf");
  assert.equal(outputName("no-extension", FORMATS["odt"]!), "no-extension.odt");
  // A dot inside the stem is not an extension boundary.
  assert.equal(outputName("v1.2-draft.md", FORMATS["pdf"]!), "v1.2-draft.pdf");
});

test("conversions never run in place", () => {
  // The finding this guards, inherited from v1: a converter left to choose its
  // own output path writes beside the input under the same stem, so converting
  // report.docx to Markdown destroys report.md next to it. Observed against a
  // real install, not theorised. The output is always named explicitly.
  const args = pandocArgs({
    source: "/w/report.docx",
    from: "docx",
    to: "markdown",
    output: "/w/out/report.md",
  });
  assert.ok(args.includes("--output"), "every conversion must name its output file");
  assert.equal(args[args.indexOf("--output") + 1], "/w/out/report.md");
  assert.equal(args[args.length - 1], "/w/report.docx", "the source is the last argument");
});

/**
 * Names that must never survive, on any platform MyRA ships to.
 *
 * Kept as one array because the composition test below re-uses it: a row added
 * here is automatically checked against both path implementations.
 */
const ATTACKS: [string, string][] = [
  ["posix traversal", "../../.ssh/id_rsa"],
  ["traversal hidden by normalisation", "drafts/../../out.docx"],
  ["climb that returns inside", "drafts/../memo.docx"],
  ["empty", ""],
  ["whitespace", "   "],
  ["NUL", "a\0b"],
  ["win32 traversal", "..\\..\\outside\\secret.md"],
  ["win32 traversal, mixed separators", "drafts/..\\..\\outside\\secret.md"],
  ["backslash anywhere", "a\\b.md"],
  ["drive letter", "C:/Windows/System32/x.md"],
  ["drive-relative", "C:x.md"],
  ["UNC share", "\\\\server\\share\\x.md"],
  ["extended-length prefix", "\\\\?\\C:\\x.md"],
  ["NTFS alternate data stream", "notes.md:payload"],
  ["trailing space after a climb", ".. "],
  ["trailing dot", "notes.md."],
  ["trailing space on a directory segment", "drafts /notes.md"],
  ["trailing dot on a directory segment", "drafts./notes.md"],
  ["reserved device", "NUL"],
  ["reserved device with an extension", "con.txt"],
  ["reserved device, lowercased", "lpt1.md"],
  ["reserved device in a subdirectory", "drafts/aux.docx"],
];

const LEGITIMATE = ["memo.docx", "drafts/memo.docx", "a/b/c/deep.md", "Résumé 2026.odt", "notes.v2.md"];

test("a path that leaves the documents folder is refused, on every platform we ship to", () => {
  for (const name of LEGITIMATE) {
    assert.equal(safeRelativePath(name), name, `${name} is an ordinary name`);
  }
  assert.equal(safeRelativePath("/etc/passwd"), "etc/passwd", "a leading slash is stripped, not honoured");
  assert.equal(safeRelativePath("./memo.docx"), "memo.docx");
  /* Trailing whitespace on the NAME is trimmed, as it always has been -- the
     result is an ordinary name inside the jail. What must not be trimmed away
     is whitespace on an inner segment, where win32 stripping it at open time
     turns `drafts ` into a different directory; that is an ATTACKS row. */
  assert.equal(safeRelativePath("notes.md "), "notes.md");

  for (const [label, name] of ATTACKS) {
    assert.equal(safeRelativePath(name), undefined, `${label}: ${JSON.stringify(name)} was accepted`);
  }
});

test("an absolute path is absolute in all three spellings", () => {
  for (const name of ["/etc/passwd", "\\windows", "\\\\server\\share", "\\\\?\\C:\\x", "C:\\x", "c:/x"]) {
    assert.ok(looksAbsolute(name), `${JSON.stringify(name)} should read as absolute`);
  }
  for (const name of ["memo.docx", "drafts/memo.docx", "..", "a:b/c".slice(2)]) {
    assert.ok(!looksAbsolute(name), `${JSON.stringify(name)} should read as relative`);
  }
});

/**
 * The property, checked against the real win32 implementation.
 *
 * This is how a Windows jail is tested on a Linux CI: `path.win32` is always
 * available, so the actual Windows resolution algorithm runs here. Do NOT
 * mock `process.platform` -- that tests a guess about what win32 does, which
 * is exactly the mistake that let `..\..\x` through in the first place.
 *
 * What it cannot cover is realpath and symlinks, which are filesystem
 * behaviour and untestable cross-platform. That is the argument for pushing
 * every rule decidable by string down into safeRelativePath, where it is
 * checkable everywhere, and leaving resolveInJail only the part that must ask
 * the disk.
 */
test("whatever safeRelativePath accepts stays inside the jail under both path implementations", () => {
  for (const [, name] of [...ATTACKS.map((a) => a), ...LEGITIMATE.map((n) => ["ok", n] as [string, string])]) {
    const rel = safeRelativePath(name);
    if (rel === undefined) continue;
    assert.ok(
      win32.resolve("C:\\jail", rel).startsWith("C:\\jail\\"),
      `${JSON.stringify(name)} -> ${JSON.stringify(rel)} escapes under win32`,
    );
    assert.ok(
      posix.resolve("/jail", rel).startsWith("/jail/"),
      `${JSON.stringify(name)} -> ${JSON.stringify(rel)} escapes under posix`,
    );
  }
});

test("the last component of a path the OS produced, on either platform", () => {
  assert.equal(baseName("/a/b/c.md"), "c.md");
  assert.equal(baseName("C:\\a\\b\\c.md"), "c.md");
  assert.equal(baseName("c.md"), "c.md");
  // A conversion names its own output; getting this wrong on Windows meant
  // outputName treated the whole path as the stem.
  assert.equal(outputName("C:\\jail\\report.docx", FORMATS["md"]!), "report.md");
  assert.equal(extensionOf("C:\\a\\b.TXT"), "txt");
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
  // Not a style preference, and it outlived the engine that caused it. v1 ran
  // LibreOffice as a snap, and snaps get a PRIVATE /tmp: a conversion given an
  // output path under /tmp reported success and wrote into a namespace this
  // process could not see, so the file looked as though it had vanished. Any
  // sandboxed packaging -- snap, flatpak, the Mac App Store -- can do the same,
  // so the workspace stays the scratch root.
  const { scratchRoot, workspaceRoot, documentsDir } = await import("../src/core/documents/office.ts");
  assert.ok(scratchRoot().startsWith(workspaceRoot() + "/"), `scratch was ${scratchRoot()}`);
  /* Against tmpdir() rather than the literal "/tmp": the suite now points
     MYRA_WORKSPACE at a temporary directory of its own, so a check for the
     string would fail on a correct answer. What matters is that scratch is
     derived from the workspace and is not the OS temp directory itself. */
  assert.notEqual(scratchRoot(), tmpdir());
  assert.notEqual(dirname(scratchRoot()), tmpdir(), "scratch must hang off the workspace");
  // And no hidden directories: snap confinement refuses those under $HOME too.
  assert.ok(!scratchRoot().split("/").some((seg: string) => seg.startsWith(".")), scratchRoot());
  assert.ok(!documentsDir().split("/").some((seg: string) => seg.startsWith(".")), documentsDir());
});

test("a supplied name still gets the extension its format needs", () => {
  /* Observed: asked for "wm-transfer" as Markdown, MyRA wrote a file called
     `wm-transfer` with the right bytes and no extension -- it opens in nothing.
     slugName has always appended one, so the fallback path produced usable
     files while the common path did not. */
  assert.equal(withExtension("wm-transfer", "md"), "wm-transfer.md");
  assert.equal(withExtension("notes/january", "md"), "notes/january.md");
  // Already right: left exactly alone, including its case.
  assert.equal(withExtension("Report.MD", "md"), "Report.MD");
  assert.equal(withExtension("report.md", "md"), "report.md");
  /* Appended, never replaced. "v2" and "2026-01-05" are not extensions, and a
     rule that replaced the last dotted segment would eat them. */
  assert.equal(withExtension("draft.v2", "md"), "draft.v2.md");
  assert.equal(withExtension("minutes.2026-01-05", "docx"), "minutes.2026-01-05.docx");
  // A different real extension is kept too: nothing in the name is destroyed.
  assert.equal(withExtension("report.txt", "md"), "report.txt.md");
});

/**
 * Awkward and escaping are different problems with different answers.
 *
 * `safeRelativePath` refuses both, which is right for a tool call. The draft
 * flow needs the distinction: it has a title to fall back on and a run worth
 * minutes to lose, so a colon in a model-written heading should become a slug
 * while a climb stays an error rather than a silent relocation.
 */
test("a climb is an escape; an awkward character is not", () => {
  for (const escaping of ["../x", "a/../../b", "..\\..\\x", "/etc/passwd", "C:\\x", "..", "a/.. /b"]) {
    assert.ok(looksLikeEscape(escaping), `${JSON.stringify(escaping)} should read as an escape`);
  }
  for (const awkward of ["Study: A Review", "notes.md ", "NUL", "a\\b.md", "ordinary.md"]) {
    assert.ok(!looksLikeEscape(awkward), `${JSON.stringify(awkward)} is awkward, not an escape`);
  }
});
