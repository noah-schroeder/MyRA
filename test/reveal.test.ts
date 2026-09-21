/**
 * Which paths a "show in folder" button may point the file manager at.
 *
 * Two of the three handlers did `shell.showItemInFolder(String(path))` on a
 * raw string off IPC, three files from `myra:document-reveal`, which had
 * always resolved through the jail first. The answer is one function all
 * three call, so the next reveal cannot be the fourth to forget.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { revealInside } from "../src/main/reveal.ts";
import { insideRoot } from "../src/core/paths.ts";

const ROOT = "/home/u/Documents/myra";

test("a path inside a root MyRA writes to is revealed", () => {
  for (const p of [ROOT, join(ROOT, "notes.md"), join(ROOT, "a", "b", "c.pdf")]) {
    const v = revealInside(p, [ROOT], "a thing");
    assert.ok(v.ok, `${p} should be revealable`);
  }
});

test("anything else is refused, including the near misses", () => {
  const cases = [
    ["a sibling whose name starts the same", "/home/u/Documents/myra-private/x.md"],
    ["a climb out", join(ROOT, "..", "..", ".ssh", "id_rsa")],
    ["somewhere else entirely", "/etc/passwd"],
    ["empty", ""],
    ["not a string", undefined],
  ] as const;
  for (const [label, p] of cases) {
    const v = revealInside(p, [ROOT], "a thing");
    assert.equal(v.ok, false, `${label}: ${JSON.stringify(p)} was revealed`);
  }
});

test("an unset root does not become a root that matches everything", () => {
  /* vaultRoot defaults to "" and meetings pass it in beside meetingsRoot.
     An empty string resolves to the process's working directory, so a filter
     that let it through would reveal anything under wherever MyRA was run. */
  const v = revealInside("/etc/passwd", [ROOT, ""], "a meeting file");
  assert.equal(v.ok, false);
});

test("containment is separator-aware, which a prefix compare is not", () => {
  assert.ok(insideRoot("/a/b", "/a/b/c"));
  assert.ok(!insideRoot("/a/b", "/a/bc"), "the bug a bare startsWith has");
  assert.ok(!insideRoot("/a/b", "/a/b"), "the root itself, by default");
  assert.ok(insideRoot("/a/b", "/a/b", { allowRoot: true }));
  assert.ok(!insideRoot("/a/b", "/a"));
});
