/**
 * The rubrics, as plain markdown you own.
 *
 * Screening criteria, extraction rules and review standards are domain
 * judgement, not code. They ship as defaults and are copied into your config
 * directory the first time a run needs them; after that the copy is yours and
 * is never overwritten. Editing it changes the next run with no rebuild.
 *
 * This is the honest version of pi's "skills" idea for a deterministic
 * pipeline: nothing is loaded on demand by a model deciding it needs help --
 * the stage that needs a rubric always gets exactly that rubric.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const RUBRICS = ["screening", "extraction", "review"] as const;
export type RubricName = (typeof RUBRICS)[number];

/** Where the editable copies live. */
export function rubricDir(): string {
  return (
    process.env["KAREN_RESEARCH_RUBRICS"] ??
    join(process.env["HOME"] ?? homedir(), ".config", "karen", "research", "rubrics")
  );
}

function shippedDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "rubrics");
}

/**
 * Path to a rubric, installing the default on first use.
 *
 * Returns a path rather than text because pi takes `--append-system-prompt`
 * with a file, so the rubric never has to be squeezed through an argv.
 */
export async function rubricPath(name: RubricName): Promise<string> {
  const dir = rubricDir();
  const mine = join(dir, `${name}.md`);
  if (existsSync(mine)) return mine;

  const shipped = join(shippedDir(), `${name}.md`);
  if (!existsSync(shipped)) throw new Error(`missing default rubric: ${shipped}`);
  await mkdir(dir, { recursive: true });
  // Never clobber: if two stages race here, the first copy wins and both then
  // read the same file. An edited rubric must survive every subsequent run.
  await copyFile(shipped, mine, 1 /* COPYFILE_EXCL */).catch(() => undefined);
  return existsSync(mine) ? mine : shipped;
}
