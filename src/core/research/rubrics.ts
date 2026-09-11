/**
 * The rubrics, as plain markdown you own.
 *
 * Screening criteria, extraction rules and review standards are domain
 * judgement, not code. They ship as defaults and are written into your config
 * directory the first time a run needs them; after that the copy is yours and
 * is never overwritten. Editing it changes the next run with no rebuild.
 *
 * This returns TEXT, not a path, and that distinction is the whole history of
 * this file. v1 handed pi a path (`--append-system-prompt <file>`) and pi read
 * it. v2's runSubagent puts `system` straight into a system message, so
 * returning a path meant screening, extraction and review each ran with a
 * filename as their system prompt -- three quality stages silently doing
 * nothing, for as long as the port had existed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_RUBRICS } from "./rubricText.ts";
import { makeOwnDir, OWNER_ONLY_FILE } from "../paths.ts";

export const RUBRICS = ["screening", "extraction", "review"] as const;
export type RubricName = (typeof RUBRICS)[number];

/** Where the editable copies live. */
export function rubricDir(): string {
  return (
    process.env["MYRA_RESEARCH_RUBRICS"] ??
    join(process.env["HOME"] ?? homedir(), ".config", "myra", "research", "rubrics")
  );
}

/**
 * The text of a rubric, installing the default on first use.
 *
 * Your copy always wins once it exists. A failure to write the default is not
 * fatal -- the built-in text is returned anyway, because a read-only config
 * directory is a reason to lose editability, not a reason to lose the rubric.
 */
export async function rubricText(name: RubricName): Promise<string> {
  const mine = join(rubricDir(), `${name}.md`);
  try {
    const existing = await readFile(mine, "utf8");
    if (existing.trim()) return existing;
  } catch {
    // Not installed yet: fall through and write the default below.
  }

  const shipped = DEFAULT_RUBRICS[name];
  try {
    await makeOwnDir(rubricDir());
    // `wx` never clobbers: if two stages race here the first wins, and an
    // edited rubric survives every subsequent run.
    await writeFile(mine, shipped, { encoding: "utf8", flag: "wx", mode: OWNER_ONLY_FILE });
  } catch {
    // Already there, or nowhere to write. Either way the text below is right.
  }
  return shipped;
}
