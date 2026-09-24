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

test("comments and click lines are skipped, and colour lines add no nodes or edges", () => {
  const d = ok(`flowchart TD
    %% this is a comment
    A --> B
    classDef big fill:#f00
    style B stroke:#000
    linkStyle 0 stroke:#000
    click A "https://example.com"`);
  assert.equal(d.nodes.length, 2);
  assert.equal(d.edges.length, 1);
  assert.equal(d.nodes[0]?.category, undefined);
});

/* --------------------------------------------------------------- colours -- */

test("classDef colours the nodes in its class, style one node, and style wins", () => {
  const d = ok(`flowchart TD
    A:::warm --> B:::warm --> C
    classDef warm fill:#f96,stroke:#333,stroke-width:3px
    style B fill:lightblue`);
  const paint = (id: string) => d.nodes.find((n) => n.id === id)?.paint;
  assert.deepEqual(paint("A"), { fill: "#ff9966", stroke: "#333333", strokeWidth: 3 });
  // style overrides the class field by field, keeping what it did not name.
  assert.deepEqual(paint("B"), { fill: "#add8e6", stroke: "#333333", strokeWidth: 3 });
  assert.equal(paint("C"), undefined);
});

test("classDef default sits under everything else", () => {
  const d = ok(`flowchart TD
    A --> B:::hot
    classDef default fill:#eeeeee,stroke:#000
    classDef hot fill:red`);
  assert.deepEqual(d.nodes.find((n) => n.id === "A")?.paint, { fill: "#eeeeee", stroke: "#000000" });
  assert.deepEqual(d.nodes.find((n) => n.id === "B")?.paint, { fill: "#ff0000", stroke: "#000000" });
});

test("a class defined before it is assigned still applies", () => {
  const d = ok("flowchart TD\n classDef done fill:#0a0\n A --> B\n class B done");
  assert.equal(d.nodes.find((n) => n.id === "B")?.paint?.fill, "#00aa00");
});

test("linkStyle colours edges by position, over linkStyle default", () => {
  const d = ok(`flowchart LR
    A --> B --> C
    linkStyle 1 stroke:#c62828,color:#c62828
    linkStyle default stroke:gray,stroke-width:2px`);
  assert.deepEqual(d.edges[0]?.paint, { stroke: "#808080", strokeWidth: 2 });
  assert.deepEqual(d.edges[1]?.paint, { stroke: "#c62828", strokeWidth: 2, text: "#c62828" });
});

test("a colour that is not one is dropped and named, and the diagram is still drawn", () => {
  const got = parseMermaid('flowchart TD\n A --> B\n style A fill:url(#x),stroke:"red" onload="x"');
  assert.ok(got.ok);
  assert.equal(got.diagram.nodes[0]?.paint, undefined);
  assert.equal(got.warnings?.length, 2);
  assert.match(got.warnings![0]!, /Line 3: `url\(#x\)` is not a colour/);
});

test("style naming a missing node, and linkStyle past the last edge, are warnings", () => {
  const got = parseMermaid("flowchart TD\n A --> B\n style Z fill:red\n linkStyle 4 stroke:red");
  assert.ok(got.ok);
  assert.equal(got.diagram.nodes.length, 2);
  assert.match(got.warnings![0]!, /`style Z` names a node that is not in the diagram/);
  assert.match(got.warnings![1]!, /this diagram has 1/);
});

test("a diagram with no colour lines carries no paint and no warnings", () => {
  const got = parseMermaid("flowchart TD\n A:::x --> B");
  assert.ok(got.ok);
  assert.equal("warnings" in got, false);
  assert.equal(got.diagram.nodes.some((n) => "paint" in n), false);
  assert.equal(got.diagram.edges.some((e) => "paint" in e), false);
});

test("a `class` statement groups the nodes it names", () => {
  const d = ok("flowchart TD\n A --> B --> C\n class A,B warm");
  assert.equal(d.nodes.find((n) => n.id === "A")?.category, "warm");
  assert.equal(d.nodes.find((n) => n.id === "B")?.category, "warm");
  assert.equal(d.nodes.find((n) => n.id === "C")?.category, undefined);
});

test("the `:::name` shorthand groups a node inline, with or without a bracket label", () => {
  const bracketed = ok("flowchart TD\n A[Screen]:::warm --> B[Done]");
  assert.equal(bracketed.nodes.find((n) => n.id === "A")?.category, "warm");
  const bare = ok("flowchart TD\n A:::warm --> B[Done]");
  assert.equal(bare.nodes.find((n) => n.id === "A")?.category, "warm");
});

test("a category from `:::` or `class` survives whichever order the node is otherwise built in", () => {
  // class before the node is declared...
  const before = ok("flowchart TD\n class B warm\n A --> B[Screened]");
  assert.equal(before.nodes.find((n) => n.id === "B")?.category, "warm");
  // ...and a later class statement overwrites an earlier `:::` category.
  const overwritten = ok("flowchart TD\n A:::cool --> B\n class A warm");
  assert.equal(overwritten.nodes.find((n) => n.id === "A")?.category, "warm");
});

test("a malformed `class` line is swallowed quietly, like the other directives beside it", () => {
  const d = ok("flowchart TD\n A --> B\n class");
  assert.equal(d.nodes.find((n) => n.id === "A")?.category, undefined);
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
