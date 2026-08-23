/**
 * The document jail, attacked.
 *
 * These are v1's six vectors, re-aimed at the tool layer that replaced the
 * broker: traversal, an absolute path, a normalisation-hidden climb, a symlink
 * whose target is outside, a symlink to a directory outside, and a NUL. All six
 * must be refused, and a legitimate path must still work -- a jail that refuses
 * everything is not evidence of anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInJail } from "../src/core/agent/tools/documents.ts";
import { pandocArgs } from "../src/core/documents/formats.ts";

async function withJail<T>(body: (jail: string, outside: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "karen-jail-"));
  const jail = join(root, "documents");
  const outside = join(root, "outside");
  await mkdir(jail, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "the user's private notes");
  try {
    return await body(jail, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the six escape vectors are all refused", async () => {
  await withJail(async (jail, outside) => {
    await symlink(join(outside, "secret.md"), join(jail, "link-to-file.md"));
    await symlink(outside, join(jail, "link-to-dir"));

    const attacks: [string, string][] = [
      ["traversal", "../outside/secret.md"],
      ["deeper traversal", "../../../../../../etc/passwd"],
      ["absolute path", "/etc/passwd"],
      ["climb hidden by normalisation", "notes/../../outside/secret.md"],
      ["symlink to a file outside", "link-to-file.md"],
      ["symlink to a directory outside", "link-to-dir/secret.md"],
    ];

    for (const [label, name] of attacks) {
      await assert.rejects(
        () => resolveInJail(jail, name),
        (err: Error) => /outside|not a name|absolute path/.test(err.message),
        `${label} was NOT refused: ${name}`,
      );
    }

    // A NUL truncates the path in any C API it reaches.
    await assert.rejects(() => resolveInJail(jail, "notes.md\0.png"), /not a name/);
  });
});

test("a legitimate path still resolves, including one not yet created", async () => {
  await withJail(async (jail) => {
    // The everyday case: a file that does not exist yet, in a directory that
    // does not exist yet. realpath fails on both, so the check must walk up to
    // the nearest existing ancestor rather than giving up.
    const fresh = await resolveInJail(jail, "meetings/2026/notes.md");
    assert.ok(fresh.startsWith(jail + "/"), fresh);
    assert.ok(fresh.endsWith("/meetings/2026/notes.md"));

    await writeFile(join(jail, "existing.md"), "hello");
    const existing = await resolveInJail(jail, "existing.md");
    assert.equal(await readFile(existing, "utf8"), "hello");

    // A symlink that stays inside is fine: the rule is about where it lands.
    await mkdir(join(jail, "real"), { recursive: true });
    await writeFile(join(jail, "real", "paper.md"), "inside");
    await symlink(join(jail, "real"), join(jail, "alias"));
    const viaLink = await resolveInJail(jail, "alias/paper.md");
    assert.equal(await readFile(viaLink, "utf8"), "inside");
  });
});

/*
 * The other half of the boundary.
 *
 * A jail keeps the model out of the filesystem; the argv rule keeps it out of
 * the process table. pandoc's --lua-filter and --filter execute arbitrary code
 * by design, so a convert path that accepted extra flags would hand back the
 * exact capability that removing pi took away.
 */
test("the pandoc argv is a fixed template with no way in", () => {
  const args = pandocArgs({
    source: "/w/in.md",
    from: "markdown",
    to: "docx",
    output: "/w/out.docx",
  });

  for (const forbidden of ["--lua-filter", "--filter", "--metadata-file", "-V", "--template"]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never appear`);
  }
  assert.ok(args.includes("--sandbox"), "the reader must be sandboxed: input can come off the web");
  assert.ok(args.includes("--standalone"), "without it a .docx has no document skeleton");

  // Every value lands in a slot that expects a value, never as a bare flag.
  assert.equal(args[args.indexOf("--from") + 1], "markdown");
  assert.equal(args[args.indexOf("--to") + 1], "docx");
  assert.equal(args[args.indexOf("--output") + 1], "/w/out.docx");
  assert.equal(args.at(-1), "/w/in.md", "the source is the final positional argument");
});

test("a filename that looks like a flag stays a filename", () => {
  // argv is a list, not a string, so this cannot become an option -- but assert
  // it, because the day someone joins these with spaces is the day it can.
  const args = pandocArgs({
    source: "--lua-filter=evil.lua",
    from: "markdown",
    to: "docx",
    output: "/w/out.docx",
  });
  assert.equal(args.at(-1), "--lua-filter=evil.lua");
  assert.equal(args.filter((a) => a === "--lua-filter=evil.lua").length, 1);
});
