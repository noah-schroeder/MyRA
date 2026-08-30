/**
 * Deleting a research run.
 *
 * The two properties that matter are that it cannot be aimed outside the
 * research root, and that it refuses a run something is still writing to --
 * there is no lock file, so recent writes are the only signal available.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deleteRun, runFootprint, RUN_ACTIVE_WITHIN_MS } from "../src/core/research/run.ts";

/** A run directory with a couple of files, aged so it does not look live. */
function makeRun(root: string, id: string, ageMs = RUN_ACTIVE_WITHIN_MS * 2): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "sources"), { recursive: true });
  writeFileSync(join(dir, "question.json"), JSON.stringify({ question: "does it delete" }));
  writeFileSync(join(dir, "sources", "1.txt"), "x".repeat(2048));
  const when = new Date(Date.now() - ageMs);
  for (const f of [join(dir, "question.json"), join(dir, "sources", "1.txt")]) utimesSync(f, when, when);
  return dir;
}

test("a footprint counts every file, including stored sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  makeRun(root, "2026-01-01-topic-aaaa");
  const fp = await runFootprint("2026-01-01-topic-aaaa", root);
  assert.equal(fp.files, 2);
  assert.ok(fp.bytes > 2048);
  assert.ok(fp.lastWriteMs > 0);
});

test("deleting removes the directory and reports what it freed", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const dir = makeRun(root, "2026-01-01-topic-bbbb");
  const gone = await deleteRun("2026-01-01-topic-bbbb", root);
  assert.equal(existsSync(dir), false);
  assert.equal(gone.files, 2);
  assert.ok(gone.bytes > 2048);
});

test("a run written to moments ago is refused, not deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const dir = makeRun(root, "2026-01-01-live-cccc", 5_000);
  await assert.rejects(
    () => deleteRun("2026-01-01-live-cccc", root),
    /still being written to .* seconds ago/,
  );
  // Refused means untouched, not partially removed.
  assert.equal(existsSync(join(dir, "sources", "1.txt")), true);
});

test("a run just outside the window deletes normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const dir = makeRun(root, "2026-01-01-idle-dddd", RUN_ACTIVE_WITHIN_MS + 5_000);
  await deleteRun("2026-01-01-idle-dddd", root);
  assert.equal(existsSync(dir), false);
});

test("deletion cannot be aimed outside the research root", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const sibling = join(root, "..", "must-survive");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "keep.txt"), "keep");
  for (const id of ["..", ".", "../must-survive", "/etc", "a/../../b", ""]) {
    await assert.rejects(() => deleteRun(id, root), /no research run named/);
  }
  assert.equal(existsSync(join(sibling, "keep.txt")), true);
});

test("deleting a run that is not there says so rather than succeeding quietly", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  await assert.rejects(() => deleteRun("2026-01-01-absent-eeee", root), /no research run named/);
});

test("the refusal counts seconds in English", async () => {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  makeRun(root, "2026-01-01-just-now-ffff", 900);
  await assert.rejects(() => deleteRun("2026-01-01-just-now-ffff", root), /1 second ago/);
  makeRun(root, "2026-01-01-recent-gggg", 9_000);
  await assert.rejects(() => deleteRun("2026-01-01-recent-gggg", root), /9 seconds ago/);
});
