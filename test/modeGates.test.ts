/**
 * The shape of a rung test, not the behaviour of one.
 *
 * This bug class has now come up three times, always the same way: a gate
 * written as `mode !== "off"` or `mode === "web"`, correct on the day it was
 * written because of how many rungs happened to exist, and silently wrong the
 * moment one was added in the middle. `fetch_page` had it, and adding
 * "assistant" would have handed the web to the one rung whose promise is that
 * it has none.
 *
 * The behaviour is pinned elsewhere. What is pinned HERE is that the rule
 * cannot be written in the fragile form again without a test saying so, which
 * is the only version of this that survives the next rung.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { RESEARCH_MODES } from "../src/core/research/config.ts";

/** Where gates live. The renderer draws controls; it decides nothing. */
const ROOTS = ["src/core", "src/main", "src/preload"];

/**
 * The one file allowed to name a rung: the ladder itself, plus the migration
 * that has to say "off" out loud to reinterpret an unversioned one.
 */
const LADDER = join("src", "core", "research", "config.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("no gate compares a mode against a rung by name", () => {
  /* `reaches` for "this far and beyond", `exactly` for the two searching rungs
     that are deliberately exclusive. Both say what they mean; `===` on a
     literal does not, and reads identically whether it was reasoned about or
     typed on autopilot. */
  /* Anchored on the left-hand side, not just the string: "assistant" is also a
     chat role and "library" is also a Hugging Face namespace, and neither of
     those is a rung. What is being looked for is a MODE compared by name --
     `cfg.mode === "web"`, `mode() !== "off"`, `readResearchConfig().mode`. */
  const shapes = RESEARCH_MODES.map(
    (rung) => new RegExp(`\\bmode(?:\\(\\))?\\s*[!=]==\\s*"${rung}"`),
  );

  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sources(root)) {
      if (file === LADDER) continue;
      // Comments explain the bug; they are not the bug.
      // Blanked, not deleted: dropping the newlines would misreport the line.
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) =>
        c.replace(/[^\n]/g, " "),
      );
      code.split("\n").forEach((line, i) => {
        const bare = line.replace(/\/\/.*$/, "");
        if (shapes.some((re) => re.test(bare))) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Compare rungs with reaches() or exactly(), not by name:\n" + offenders.join("\n"),
  );
});

test("every rung is reachable from the ladder alone", () => {
  // A rung added to the type but not to the array indexes as -1, which makes
  // `reaches` answer true for everything -- the failure mode with no symptom.
  assert.equal(new Set(RESEARCH_MODES).size, RESEARCH_MODES.length);
  assert.deepEqual([...RESEARCH_MODES], ["off", "assistant", "library", "web", "deep"]);
});
