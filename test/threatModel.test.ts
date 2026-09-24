/**
 * The threat model document, checked against the code it describes.
 *
 * This exists because of what it replaces. `src/core/risk.ts` spent a year
 * describing "the VM plus the host broker's tiny verb allowlist" as the thing
 * containing a hostile agent, in 328 lines with a green test suite, long after
 * both had been removed. A confident paragraph nothing verifies is worse than
 * no paragraph: it reads as a guarantee and is a wish.
 *
 * So the enumerated claims in docs/threat-model.md are a fixture. Adding a
 * tool without documenting it fails here, which is the only mechanism that
 * survives the next contributor.
 *
 * In the spirit of destinations.test.ts, which already fails when a host
 * appears in a fetch but not in the privacy table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RESEARCH_TOOL_DEFS } from "../src/core/agent/tools/research.ts";
import { DOCUMENT_TOOL_DEFS } from "../src/core/agent/tools/documents.ts";
import { LIBRARY_TOOL_DEFS } from "../src/core/agent/tools/library.ts";
import { TASK_TOOL_DEFS } from "../src/core/agent/tools/tasks.ts";
import { DIAGRAM_TOOL_DEFS } from "../src/core/agent/tools/diagram.ts";
import { TABLE_TOOL_DEFS } from "../src/core/agent/tools/table.ts";
import { PRISMA_TOOL_DEFS } from "../src/core/agent/tools/prisma.ts";
import { CHART_TOOL_DEFS } from "../src/core/agent/tools/chart.ts";
import { MEMORY_TOOL_DEFS } from "../src/core/agent/tools/memory.ts";
import { RISK_CLASSES } from "../src/core/policy.ts";

const DOC = "docs/threat-model.md";

const REGISTERED = [
  ...RESEARCH_TOOL_DEFS,
  ...DOCUMENT_TOOL_DEFS,
  ...LIBRARY_TOOL_DEFS,
  ...TASK_TOOL_DEFS,
  ...DIAGRAM_TOOL_DEFS,
  ...TABLE_TOOL_DEFS,
  ...PRISMA_TOOL_DEFS,
  ...CHART_TOOL_DEFS,
  ...MEMORY_TOOL_DEFS,
].map((t) => [t.name, t.risk] as [string, string]);

/** The `| \`name\` | \`risk\` |` rows, in order. */
function documentedTools(): [string, string][] {
  const out: [string, string][] = [];
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const m = /^\|\s*`([a-z_]+)`\s*\|\s*`([a-z_]+)`\s*\|$/.exec(line.trim());
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

test("the documented tool table is the registry, name for name and class for class", () => {
  assert.deepEqual(
    documentedTools(),
    REGISTERED,
    `${DOC} is out of date. A tool the page does not list is a capability ` +
      `nobody told the reader about; a risk class that disagrees is worse.`,
  );
});

test("every documented risk class is one the policy actually has", () => {
  for (const [name, risk] of documentedTools()) {
    assert.ok(RISK_CLASSES.includes(risk as never), `${name} is documented as ${risk}`);
  }
});

/**
 * The guard against the guard drifting.
 *
 * The test above compares the page to four arrays it imports by name. A fifth
 * array registered in main and not imported here would be a whole family of
 * tools that neither the page nor this test has heard of.
 */
test("no tool array is registered that this test does not know about", () => {
  const main = readFileSync("src/main/index.ts", "utf8");
  const registered = new Set([...main.matchAll(/\b([A-Z_]+_TOOL_DEFS)\b/g)].map((m) => m[1]!));
  assert.deepEqual(
    [...registered].sort(),
    ["CHART_TOOL_DEFS", "DIAGRAM_TOOL_DEFS", "DOCUMENT_TOOL_DEFS", "LIBRARY_TOOL_DEFS", "MEMORY_TOOL_DEFS",
      "PRISMA_TOOL_DEFS", "RESEARCH_TOOL_DEFS", "TABLE_TOOL_DEFS", "TASK_TOOL_DEFS"],
    "A tool array was added to installIpc. Import it here and add its rows to " + DOC,
  );
});

test("the page still states the things that are easy to quietly stop being true", () => {
  const text = readFileSync(DOC, "utf8");
  for (const claim of [
    "no OS-level sandbox",
    "There is no `bash`",
    "the approval prompt never fires",
    "Injection cannot widen what the agent can do",
  ]) {
    assert.ok(
      text.includes(claim),
      `${DOC} no longer says "${claim}". If that is because it stopped being ` +
        `true, good — update this test. If it was tidied away, put it back.`,
    );
  }
});
