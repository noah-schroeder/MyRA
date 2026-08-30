/**
 * The one-time sweep over content an older install already wrote.
 *
 * The interesting cases are not "does chmod work" but the three restraints:
 * an executable must stay executable, a symlink must not be followed out of
 * the tree, and an already-private tree must produce no writes at all.
 */

import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { tightenTree } from "../src/core/paths.ts";

const mode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o7777;

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "karen-tighten-"));
  await mkdir(join(root, "run", "papers"), { recursive: true });
  await chmod(join(root, "run"), 0o775);
  await chmod(join(root, "run", "papers"), 0o755);
  await writeFile(join(root, "run", "report.md"), "# findings\n");
  await chmod(join(root, "run", "report.md"), 0o644);
  return root;
}

test("a world-readable run and its report become owner-only", async () => {
  const root = await tree();
  const changed = await tightenTree(root);

  assert.equal(await mode(join(root, "run")), 0o700);
  assert.equal(await mode(join(root, "run", "papers")), 0o700);
  assert.equal(await mode(join(root, "run", "report.md")), 0o600);
  assert.equal(changed, 3);
});

test("an executable keeps its execute bit", async () => {
  const root = await tree();
  const tool = join(root, "pandoc");
  await writeFile(tool, "#!/bin/sh\n");
  await chmod(tool, 0o755);

  await tightenTree(root);

  // 0700, not 0600: stripping the group and other bits must not take the
  // owner's execute bit with them, or the binary stops running.
  assert.equal(await mode(tool), 0o700);
});

test("a symlink is not followed, and the target keeps its permissions", async () => {
  const root = await tree();
  const outside = await mkdtemp(join(tmpdir(), "karen-elsewhere-"));
  await writeFile(join(outside, "shared.md"), "not Karen's\n");
  await chmod(join(outside, "shared.md"), 0o644);
  await symlink(outside, join(root, "link"));

  await tightenTree(root);

  assert.equal(await mode(join(outside, "shared.md")), 0o644);
});

test("a tree that is already private is left completely alone", async () => {
  const root = await tree();
  await tightenTree(root);
  // The second pass is the one that matters: it runs on every launch after a
  // migration and must do no work.
  assert.equal(await tightenTree(root), 0);
});

test("the walk stops at its budget rather than running away", async () => {
  const root = await tree();
  assert.ok((await tightenTree(root, 1)) <= 1);
});
