/**
 * Placing a flowchart, which has to happen with no DOM to measure against.
 *
 * The assertions are about relationships rather than pixels -- that a child
 * sits below its parent, that nothing overlaps, that the canvas contains what
 * is on it. Exact coordinates would pin the constants instead of the behaviour
 * and would have to be rewritten the first time a padding changed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseMermaid } from "../src/core/diagrams/mermaid.ts";
import {
  assignCategoryColors, CATEGORY_PALETTE_SIZE, layoutDiagram, rankNodes, wrapLabel, type PlacedNode,
} from "../src/core/diagrams/layout.ts";

function laid(src: string) {
  const parsed = parseMermaid(src);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return layoutDiagram(parsed.diagram);
}

const at = (l: { nodes: PlacedNode[] }, id: string): PlacedNode => {
  const n = l.nodes.find((x) => x.id === id);
  assert.ok(n, `${id} was not placed`);
  return n;
};

const overlaps = (a: PlacedNode, b: PlacedNode): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("a chain runs down the page, each step below the last", () => {
  const l = laid("flowchart TD\n A[One] --> B[Two] --> C[Three]");
  assert.ok(at(l, "A").y < at(l, "B").y);
  assert.ok(at(l, "B").y < at(l, "C").y);
});

test("LR runs across instead, and nothing moves down", () => {
  const l = laid("flowchart LR\n A[One] --> B[Two]");
  assert.ok(at(l, "A").x < at(l, "B").x);
  assert.equal(at(l, "A").y, at(l, "B").y);
});

test("BT reverses the flow without reversing the edges", () => {
  const l = laid("flowchart BT\n A[One] --> B[Two]");
  assert.ok(at(l, "A").y > at(l, "B").y, "A is drawn below B");
  assert.equal(l.edges[0]?.from, "A", "but the edge still runs A to B");
});

test("branches of a decision sit side by side, not on top of each other", () => {
  const l = laid("flowchart TD\n A{Eligible?} -->|yes| B[Include]\n A -->|no| C[Exclude]");
  assert.equal(at(l, "B").y, at(l, "C").y);
  assert.ok(!overlaps(at(l, "B"), at(l, "C")));
});

test("no two nodes overlap in a diagram with several branches", () => {
  const l = laid(`flowchart TD
    A[Records] --> B{Screen}
    B -->|include| C[Full text]
    B -->|exclude| D[Excluded]
    C --> E{Eligible}
    E -->|yes| F[Included]
    E -->|no| G[Excluded at full text]`);
  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++) {
      assert.ok(!overlaps(l.nodes[i]!, l.nodes[j]!), `${l.nodes[i]!.id} overlaps ${l.nodes[j]!.id}`);
    }
  }
});

test("a node reachable by two paths is ranked below the longer of them", () => {
  /* Shortest-path ranking would put D beside C and draw an edge sideways
     within a rank, which is the whole reason the rank is the longest path. */
  const r = rankNodes({
    direction: "TD",
    nodes: ["A", "B", "C", "D"].map((id) => ({ id, label: id, shape: "rect" as const })),
    edges: [
      { from: "A", to: "B", style: "solid", arrow: true },
      { from: "B", to: "C", style: "solid", arrow: true },
      { from: "C", to: "D", style: "solid", arrow: true },
      { from: "A", to: "D", style: "solid", arrow: true },
    ],
  });
  assert.equal(r.get("D"), 3);
});

test("a cycle is drawn rather than hanging the layout", () => {
  const l = laid("flowchart TD\n A --> B\n B --> C\n C --> A");
  assert.equal(l.nodes.length, 3);
  assert.equal(l.edges.length, 3);
});

test("every node fits inside the canvas the layout reports", () => {
  const l = laid("flowchart TD\n A[A rather long label that will wrap onto two lines] --> B[Short]");
  for (const n of l.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0, `${n.id} is off the top or left`);
    assert.ok(n.x + n.w <= l.width, `${n.id} runs past the right edge`);
    assert.ok(n.y + n.h <= l.height, `${n.id} runs past the bottom`);
  }
});

test("an edge starts on its source and ends on its target", () => {
  const l = laid("flowchart TD\n A[One] --> B[Two]");
  const e = l.edges[0]!;
  const a = at(l, "A");
  const b = at(l, "B");
  const first = e.points[0]!;
  const last = e.points[e.points.length - 1]!;
  assert.equal(first.y, a.y + a.h, "leaves the bottom of A");
  assert.equal(last.y, b.y, "arrives at the top of B");
});

test("a label wraps on spaces and honours an explicit break", () => {
  assert.deepEqual(wrapLabel("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapLabel("Identification<br/>of studies"), ["Identification", "of studies"]);
  // A word longer than the wrap width is kept whole rather than cut mid-word.
  assert.deepEqual(wrapLabel("supercalifragilistic", 8), ["supercalifragilistic"]);
});

test("a diamond is given room for text its slanted sides would clip", () => {
  const l = laid("flowchart TD\n A[Screened] --> B{Screened}");
  assert.ok(at(l, "B").w > at(l, "A").w);
  assert.ok(at(l, "B").h > at(l, "A").h);
});

test("categories are assigned palette slots in first-appearance order", () => {
  const d = (parseMermaid(
    "flowchart TD\n A:::warm --> B:::cool --> C:::warm",
  ) as { ok: true; diagram: never }).diagram;
  const { colorOf, overflow } = assignCategoryColors(d);
  assert.equal(colorOf.get("warm"), 0);
  assert.equal(colorOf.get("cool"), 1);
  assert.deepEqual(overflow, []);
});

test("a category beyond the palette cap is reported, never recycled onto another one", () => {
  const names = Array.from({ length: CATEGORY_PALETTE_SIZE + 2 }, (_, i) => `cat${i}`);
  const src = `flowchart TD\n${names.map((n, i) => ` N${i}:::${n}`).join("\n")}`;
  const d = (parseMermaid(src) as { ok: true; diagram: never }).diagram;
  const { colorOf, overflow } = assignCategoryColors(d);
  assert.equal(colorOf.size, CATEGORY_PALETTE_SIZE);
  assert.deepEqual(overflow, names.slice(CATEGORY_PALETTE_SIZE));
  assert.deepEqual(new Set(colorOf.values()), new Set([0, 1, 2, 3, 4, 5]));
});

test("layoutDiagram sets box.category for a grouped node and leaves an ungrouped one untouched", () => {
  const l = laid("flowchart TD\n A:::warm --> B");
  assert.equal(at(l, "A").box?.category, 0);
  assert.equal(at(l, "B").box, undefined);
});

test("a poster layout of the same source is roomier, and only a named look is carried", async () => {
  const { LOOKS } = await import("../src/core/diagrams/styles.ts");
  const parsed = parseMermaid("flowchart TD\n A[Search databases] --> B[Screen titles] --> C[Include]");
  assert.ok(parsed.ok);
  const standard = layoutDiagram(parsed.diagram);
  const poster = layoutDiagram(parsed.diagram, LOOKS.poster);
  assert.ok(poster.width > standard.width && poster.height > standard.height);
  assert.equal("look" in standard, false);
  assert.equal(poster.look?.name, "poster");
});
