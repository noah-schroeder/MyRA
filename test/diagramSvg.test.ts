/**
 * The exported file, which is the artefact that reaches a manuscript.
 *
 * Escaping is the assertion that matters most here. A diagram's labels are
 * model output -- sometimes quoted from a page the model fetched -- and this
 * file is built by concatenating strings, where React would have escaped for
 * nothing. `Markdown.tsx` makes the same promise on the other side of the app.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseMermaid } from "../src/core/diagrams/mermaid.ts";
import { layoutDiagram } from "../src/core/diagrams/layout.ts";
import { arrowHead, dashFor, hasShadow, nodePath, toSvg, xmlEscape, PAPER_THEME } from "../src/core/diagrams/svg.ts";

function svgOf(src: string): string {
  const parsed = parseMermaid(src);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return toSvg(layoutDiagram(parsed.diagram));
}

test("a label that looks like markup becomes text, never an element", () => {
  const svg = svgOf('flowchart TD\n A["<script>alert(1)</script>"] --> B');
  assert.ok(!svg.includes("<script>"), "no raw script element reaches the file");
  assert.ok(svg.includes("&lt;script&gt;"));
});

test("every XML metacharacter is escaped", () => {
  assert.equal(xmlEscape(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
  // Ampersand first, or the escapes escape each other's ampersands.
  assert.equal(xmlEscape("&lt;"), "&amp;lt;");
});

test("an edge label is escaped too, not only a node's", () => {
  const svg = svgOf('flowchart TD\n A -->|"a & b"| B');
  assert.ok(svg.includes("a &amp; b"));
});

test("the file is a standalone SVG with a real size", () => {
  const svg = svgOf("flowchart TD\n A[One] --> B[Two]");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.ok(svg.trimEnd().endsWith("</svg>"));
});

test("the export is light whatever the app's theme, because a figure goes on paper", () => {
  const svg = svgOf("flowchart TD\n A --> B");
  assert.ok(svg.includes(`fill="${PAPER_THEME.background}"`), "an opaque white ground");
  assert.equal(PAPER_THEME.background, "#ffffff");
});

test("an arrowless link gets no arrowhead", () => {
  const solid = layoutDiagram(
    (parseMermaid("flowchart TD\n A --- B") as { ok: true; diagram: never }).diagram,
  );
  assert.equal(arrowHead(solid.edges[0]!), undefined);
});

test("a dotted edge is dashed and a plain one is not", () => {
  assert.ok(dashFor("dotted"));
  assert.equal(dashFor("solid"), undefined);
  assert.equal(dashFor("thick"), undefined);
});

test("every node in the diagram is drawn", () => {
  const svg = svgOf("flowchart TD\n A[Alpha] --> B[Beta] --> C[Gamma]");
  for (const label of ["Alpha", "Beta", "Gamma"]) assert.ok(svg.includes(label), `${label} missing`);
  assert.equal((svg.match(/<path d="M/g) ?? []).length >= 3, true);
});

test("a model's diagram draws exactly as it did before boxes had a style", () => {
  // layoutDiagram never sets `box`, so this is the promise BoxStyle made,
  // stated out loud rather than left to be true only by construction.
  const svg = svgOf("flowchart TD\n A[One] --> B[Two]");
  assert.ok(!svg.includes("<g transform="), "no node is rotated");
  assert.match(svg, /<text x="[\d.]+" y="[\d.]+" text-anchor="middle" fill="#/, "every label stays centred");
});

test("an ordinary node gets a soft shadow", () => {
  const svg = svgOf("flowchart TD\n A[One] --> B[Two]");
  assert.ok(svg.includes(`filter="url(#dg-shadow)"`));
  assert.ok(svg.includes("<feDropShadow"));
});

test("a categorized node gets a distinct fill, and an uncategorized sibling is untouched", () => {
  const parsed = parseMermaid("flowchart TD\n A:::warm --> B");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const layout = layoutDiagram(parsed.diagram);
  const a = layout.nodes.find((n) => n.id === "A")!;
  const b = layout.nodes.find((n) => n.id === "B")!;
  assert.equal(a.box?.category, 0);
  assert.equal(b.box, undefined);
  const svg = toSvg(layout);
  assert.ok(svg.includes(`<path d="${nodePath(a)}" fill="${PAPER_THEME.categoryFill[0]}"`));
  assert.ok(svg.includes(`<path d="${nodePath(b)}" fill="${PAPER_THEME.nodeFill}"`));
  assert.notEqual(PAPER_THEME.categoryFill[0], PAPER_THEME.nodeFill);
  assert.notEqual(PAPER_THEME.categoryFill[0], PAPER_THEME.tintFill);
});

test("a template box with radius 0 opts out of the shadow along with the rounding", () => {
  const layout = layoutDiagram(
    (parseMermaid("flowchart TD\n A[One] --> B[Two]") as { ok: true; diagram: never }).diagram,
  );
  const squared = { ...layout.nodes[0]!, box: { radius: 0 } };
  const rounded = layout.nodes[1]!;
  assert.equal(hasShadow(squared), false);
  assert.equal(hasShadow(rounded), true);
});

test("with no physical size, the output is exactly what it always was: pixels twice over", () => {
  const parsed = parseMermaid("flowchart TD\n A[One] --> B[Two]");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const layout = layoutDiagram(parsed.diagram);
  const svg = toSvg(layout);
  assert.match(svg, new RegExp(`width="${layout.width}" height="${layout.height}"`));
  assert.match(svg, new RegExp(`viewBox="0 0 ${layout.width} ${layout.height}"`));
});

test("a physical size is written in inches on the outer element, while the viewBox keeps the layout's own pixels", () => {
  const parsed = parseMermaid("flowchart TD\n A[One] --> B[Two]");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const layout = layoutDiagram(parsed.diagram);
  const svg = toSvg(layout, undefined, { widthIn: 9, heightIn: 6.5 });
  assert.match(svg, /width="9in" height="6\.5in"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${layout.width} ${layout.height}"`));
});
