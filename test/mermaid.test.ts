/**
 * Reading Mermaid flowcharts, which MyRA parses rather than running.
 *
 * The cases here are the ones a model actually produces: chains, branch labels,
 * nodes introduced bare and labelled later, hyphens inside labels. The refusals
 * matter as much as the successes -- what the parser rejects is what the model
 * reads back and fixes, so each one is asserted to name the thing to change.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseMermaid } from "../src/core/diagrams/mermaid.ts";

function ok(src: string) {
  const got = parseMermaid(src);
  assert.ok(got.ok, got.ok ? "" : `refused: ${got.error}`);
  return got.diagram;
}

test("a chain becomes nodes and the edges between them", () => {
  const d = ok("flowchart TD\n  A[Start] --> B[Middle] --> C[End]");
  assert.equal(d.direction, "TD");
  assert.deepEqual(d.nodes.map((n) => n.id), ["A", "B", "C"]);
  assert.deepEqual(d.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "B->C"]);
});

test("`graph` and `flowchart` are the same word", () => {
  assert.equal(ok("graph LR\n A-->B").direction, "LR");
});

test("bracket forms select the shape, longest opener first", () => {
  /* `[[` before `[`, or `A[[Sub]]` is a rectangle whose label starts with a
     bracket -- the bug the ordered list in SHAPES exists to prevent. */
  const d = ok(`flowchart TD
    a[Rect] --> b(Round) --> c([Stadium]) --> d[[Sub]]
    d --> e{Decision} --> f{{Hex}} --> g((Circle)) --> h[(Store)]`);
  const shape = (id: string) => d.nodes.find((n) => n.id === id)?.shape;
  assert.equal(shape("a"), "rect");
  assert.equal(shape("b"), "round");
  assert.equal(shape("c"), "stadium");
  assert.equal(shape("d"), "subroutine");
  assert.equal(shape("e"), "diamond");
  assert.equal(shape("f"), "hexagon");
  assert.equal(shape("g"), "circle");
  assert.equal(shape("h"), "cylinder");
});

test("both edge label forms mean the same edge", () => {
  const piped = ok("flowchart TD\n A -->|excluded| B");
  const inline = ok("flowchart TD\n A -- excluded --> B");
  assert.equal(piped.edges[0]?.label, "excluded");
  assert.deepEqual(inline.edges[0], piped.edges[0]);
});

test("a label may hold hyphens, which the inline form must not eat", () => {
  // `-- Full-text --> B`: a lazy match that stopped at the first `-` would cut it.
  const d = ok("flowchart TD\n A -- Full-text screen --> B");
  assert.equal(d.edges[0]?.label, "Full-text screen");
});

test("a literal | inside an inline label does not truncate it or name a phantom node", () => {
  // Without quoting the label before rewriting it into piped form, the
  // reader found the label's own embedded `|` as the closing delimiter,
  // truncated the label there, and misread the remainder as a bogus
  // one-token node id -- an error naming a node ("no") that never appeared
  // in the source.
  const d = ok("flowchart TD\n A -- yes|no --> B");
  assert.equal(d.edges[0]?.label, "yes|no");
  assert.deepEqual(d.nodes.map((n) => n.id), ["A", "B"]);
});

test("an explicitly quoted piped label may also hold a literal |", () => {
  const d = ok('flowchart TD\n A -->|"include|exclude"| B');
  assert.equal(d.edges[0]?.label, "include|exclude");
});

test("a plain chain is not mistaken for an inline label", () => {
  /* Without the lookahead in `normaliseInlineLabels`, `A --> B --> C` matches
     the inline-label pattern with `> B` as the label. */
  const d = ok("flowchart TD\n A --> B --> C");
  assert.equal(d.edges.length, 2);
  assert.equal(d.edges[0]?.label, undefined);
});

test("edge styles are kept apart, and so is an arrowless link", () => {
  const d = ok("flowchart TD\n A --> B\n B -.-> C\n C ==> D\n D --- E");
  assert.deepEqual(d.edges.map((e) => e.style), ["solid", "dotted", "thick", "solid"]);
  assert.deepEqual(d.edges.map((e) => e.arrow), [true, true, true, false]);
});

test("a node introduced bare is labelled by a later mention", () => {
  const d = ok("flowchart TD\n A --> B\n B[Screened]");
  assert.equal(d.nodes.find((n) => n.id === "B")?.label, "Screened");
});

test("an unlabelled node falls back to its own id", () => {
  assert.equal(ok("flowchart TD\n A --> B").nodes[0]?.label, "A");
});

test("a quoted label may contain the closing bracket", () => {
  const d = ok('flowchart TD\n A["Records [n=842]"] --> B');
  assert.equal(d.nodes[0]?.label, "Records [n=842]");
});

test("an id may hold a hyphen, and an arrow may have no spaces around it", () => {
  /* `A-->B` read as an id of `A--` followed by `>B`, which then parsed as a
     flag-shaped node missing its `]`. Both halves are asserted together
     because the fix for one is what could break the other. */
  const tight = ok("flowchart TD\n A-->B");
  assert.deepEqual(tight.nodes.map((n) => n.id), ["A", "B"]);
  const hyphen = ok("flowchart TD\n step-1[First] --> step-2[Second]");
  assert.deepEqual(hyphen.nodes.map((n) => n.id), ["step-1", "step-2"]);
  assert.equal(ok("flowchart TD\n A-.->B").edges[0]?.style, "dotted");
  assert.equal(ok("flowchart TD\n A==>B").edges[0]?.style, "thick");
});

test("comments and styling directives are skipped, not parsed", () => {
  const d = ok(`flowchart TD
    %% this is a comment
    A --> B
    classDef big fill:#f00
    class A big
    style B stroke:#000`);
  assert.equal(d.nodes.length, 2);
  assert.equal(d.edges.length, 1);
});

test("semicolons separate statements on one line", () => {
  const d = ok("flowchart TD\n A-->B; B-->C");
  assert.equal(d.edges.length, 2);
});

test("a semicolon inside a quoted label is not a statement separator", () => {
  // Without quote-awareness, the splitter broke this into two fragments at
  // the label's own semicolon, and the second half failed to parse at all.
  const d = ok('flowchart TD\n A["Choice; pick one"] --> B[Done]');
  assert.equal(d.nodes.find((n) => n.id === "A")?.label, "Choice; pick one");
  assert.equal(d.edges.length, 1);
});

/* ------------------------------------------------------------- refusals -- */

test("another diagram type is named rather than half-read", () => {
  const got = parseMermaid("sequenceDiagram\n Alice->>John: Hello");
  assert.ok(!got.ok);
  assert.match(got.error, /sequenceDiagram/);
  assert.match(got.error, /flowchart TD/);
});

test("a subgraph says what to do instead, because the model reads this", () => {
  const got = parseMermaid("flowchart TD\n subgraph one\n A-->B\n end");
  assert.ok(!got.ok);
  assert.equal(got.line, 2);
  assert.match(got.error, /not drawn yet/);
});

test("a missing header is refused with the line that should have been one", () => {
  const got = parseMermaid("A --> B");
  assert.ok(!got.ok);
  assert.equal(got.line, 1);
  assert.match(got.error, /flowchart TD/);
});

test("an arrow pointing at nothing names the node it came from", () => {
  const got = parseMermaid("flowchart TD\n A --> ");
  assert.ok(!got.ok);
  assert.match(got.error, /`A`/);
});

test("a bad direction lists the ones that work", () => {
  const got = parseMermaid("flowchart XY\n A-->B");
  assert.ok(!got.ok);
  assert.match(got.error, /TD, TB, BT, LR or RL/);
});

test("a diagram with a direction and no nodes is refused", () => {
  const got = parseMermaid("flowchart TD");
  assert.ok(!got.ok);
  assert.match(got.error, /no nodes/);
});
