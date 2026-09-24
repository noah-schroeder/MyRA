/**
 * Whether a table column's header already states its own unit -- the
 * property that matters is not duplicating it when the header already says
 * so ("Mass (kg)"), while still showing it when the header says nothing
 * ("Response Rate" for a column detected as percent from its cells alone).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { headerUnitSuffix } from "../src/renderer/components/tableHeader.ts";

test("a header that already states its unit gets no suffix appended", () => {
  assert.equal(headerUnitSuffix({ name: "Mass (kg)", unit: "kg" }), undefined);
});

test("a percent column whose header never mentions percent gets the suffix", () => {
  assert.equal(headerUnitSuffix({ name: "Response Rate", unit: "%" }), "%");
});

test("a column with no unit at all gets no suffix", () => {
  assert.equal(headerUnitSuffix({ name: "Group" }), undefined);
});

test("a header that happens to already contain a percent sign gets no suffix", () => {
  assert.equal(headerUnitSuffix({ name: "Rate (%)", unit: "%" }), undefined);
});
