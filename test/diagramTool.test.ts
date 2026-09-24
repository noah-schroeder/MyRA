/**
 * The tool, whose job is mostly to refuse well.
 *
 * `ToolResult.content` is what the model reads, so a refusal here IS the repair
 * loop -- the agent loop calls the tool again with a corrected source the same
 * way it retries any other failed call. Each refusal is therefore asserted to
 * name the line and say what to do, because a message that only says "invalid"
 * gives the model nothing to act on.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createDiagramTool, resetDiagramIds, setDiagramWatcher, type DiagramUpdate,
} from "../src/core/agent/tools/diagram.ts";

const ctx = {} as never;
const run = (params: Record<string, unknown>) => createDiagramTool.handler(params, ctx);

test("it is safe, because nothing it does touches a disk", () => {
  /* The figure lives in the conversation; a file appears only when a person
     presses Export, which is their action rather than the agent's. */
  assert.equal(createDiagramTool.risk, "safe");
});

test("a good diagram is announced to whatever is showing them", async () => {
  resetDiagramIds();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  try {
    const res = await run({ title: "Screening", source: "flowchart TD\n A[One] --> B[Two]" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.title, "Screening");
    assert.equal(seen[0]?.id, "diagram-1");
    assert.match(res.content, /2 nodes and 1 edge/);
  } finally {
    setDiagramWatcher(undefined);
  }
});

test("with no watcher installed it draws and tells nobody, rather than throwing", async () => {
  setDiagramWatcher(undefined);
  const res = await run({ source: "flowchart TD\n A --> B" });
  assert.match(res.content, /Drew/);
});

test("a parse error comes back as the result, which is the repair loop", async () => {
  const res = await run({ source: "flowchart TD\n A --> " });
  assert.match(res.content, /Line 2/);
  assert.match(res.content, /call create_diagram again/i);
});

test("nothing is announced when the diagram did not parse", async () => {
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  try {
    await run({ source: "sequenceDiagram\n A->>B: hi" });
    assert.equal(seen.length, 0, "a broken diagram must not reach the panel");
  } finally {
    setDiagramWatcher(undefined);
  }
});

test("an unsupported diagram type is named so the model can rewrite it", async () => {
  const res = await run({ source: "gantt\n title A" });
  assert.match(res.content, /gantt/);
  assert.match(res.content, /flowchart TD/);
});

test("empty source is refused without pretending to draw", async () => {
  const res = await run({ source: "   " });
  assert.match(res.content, /No diagram source/);
});

test("a missing title falls back rather than producing an unnamed figure", async () => {
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  try {
    await run({ source: "flowchart TD\n A --> B" });
    assert.equal(seen[0]?.title, "Diagram");
  } finally {
    setDiagramWatcher(undefined);
  }
});

test("ids advance, so a redraw is a new figure rather than a silent overwrite", async () => {
  resetDiagramIds();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  try {
    await run({ source: "flowchart TD\n A --> B" });
    await run({ source: "flowchart TD\n C --> D" });
    assert.deepEqual(seen.map((d) => d.id), ["diagram-1", "diagram-2"]);
  } finally {
    setDiagramWatcher(undefined);
  }
});

test("the model is told not to repeat the source in its reply", async () => {
  // Otherwise the diagram arrives twice: once drawn, once as a wall of syntax.
  const res = await run({ source: "flowchart TD\n A --> B" });
  assert.match(res.content, /Do not repeat the diagram source/);
});

test("a diagram within the category cap gets no overflow note", async () => {
  const res = await run({ source: "flowchart TD\n A:::warm --> B:::cool" });
  assert.doesNotMatch(res.content, /categories are shown in colour/);
});

test("a diagram past the category cap tells the model which names were dropped, not just that some were", async () => {
  const names = Array.from({ length: 8 }, (_, i) => `cat${i}`);
  const source = `flowchart TD\n${names.map((n, i) => ` N${i}:::${n}`).join("\n")}`;
  const res = await run({ source });
  assert.match(res.content, /Only the first 6 categories are shown in colour/);
  assert.match(res.content, /"cat6", "cat7"/);
});

test("a colour the parser could not use is drawn around and named back to the model", async () => {
  const result = await createDiagramTool.handler(
    { source: "flowchart TD\n A --> B\n style A fill:blurple,stroke:#333" },
    {},
  );
  assert.match(result.content, /^Drew/);
  assert.match(result.content, /Not everything was applied/);
  assert.match(result.content, /`blurple` is not a colour/);
});

test("a style the model names reaches the figure and is said back; an unknown one is dropped", async () => {
  resetDiagramIds();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  try {
    const posh = await run({ source: "flowchart TD\n A --> B", style: "poster" });
    assert.match(posh.content, /in the Poster style/);
    assert.equal(seen[0]?.style, "poster");
    const odd = await run({ source: "flowchart TD\n A --> B", style: "sparkly" });
    assert.match(odd.content, /^Drew/);
    assert.equal("style" in seen[1]!, false);
  } finally {
    setDiagramWatcher(undefined);
  }
});
