/**
 * The rubrics reach the model as TEXT.
 *
 * The bug this guards against was invisible: `rubricPath()` returned a path,
 * `runSubagent` put `system` straight into a system message, and so screening,
 * extraction and review each ran with a filename as their entire system
 * prompt. Nothing errored. The stages simply stopped doing their job.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { RUBRICS, rubricDir, rubricText } from "../src/core/research/rubrics.ts";
import { DEFAULT_RUBRICS } from "../src/core/research/rubricText.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "karen-rubrics-"));
  const previous = process.env["KAREN_RESEARCH_RUBRICS"];
  process.env["KAREN_RESEARCH_RUBRICS"] = join(dir, "rubrics");
  try {
    await fn(join(dir, "rubrics"));
  } finally {
    if (previous === undefined) delete process.env["KAREN_RESEARCH_RUBRICS"];
    else process.env["KAREN_RESEARCH_RUBRICS"] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("every rubric returns its own prose, not a path to it", async () => {
  await withTempDir(async () => {
    for (const name of RUBRICS) {
      const text = await rubricText(name);
      assert.match(text, /^# \w+ rubric/, `${name} did not return markdown`);
      assert.ok(text.includes("\n"), `${name} returned a single line — probably a path`);
      assert.ok(!/^\/|\.md$/.test(text.trim()), `${name} returned something path-shaped`);
      assert.ok(text.length > 200, `${name} is too short to be the rubric`);
    }
  });
});

test("the default is installed to the config directory on first use", async () => {
  await withTempDir(async (dir) => {
    const text = await rubricText("screening");
    const onDisk = await readFile(join(dir, "screening.md"), "utf8");
    assert.equal(onDisk, text);
    assert.equal(onDisk, DEFAULT_RUBRICS.screening);
  });
});

test("your edits win, and are never overwritten", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "review.md"), "# Review rubric\n\nOnly flag statistics.\n", "utf8");
    assert.match(await rubricText("review"), /Only flag statistics/);
    // A second run must not restore the shipped default over the top.
    await rubricText("review");
    assert.match(await readFile(join(dir, "review.md"), "utf8"), /Only flag statistics/);
  });
});

test("an unwritable config directory still yields the rubric", async () => {
  const previous = process.env["KAREN_RESEARCH_RUBRICS"];
  // A path under a regular file cannot be created, so mkdir and writeFile both
  // fail. Losing editability is acceptable; losing the rubric is not.
  const file = join(await mkdtemp(join(tmpdir(), "karen-ro-")), "not-a-dir");
  await writeFile(file, "x", "utf8");
  process.env["KAREN_RESEARCH_RUBRICS"] = join(file, "rubrics");
  try {
    assert.match(await rubricText("extraction"), /Quote exactly/);
  } finally {
    if (previous === undefined) delete process.env["KAREN_RESEARCH_RUBRICS"];
    else process.env["KAREN_RESEARCH_RUBRICS"] = previous;
    await rm(file, { force: true });
  }
});

test("rubricDir honours the environment override", () => {
  const previous = process.env["KAREN_RESEARCH_RUBRICS"];
  process.env["KAREN_RESEARCH_RUBRICS"] = "/tmp/karen-elsewhere";
  try {
    assert.equal(rubricDir(), "/tmp/karen-elsewhere");
  } finally {
    if (previous === undefined) delete process.env["KAREN_RESEARCH_RUBRICS"];
    else process.env["KAREN_RESEARCH_RUBRICS"] = previous;
  }
});
