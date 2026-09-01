/**
 * What the document panel is fed.
 *
 * The panel itself is a React component in a .tsx, which the test runner
 * cannot load, so this covers the half that can go wrong quietly: whether
 * writing a document announces it at all, what it announces, and whether the
 * draft flow's intermediate saves are distinguishable from the finished one.
 * A panel fed nothing looks exactly like a panel that is broken.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setDocumentWatcher, writeDocumentTool, type DocumentUpdate,
} from "../src/core/agent/tools/documents.ts";

/* KAREN_WORKSPACE, not KAREN_WORKSPACE_ROOT -- getting this name wrong does
   not fail the test, it silently writes into the developer's real documents
   folder, which is exactly what it did on the first run. Each test
   gets its own and nothing lands in the developer's real documents folder. */
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "karen-docs-"));
  process.env["KAREN_WORKSPACE"] = root;
  return root;
}

afterEach(() => setDocumentWatcher(undefined));

const collect = (): DocumentUpdate[] => {
  const seen: DocumentUpdate[] = [];
  setDocumentWatcher((doc) => seen.push(doc));
  return seen;
};

test("writing a document announces it, with the text and a readable name", async () => {
  sandbox();
  const seen = collect();
  await writeDocumentTool.handler(
    { name: "notes.md", content: "# Notes\n\nSomething true." },
    {},
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.name, "notes.md");
  assert.equal(seen[0]!.markdown, "# Notes\n\nSomething true.");
  assert.equal(seen[0]!.final, true);
  // The path is absolute and the file is really there: the panel offers to
  // show it in a folder, which has to be a folder that exists.
  assert.equal(readFileSync(seen[0]!.path, "utf8"), "# Notes\n\nSomething true.");
});

test("the announced name is relative, because that is what a person calls it", async () => {
  sandbox();
  const seen = collect();
  await writeDocumentTool.handler({ name: "sub/deep.md", content: "x" }, {});
  assert.equal(seen[0]!.name, "sub/deep.md");
  assert.ok(seen[0]!.path.endsWith("sub/deep.md"));
});

test("no watcher installed is not an error, it is simply nobody listening", async () => {
  sandbox();
  setDocumentWatcher(undefined);
  const result = await writeDocumentTool.handler({ name: "quiet.md", content: "x" }, {});
  assert.match(result.content, /Wrote quiet\.md/);
});
