/**
 * The document jail, attacked.
 *
 * These are v1's six vectors, re-aimed at the tool layer that replaced the
 * broker: traversal, an absolute path, a normalisation-hidden climb, a symlink
 * whose target is outside, a symlink to a directory outside, and a NUL. All six
 * must be refused, and a legitimate path must still work -- a jail that refuses
 * everything is not evidence of anything.
 *
 * The seventh came later and is the one the first six missed: a symlink whose
 * target does NOT exist yet. realpath cannot resolve those either, so the walk
 * up to the nearest existing ancestor stepped over the link and handed back its
 * own path as a file waiting to be created -- which writeFile then followed out
 * of the jail.
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

test("a broken symlink is an escape too, and is refused", async () => {
  await withJail(async (jail, outside) => {
    /* Nothing the model can call creates a symlink, so these arrive another
       way: a link to a drive that is not mounted, or one a sync client
       restored before its target. The target's absence is the whole point --
       with it present, realpath resolves the link and the fifth vector above
       already covers it. */
    const missing = join(outside, "planted.md");
    await symlink(missing, join(jail, "notes.md"));
    await assert.rejects(() => resolveInJail(jail, "notes.md"), /outside/);

    // The directory form: a link to a folder that does not exist yet, with a
    // perfectly ordinary filename under it.
    await symlink(join(outside, "not-mounted"), join(jail, "usb"));
    await assert.rejects(() => resolveInJail(jail, "usb/report.md"), /outside/);

    // Not through a chain of them either.
    await symlink(join(jail, "notes.md"), join(jail, "latest.md"));
    await assert.rejects(() => resolveInJail(jail, "latest.md"), /outside/);
  });
});

test("a broken symlink that stays inside still resolves, and a loop does not hang", async () => {
  await withJail(async (jail) => {
    /* The legitimate use of the same thing: a `latest.md` pointing at the file
       this run is about to write. Refusing it would break writing through any
       link the user keeps in their own folder. */
    await mkdir(join(jail, "reports"), { recursive: true });
    await symlink(join(jail, "reports", "q3.md"), join(jail, "latest.md"));
    const abs = await resolveInJail(jail, "latest.md");
    assert.equal(abs, join(jail, "reports", "q3.md"), "the link's destination, not the link");

    await symlink(join(jail, "a.md"), join(jail, "b.md"));
    await symlink(join(jail, "b.md"), join(jail, "a.md"));
    await assert.rejects(() => resolveInJail(jail, "a.md"), /too many symlinks/);
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
