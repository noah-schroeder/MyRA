/**
 * The PRISMA 2020 box model, pinned against the official template.
 *
 * research/prisma.ts's old prismaMermaid emitted the 2009 figure's captions --
 * "Records identified through database searching", "Full-text sources
 * retrieved and assessed" -- and a reviewer reads this figure against the
 * template they actually know. So the wording matters more here than anywhere
 * else in the diagram code, and this file pins it the way researchStages.test.ts
 * pins the pipeline's own stage list: a box renamed, dropped or added fails
 * here first.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  boxesFor, fieldsFor, fieldsIn, formSections, inVariant, parseCount, parseItems, renderItems,
  PRISMA_BOXES, PRISMA_FIELDS, PRISMA_VARIANTS,
  type PrismaBox, type PrismaField,
} from "../src/core/prisma/spec.ts";

// The exported consts keep the exact literal shape `as const satisfies` gave
// them, which is what lets PrismaBoxId etc. narrow to real id unions -- but it
// also means an entry that never declared `caption` has no such key at all,
// not merely one that reads undefined. Widened once, here, for tests that
// want to read an optional field uniformly across every entry.
const BOXES: readonly PrismaBox[] = PRISMA_BOXES;
const FIELDS: readonly PrismaField[] = PRISMA_FIELDS;

describe("the PRISMA 2020 box model", () => {
  it("names every box the four official templates do, and no others", () => {
    assert.deepEqual(
      boxesFor("new").map((b) => b.id),
      [
        "bandIdentification", "bandScreening", "bandIncluded",
        "mainTitle", "identified", "removed", "screened", "recordsExcluded",
        "sought", "notRetrieved", "assessed", "reportsExcluded", "included",
      ],
    );
    assert.deepEqual(
      boxesFor("updated").map((b) => b.id),
      [
        "bandIdentification", "bandScreening", "bandIncluded",
        "previousTitle", "mainTitleUpdated", "previous", "identified", "removed",
        "screened", "recordsExcluded", "sought", "notRetrieved", "assessed",
        "reportsExcluded", "included", "total",
      ],
    );
    assert.ok(boxesFor("new+other").map((b) => b.id).includes("otherTitle"));
    assert.ok(boxesFor("new+other").map((b) => b.id).includes("otherIdentified"));
    assert.ok(!boxesFor("new").map((b) => b.id).includes("otherIdentified"), "no other column without +other");
    assert.ok(boxesFor("updated+other").map((b) => b.id).includes("otherTitleUpdated"));
    assert.ok(!boxesFor("new+other").map((b) => b.id).includes("otherTitleUpdated"));
  });

  it("uses the 2020 template's words, not the 2009 figure's", () => {
    const captions = [...BOXES, ...FIELDS].map((b) => b.caption);
    for (const want of [
      "Records removed before screening:",
      "Records marked as ineligible by automation tools",
      "Reports sought for retrieval",
      "Reports not retrieved",
      "Reports assessed for eligibility",
      "Reports excluded, by reason",
      "Studies included in previous version of review",
      "Total studies included in review",
    ]) {
      assert.ok(captions.includes(want), `missing 2020 wording: ${want}`);
    }
    const all = captions.filter((c): c is string => c !== undefined).join(" | ");
    assert.ok(
      !/Full-text articles|through database searching|qualitative synthesis|through other sources/.test(all),
      "a 2009 caption leaked into the 2020 figure",
    );
  });

  it("adds one word for an updated review's main heading, and only that word", () => {
    const mainNew = BOXES.find((b) => b.id === "mainTitle")!.caption!;
    const mainUpdated = BOXES.find((b) => b.id === "mainTitleUpdated")!.caption!;
    assert.equal(mainUpdated, mainNew.replace("studies via", "new studies via"));
  });

  it("gives an updated review a previous column and a total box; a new one neither", () => {
    assert.ok(!boxesFor("new").some((b) => b.id === "previous" || b.id === "total"));
    assert.ok(boxesFor("updated").some((b) => b.id === "previous"));
    assert.ok(boxesFor("updated").some((b) => b.id === "total"));
  });

  it("names the included box's fields per variant: studies for new, new+total for updated", () => {
    assert.deepEqual(fieldsIn("included", "new").map((f) => f.id), ["includedStudies", "includedReports"]);
    assert.deepEqual(fieldsIn("included", "updated").map((f) => f.id), ["newStudies", "newReports"]);
    assert.deepEqual(fieldsIn("total", "updated").map((f) => f.id), ["totalStudies", "totalReports"]);
  });

  it("gives the other-methods column no screening step, because the template does not", () => {
    assert.ok(!boxesFor("new+other").some((b) => b.column === "other" && b.row === "screened"));
  });

  it("has no orphan fields: every field names a box that exists in its own variants", () => {
    for (const v of PRISMA_VARIANTS) {
      const boxIds = new Set(boxesFor(v).map((b) => b.id));
      for (const f of fieldsFor(v)) assert.ok(boxIds.has(f.box), `${v}: field ${f.id} names absent box ${f.box}`);
    }
  });

  it("has no silent boxes: every non-band, non-title box has at least one field in every variant it appears in", () => {
    for (const v of PRISMA_VARIANTS) {
      const fieldBoxes = new Set(fieldsFor(v).map((f) => f.box));
      for (const b of boxesFor(v)) {
        if (b.kind === "band" || b.kind === "title") continue;
        assert.ok(fieldBoxes.has(b.id), `${v}: box ${b.id} has no field to fill it`);
      }
    }
  });

  it("gives every box and every field a unique id", () => {
    const boxIds = PRISMA_BOXES.map((b) => b.id);
    assert.equal(new Set(boxIds).size, boxIds.length);
    const fieldIds = PRISMA_FIELDS.map((f) => f.id);
    assert.equal(new Set(fieldIds).size, fieldIds.length);
  });

  it("groups the form by phase, in template order", () => {
    const sections = formSections("updated+other");
    assert.deepEqual(sections.map((s) => s.phase), ["identification", "screening", "included"]);
    assert.ok(sections[0]!.fields.some((f) => f.id === "previousStudies"));
    assert.ok(sections[0]!.fields.some((f) => f.id === "websites"), "other-methods fields join their own phase");
  });

  it("reads a blank as unanswered and a typed zero as zero", () => {
    assert.equal(parseCount(""), undefined);
    assert.equal(parseCount("   "), undefined);
    assert.equal(parseCount("0"), 0);
    assert.equal(parseCount("1,203"), 1203);
    assert.equal(parseCount("-3"), undefined);
    assert.equal(parseCount("not a number"), undefined);
  });

  it("round-trips a reason list through parseItems and renderItems", () => {
    const items = parseItems("Wrong population (n = 12)\nNo control group\n\n");
    assert.deepEqual(items, [{ label: "Wrong population", n: 12 }, { label: "No control group" }]);
    assert.equal(renderItems(items), "Wrong population (n = 12)\nNo control group");
  });

  it("inVariant is an exact membership test, not a prefix or suffix guess", () => {
    assert.ok(inVariant(undefined, "new"));
    assert.ok(inVariant(["updated", "updated+other"], "updated+other"));
    assert.ok(!inVariant(["updated", "updated+other"], "new+other"));
    assert.ok(!inVariant(["new+other"], "updated+other"));
  });
});
