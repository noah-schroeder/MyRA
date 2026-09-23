/**
 * Placing a PRISMA 2020 figure, the same register as diagramLayout.test.ts:
 * relationships, never pixels. Exact coordinates would pin the constants
 * rather than the behaviour and would have to be rewritten the first time a
 * padding changed.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { prismaLayout } from "../src/core/prisma/layout.ts";
import { toSvg } from "../src/core/diagrams/svg.ts";
import { emptyFigure, type PrismaFigure } from "../src/core/prisma/spec.ts";
import type { PlacedNode } from "../src/core/diagrams/layout.ts";

function at(nodes: PlacedNode[], id: string): PlacedNode {
  const n = nodes.find((x) => x.id === id);
  assert.ok(n, `${id} was not placed`);
  return n;
}

function has(nodes: PlacedNode[], id: string): boolean {
  return nodes.some((n) => n.id === id);
}

const overlaps = (a: PlacedNode, b: PlacedNode): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const centreY = (n: PlacedNode): number => n.y + n.h / 2;

/** A figure with every field in a variant filled, so nothing is left blank. */
function full(variant: PrismaFigure["variant"]): PrismaFigure {
  const fig = emptyFigure(variant, "Test");
  fig.counts = {
    previousStudies: 8, previousReports: 9,
    databases: 1203, registers: 18,
    duplicates: 217, automation: 3, removedOther: 2,
    screened: 1004, recordsExcluded: 871,
    sought: 133, notRetrieved: 9,
    assessed: 124,
    includedStudies: 14, includedReports: 17,
    newStudies: 6, newReports: 7,
    totalStudies: 20, totalReports: 24,
    websites: 5, organisations: 2, citations: 11,
    otherSought: 18, otherNotRetrieved: 1, otherAssessed: 17,
  };
  fig.items = {
    reportsExcluded: [{ label: "Wrong population", n: 61 }, { label: "Wrong outcome", n: 38 }],
    otherExcluded: [{ label: "Duplicate of a database record", n: 3 }],
  };
  return fig;
}

describe("placing a PRISMA figure", () => {
  it("runs down the page in the template's order", () => {
    const l = prismaLayout(full("updated+other"));
    const y = (id: string) => at(l.nodes, id).y;
    assert.ok(y("identified") < y("screened"));
    assert.ok(y("screened") < y("sought"));
    assert.ok(y("sought") < y("assessed"));
    assert.ok(y("assessed") < y("included"));
    assert.ok(y("included") < y("total"));
  });

  it("hangs an exclusion box at its parent's own level, with a straight horizontal stub", () => {
    const l = prismaLayout(full("new"));
    const removed = at(l.nodes, "removed");
    const identified = at(l.nodes, "identified");
    assert.equal(centreY(removed), centreY(identified));
    assert.ok(removed.x > identified.x);

    const stub = l.edges.find((e) => e.from === "identified" && e.to === "removed")!;
    assert.ok(stub, "no stub drawn from identified to removed");
    assert.equal(stub.points[0]!.y, stub.points[1]!.y, "a side stub is exactly horizontal");
    assert.equal(stub.points[0]!.x, identified.x + identified.w, "leaves the parent's right edge");
    assert.equal(stub.points[1]!.x, removed.x, "arrives at the side box's left edge");
  });

  it("draws every content box the same width", () => {
    const l = prismaLayout(full("updated+other"));
    const widths = new Set(l.nodes.filter((n) => !n.id.startsWith("band")).map((n) => Math.round(n.w * 100)));
    // Titles may span wider (they cover a column and its side column), so only
    // ordinary boxes are compared here.
    const plain = l.nodes.filter((n) => n.box?.tint !== true);
    const plainWidths = new Set(plain.map((n) => Math.round(n.w * 100)));
    assert.equal(plainWidths.size, 1, [...widths].join(","));
  });

  it("overlaps nothing", () => {
    const l = prismaLayout(full("updated+other"));
    for (let i = 0; i < l.nodes.length; i++) {
      for (let j = i + 1; j < l.nodes.length; j++) {
        assert.ok(!overlaps(l.nodes[i]!, l.nodes[j]!), `${l.nodes[i]!.id} overlaps ${l.nodes[j]!.id}`);
      }
    }
  });

  it("keeps everything inside the canvas it reports", () => {
    const l = prismaLayout(full("updated+other"));
    for (const n of l.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0, `${n.id} is off the top or left`);
      assert.ok(n.x + n.w <= l.width, `${n.id} runs past the right edge`);
      assert.ok(n.y + n.h <= l.height, `${n.id} runs past the bottom`);
    }
  });

  it("puts the phase bands left of everything, turned a quarter turn, and tinted", () => {
    const l = prismaLayout(full("updated+other"));
    const bands = l.nodes.filter((n) => n.id.startsWith("band"));
    assert.equal(bands.length, 3);
    const others = l.nodes.filter((n) => !n.id.startsWith("band"));
    for (const band of bands) {
      assert.ok(band.box?.turn === -90);
      assert.ok(band.box?.tint === true);
      for (const o of others) assert.ok(band.x + band.w <= o.x, `${o.id} sits left of the ${band.id} band`);
    }
  });

  it("gives the Identification band room for its own word turned on its side", () => {
    // A minimal figure -- one row's worth of content -- is exactly the case
    // where the phase would otherwise be shorter than "Identification" needs.
    const fig = emptyFigure("new", "Test");
    fig.counts = { databases: 10 };
    const l = prismaLayout(fig);
    const band = at(l.nodes, "bandIdentification");
    assert.ok(band.h >= "Identification".length * 13 * 0.58, `band.h=${band.h}`);
  });

  describe("what is left blank", () => {
    it("draws no box when every row in it is blank", () => {
      const fig = emptyFigure("new", "Test");
      fig.counts = { databases: 10, screened: 5, includedStudies: 1 };
      const l = prismaLayout(fig);
      assert.ok(!has(l.nodes, "removed"), "no duplicates/automation/other given, so no removed box");
    });

    it("links the chain past a box that is not there", () => {
      const fig = emptyFigure("new", "Test");
      fig.counts = { databases: 10, screened: 5, assessed: 3, includedStudies: 1 };
      const l = prismaLayout(fig);
      assert.ok(!has(l.nodes, "sought"), "sanity: sought really is absent");
      assert.ok(
        l.edges.some((e) => e.from === "screened" && e.to === "assessed"),
        "the chain must skip straight past the missing box",
      );
    });

    it("draws a zero that was typed, and never one that was not", () => {
      const zeroed = emptyFigure("new", "Test");
      zeroed.counts = { databases: 10, screened: 5, recordsExcluded: 0, includedStudies: 1 };
      const l1 = prismaLayout(zeroed);
      assert.ok(has(l1.nodes, "recordsExcluded"));
      assert.ok(at(l1.nodes, "recordsExcluded").lines.some((l) => /\(n = 0\)/.test(l)));

      const blank = emptyFigure("new", "Test");
      blank.counts = { databases: 10, screened: 5, includedStudies: 1 };
      const l2 = prismaLayout(blank);
      for (const n of l2.nodes) for (const line of n.lines) assert.ok(!/\(n = 0\)/.test(line));
    });

    it("drops an empty column instead of leaving a hole", () => {
      const withOther = prismaLayout(full("new+other"));
      const withoutOther = prismaLayout(full("new"));
      assert.ok(has(withOther.nodes, "otherTitle"));
      assert.ok(!has(withoutOther.nodes, "otherTitle"));
      assert.ok(
        withoutOther.width < withOther.width,
        "a figure with no other-methods column must not reserve its space",
      );
    });

    it("drops an empty reason row but keeps the ones typed", () => {
      const fig = emptyFigure("new", "Test");
      fig.counts = { databases: 10, screened: 5, assessed: 3, includedStudies: 1 };
      fig.items = { reportsExcluded: [{ label: "Wrong population", n: 2 }, { label: "  " }] };
      const l = prismaLayout(fig);
      const box = at(l.nodes, "reportsExcluded");
      // The box's own heading, then exactly one reason -- the blank slot cost
      // no line at all rather than an empty second bullet.
      assert.equal(box.lines.length, 2);
      assert.equal(box.lines[0], "Reports excluded:");
      assert.match(box.lines[1]!, /Wrong population/);
    });
  });

  describe("the routes the general placer cannot draw", () => {
    it("merges the other-methods column into the included box's right edge", () => {
      const l = prismaLayout(full("new+other"));
      const included = at(l.nodes, "included");
      const merge = l.edges.find((e) => e.to === "included" && e.from === "otherAssessed")!;
      assert.ok(merge, "no merge edge from otherAssessed to included");
      const last = merge.points[merge.points.length - 1]!;
      assert.equal(last.x, included.x + included.w);
      assert.equal(last.y, centreY(included));
    });

    it("runs previous studies down the margin into the total box's left edge when totals were given", () => {
      const l = prismaLayout(full("updated"));
      const total = at(l.nodes, "total");
      const edge = l.edges.find((e) => e.from === "previous")!;
      assert.ok(edge);
      const last = edge.points[edge.points.length - 1]!;
      assert.equal(last.x, total.x);
      assert.equal(edge.to, "total");
    });

    it("falls back to the included box when the totals were left blank", () => {
      const fig = emptyFigure("updated", "Test");
      fig.counts = { previousStudies: 3, databases: 10, screened: 5, newStudies: 1 };
      const l = prismaLayout(fig);
      assert.ok(!has(l.nodes, "total"));
      const edge = l.edges.find((e) => e.from === "previous")!;
      assert.equal(edge.to, "included");
    });
  });

  describe("the figure that reaches a manuscript", () => {
    it("survives toSvg with its wording intact", () => {
      const svg = toSvg(prismaLayout(full("updated")));
      // "Records removed before screening:" is 34 characters, one over this
      // box's own wrap width, so it wraps like it would in the template --
      // checked as its two wrapped lines rather than one continuous string.
      assert.ok(svg.includes("Records removed before"));
      assert.ok(svg.includes("screening:"));
      assert.ok(svg.includes("Total studies included in review"));
    });

    it("escapes a reason a person typed", () => {
      const fig = emptyFigure("new", "Test");
      fig.counts = { databases: 10, screened: 5, assessed: 3, includedStudies: 1 };
      fig.items = { reportsExcluded: [{ label: "Dose & duration wrong", n: 4 }] };
      const svg = toSvg(prismaLayout(fig));
      assert.ok(svg.includes("Dose &amp; duration wrong"));
      assert.ok(!/Dose & duration/.test(svg), "a raw ampersand must not reach the file");
    });

    it("draws a square-cornered box for PRISMA, unlike a model's rounded one", () => {
      const svg = toSvg(prismaLayout(full("new")));
      assert.ok(!svg.includes(" Q "), "no rounded-corner command in a PRISMA figure");
    });

    it("left-aligns a captioned box and centres an uncaptioned one", () => {
      const l = prismaLayout(full("new"));
      const identified = at(l.nodes, "identified"); // captioned: "Records identified from:"
      const screened = at(l.nodes, "screened"); // uncaptioned: single count
      assert.equal(identified.box?.inset, 12);
      assert.equal(screened.box?.inset, undefined);
    });
  });
});
