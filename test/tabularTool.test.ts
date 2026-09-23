/**
 * The tool, whose job is mostly to refuse well -- and to prove it never asks
 * the model for a number.
 *
 * `ToolResult.content` is what the model reads, so a refusal here IS the
 * repair loop -- the same shape create_diagram already uses for a Mermaid
 * syntax error.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createTableTool, resetTableIds, setDataHost, setTableWatcher, type TableUpdate,
} from "../src/core/agent/tools/table.ts";

const ctx = {} as never;
const run = (params: Record<string, unknown>) => createTableTool.handler(params, ctx);

/**
 * The whole point of this design, checked directly: nothing in the schema,
 * at any depth, is typed as a number. If the numbers cannot occupy an
 * argument slot, a model cannot transcribe them wrong -- there is no other
 * route the actual values could reach a tool call by.
 */
function schemaHasNoNumericLeaf(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return true;
  const obj = schema as Record<string, unknown>;
  if (obj["type"] === "number" || obj["type"] === "integer") return false;
  return Object.values(obj).every((v) =>
    Array.isArray(v) ? v.every(schemaHasNoNumericLeaf) : schemaHasNoNumericLeaf(v),
  );
}

test("no property in create_table's schema, at any depth, can carry a number", () => {
  assert.ok(schemaHasNoNumericLeaf(createTableTool.parameters));
});

test("create_table's only required argument is data_id -- a reference, not data", () => {
  assert.deepEqual(createTableTool.parameters.required, ["data_id"]);
  assert.equal(createTableTool.parameters.additionalProperties, false);
});

test("it is safe, because nothing it does touches a disk", () => {
  assert.equal(createTableTool.risk, "safe");
});

test("a table built from real data is announced to whatever is showing them", async () => {
  resetTableIds();
  setDataHost(async (id) => (id === "d1" ? { name: "results.tsv", text: "A\tB\n1\t2\n3\t4" } : undefined));
  const seen: TableUpdate[] = [];
  setTableWatcher((t) => seen.push(t));
  try {
    const res = await run({ data_id: "d1", title: "Results" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.title, "Results");
    assert.equal(seen[0]?.id, "table-1");
    assert.equal(seen[0]?.table.rows.length, 2);
    assert.match(res.content, /2 columns and 2 rows/);
    assert.match(res.content, /"results\.tsv"/);
  } finally {
    setDataHost(undefined);
    setTableWatcher(undefined);
  }
});

test("a missing data_id names itself rather than a generic failure", async () => {
  setDataHost(async () => undefined);
  try {
    const res = await run({ data_id: "nope" });
    assert.match(res.content, /no data attachment/i);
    assert.match(res.content, /"nope"/);
  } finally {
    setDataHost(undefined);
  }
});

test("an empty data_id is refused without pretending to look one up", async () => {
  const res = await run({ data_id: "" });
  assert.match(res.content, /No data_id was given/);
});

test("a parse failure becomes the tool result, naming the row -- the repair loop", async () => {
  // Row 2 is the ragged one -- one cell where the header has two.
  setDataHost(async () => ({ name: "bad.tsv", text: "A\tB\n3\n1\t2" }));
  try {
    const res = await run({ data_id: "d1" });
    assert.match(res.content, /Row 2/);
    assert.match(res.content, /not something to retry with different arguments/i);
  } finally {
    setDataHost(undefined);
  }
});

test("nothing is announced when the data did not parse", async () => {
  setDataHost(async () => ({ name: "bad.tsv", text: "A\tB\n3\n1\t2" }));
  const seen: TableUpdate[] = [];
  setTableWatcher((t) => seen.push(t));
  try {
    await run({ data_id: "d1" });
    assert.equal(seen.length, 0, "a table that did not parse must not reach the panel");
  } finally {
    setDataHost(undefined);
    setTableWatcher(undefined);
  }
});

test("choosing columns by name subsets and reorders, without touching the parse", async () => {
  setDataHost(async () => ({ name: "t.tsv", text: "A\tB\tC\n1\t2\t3\n4\t5\t6" }));
  const seen: TableUpdate[] = [];
  setTableWatcher((t) => seen.push(t));
  try {
    await run({ data_id: "d1", columns: ["C", "A"] });
    assert.deepEqual(seen[0]?.table.columns.map((c) => c.name), ["C", "A"]);
    assert.equal(seen[0]?.table.rows[0]![0]!.value, 3);
    assert.equal(seen[0]?.table.rows[0]![1]!.value, 1);
  } finally {
    setDataHost(undefined);
    setTableWatcher(undefined);
  }
});

test("an unknown column name is refused and lists what does exist", async () => {
  setDataHost(async () => ({ name: "t.tsv", text: "A\tB\n1\t2" }));
  try {
    const res = await run({ data_id: "d1", columns: ["Z"] });
    assert.match(res.content, /no column named "Z"/);
    assert.match(res.content, /"A", "B"/);
    assert.match(res.content, /call create_table again/i);
  } finally {
    setDataHost(undefined);
  }
});

test("with no host installed, every data_id resolves to nothing rather than throwing", async () => {
  const res = await run({ data_id: "anything" });
  assert.match(res.content, /no data attachment/i);
});

test("style defaults to booktabs and is carried through to the update", async () => {
  setDataHost(async () => ({ name: "t.tsv", text: "A\n1" }));
  const seen: TableUpdate[] = [];
  setTableWatcher((t) => seen.push(t));
  try {
    await run({ data_id: "d1" });
    assert.equal(seen[0]?.style, "booktabs");
    await run({ data_id: "d1", style: "siunitx" });
    assert.equal(seen[1]?.style, "siunitx");
    await run({ data_id: "d1", style: "nonsense" });
    assert.equal(seen[2]?.style, "booktabs", "an unrecognised style falls back rather than erroring");
  } finally {
    setDataHost(undefined);
    setTableWatcher(undefined);
  }
});

test("the model is told not to repeat the table in its reply", async () => {
  setDataHost(async () => ({ name: "t.tsv", text: "A\n1" }));
  try {
    const res = await run({ data_id: "d1" });
    assert.match(res.content, /Do not repeat the table in your reply/);
  } finally {
    setDataHost(undefined);
  }
});

test("ids advance, so a redraw is a new table rather than a silent overwrite", async () => {
  resetTableIds();
  setDataHost(async () => ({ name: "t.tsv", text: "A\n1" }));
  const seen: TableUpdate[] = [];
  setTableWatcher((t) => seen.push(t));
  try {
    await run({ data_id: "d1" });
    await run({ data_id: "d1" });
    assert.deepEqual(seen.map((t) => t.id), ["table-1", "table-2"]);
  } finally {
    setDataHost(undefined);
    setTableWatcher(undefined);
  }
});
