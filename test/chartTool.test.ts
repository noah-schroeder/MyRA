/**
 * The tool, whose job is mostly to refuse well -- and to prove it never asks
 * the model for a number. Mirrors tabularTool.test.ts's shape.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createChartTool, resetChartIds, setChartWatcher, type ChartUpdate } from "../src/core/agent/tools/chart.ts";
import { setDataHost } from "../src/core/agent/tools/table.ts";

const ctx = {} as never;
const run = (params: Record<string, unknown>) => createChartTool.handler(params, ctx);

function schemaHasNoNumericLeaf(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return true;
  const obj = schema as Record<string, unknown>;
  if (obj["type"] === "number" || obj["type"] === "integer") return false;
  return Object.values(obj).every((v) =>
    Array.isArray(v) ? v.every(schemaHasNoNumericLeaf) : schemaHasNoNumericLeaf(v),
  );
}

test("no property in create_chart's schema, at any depth, can carry a number", () => {
  assert.ok(schemaHasNoNumericLeaf(createChartTool.parameters));
});

test("create_chart's required arguments name columns and a kind, never a value", () => {
  assert.deepEqual(createChartTool.parameters.required, ["data_id", "kind", "y"]);
  assert.equal(createChartTool.parameters.additionalProperties, false);
});

test("it is safe, because nothing it does touches a disk", () => {
  assert.equal(createChartTool.risk, "safe");
});

test("a scatter chart with a fit line is announced and the fit is computed, never supplied", async () => {
  resetChartIds();
  setDataHost(async () => ({ name: "d.tsv", text: "Dose\tResponse\n1\t2\n2\t4\n3\t6\n4\t8" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    const res = await run({ data_id: "d1", kind: "scatter", x: "Dose", y: ["Response"], fit: true, title: "T" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, "chart-1");
    assert.equal(seen[0]?.data.kind, "scatter");
    if (seen[0]?.data.kind === "scatter") {
      assert.ok(seen[0].data.fit);
      assert.ok(Math.abs(seen[0].data.fit!.slope - 2) < 1e-9, "the slope must come from arithmetic on the real points");
    }
    assert.match(res.content, /scatter chart/);
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("an unknown column is refused and lists what does exist", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "A\tB\n1\t2" }));
  try {
    const res = await run({ data_id: "d1", kind: "scatter", x: "Bogus", y: ["B"] });
    assert.match(res.content, /no column named "Bogus"/);
    assert.match(res.content, /"A", "B"/);
  } finally {
    setDataHost(undefined);
  }
});

test("a present but unparseable cell refuses by name, naming the row and column", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "X\tY\n1\t2\n2\t<0.5\n3\t6" }));
  try {
    const res = await run({ data_id: "d1", kind: "scatter", x: "X", y: ["Y"] });
    assert.match(res.content, /Row 3/);
    assert.match(res.content, /"Y"/);
    assert.match(res.content, /"<0\.5"/);
    assert.match(res.content, /cannot silently drop or guess/);
  } finally {
    setDataHost(undefined);
  }
});

test("a missing (not merely unparseable) cell is dropped and counted, not refused", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "X\tY\n1\t2\n2\tn/a\n3\t6" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    const res = await run({ data_id: "d1", kind: "scatter", x: "X", y: ["Y"] });
    assert.equal(seen.length, 1);
    if (seen[0]?.data.kind === "scatter") assert.equal(seen[0].data.series[0]!.points.length, 2);
    assert.match(res.content, /1 row\(s\) with a missing x or y were dropped/);
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("an invalid kind is refused without guessing which one was meant", async () => {
  const res = await run({ data_id: "d1", kind: "pie", y: ["A"] });
  assert.match(res.content, /kind must be one of/);
});

test("no y column at all is refused before the data is even resolved", async () => {
  const res = await run({ data_id: "d1", kind: "scatter", y: [] });
  assert.match(res.content, /No y column/);
});

test("a bar chart error bar column is read as already-computed half-widths, never derived here", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "Group\tMean\tSD\nA\t5\t1\nB\t8\t0.5" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    await run({ data_id: "d1", kind: "bar", x: "Group", y: ["Mean"], errors: "SD" });
    assert.equal(seen[0]?.data.kind, "bar");
    if (seen[0]?.data.kind === "bar") {
      assert.equal(seen[0].data.series[0]!.points[0]!.error, 1);
      assert.equal(seen[0].data.series[0]!.points[1]!.error, 0.5);
    }
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("box plot grouped by a column partitions rows correctly", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "Group\tValue\nA\t1\nA\t2\nA\t3\nB\t9\nB\t10" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    await run({ data_id: "d1", kind: "box", x: "Group", y: ["Value"] });
    if (seen[0]?.data.kind === "box") {
      assert.deepEqual(seen[0].data.groups.map((g) => g.label), ["A", "B"]);
      assert.deepEqual(seen[0].data.groups[0]!.values, [1, 2, 3]);
      assert.deepEqual(seen[0].data.groups[1]!.values, [9, 10]);
    } else {
      assert.fail("expected a box chart");
    }
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("box plot with several y columns and no x makes one box per column", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "A\tB\n1\t10\n2\t20\n3\t30" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    await run({ data_id: "d1", kind: "box", y: ["A", "B"] });
    if (seen[0]?.data.kind === "box") {
      assert.deepEqual(seen[0].data.groups.map((g) => g.label), ["A", "B"]);
    } else {
      assert.fail("expected a box chart");
    }
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("a histogram with too few numeric values is refused rather than drawing a meaningless bin", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "X\n5" }));
  try {
    const res = await run({ data_id: "d1", kind: "histogram", y: ["X"] });
    assert.match(res.content, /too few numeric values/);
  } finally {
    setDataHost(undefined);
  }
});

test("nothing is announced when the chart could not be built", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "A\tB\n1\t2" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    await run({ data_id: "d1", kind: "scatter", x: "Nope", y: ["B"] });
    assert.equal(seen.length, 0);
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});

test("a missing data_id names itself", async () => {
  setDataHost(async () => undefined);
  try {
    const res = await run({ data_id: "gone", kind: "scatter", x: "A", y: ["B"] });
    assert.match(res.content, /no data attachment/i);
  } finally {
    setDataHost(undefined);
  }
});

test("a parse failure becomes the tool result, naming the row -- the repair loop", async () => {
  setDataHost(async () => ({ name: "bad.tsv", text: "A\tB\n3\n1\t2" }));
  try {
    const res = await run({ data_id: "d1", kind: "scatter", x: "A", y: ["B"] });
    assert.match(res.content, /Row 2/);
  } finally {
    setDataHost(undefined);
  }
});

test("the model is told not to repeat the data in its reply", async () => {
  setDataHost(async () => ({ name: "d.tsv", text: "A\tB\n1\t2" }));
  try {
    const res = await run({ data_id: "d1", kind: "line", x: "A", y: ["B"] });
    assert.match(res.content, /Do not repeat the data in your reply/);
  } finally {
    setDataHost(undefined);
  }
});

test("ids advance, so a redraw is a new figure rather than a silent overwrite", async () => {
  resetChartIds();
  setDataHost(async () => ({ name: "d.tsv", text: "A\tB\n1\t2" }));
  const seen: ChartUpdate[] = [];
  setChartWatcher((c) => seen.push(c));
  try {
    await run({ data_id: "d1", kind: "line", x: "A", y: ["B"] });
    await run({ data_id: "d1", kind: "line", x: "A", y: ["B"] });
    assert.deepEqual(seen.map((c) => c.id), ["chart-1", "chart-2"]);
  } finally {
    setDataHost(undefined);
    setChartWatcher(undefined);
  }
});
