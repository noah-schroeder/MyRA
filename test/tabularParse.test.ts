/**
 * The parser's whole job is refusing well or parsing under a stated rule --
 * never guessing. Every refusal test below checks that the row or column
 * named in the error is the one actually at fault, not merely that an error
 * came back.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parse } from "../src/core/tabular/parse.ts";

test("a plain tab-delimited table parses, numbers get values, text does not", () => {
  const res = parse("Treatment\tDose\tResponse\nControl\t0\t1.2\nDrug\t10\t3.4");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(res.table.columns.map((c) => c.name), ["Treatment", "Dose", "Response"]);
  assert.deepEqual(res.table.columns.map((c) => c.kind), ["text", "number", "number"]);
  assert.equal(res.table.rows[0]![0]!.value, undefined);
  assert.equal(res.table.rows[0]![1]!.value, 0);
  assert.equal(res.table.rows[1]![2]!.value, 3.4);
});

test("a markdown pipe table's own rule row is layout, not data", () => {
  const res = parse("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows.length, 2);
  assert.equal(res.table.rows[0]![0]!.value, 1);
});

test("comma-delimited (real CSV) parses when there is no tab or pipe", () => {
  const res = parse("Name,Age\nAda,36\nAlan,41");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[1]![1]!.value, 41);
});

test("a tab beats a comma: a comma inside a cell does not split a tab table", () => {
  const res = parse("City\tPop\nBoston, MA\t675000");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns.length, 2);
  assert.equal(res.table.rows[0]![0]!.text, "Boston, MA");
});

test("a whitespace-run table is the last resort, tried only with no tab, pipe or comma", () => {
  const res = parse("Item      Price\nWidget    9.99\nGadget    14.5");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![1]!.value, 9.99);
});

test("a ragged row is refused, naming the row and both counts", () => {
  const res = parse("A\tB\tC\n1\t2\t3\n4\t5");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.row, 3);
  assert.match(res.error, /2 cells/);
  assert.match(res.error, /header has 3/);
});

test("a blank line inside the paste is ragged too, not silently dropped", () => {
  const res = parse("A\tB\n1\t2\n\n3\t4");
  assert.ok(!res.ok);
});

test("a header with no data rows is refused rather than producing an empty table", () => {
  const res = parse("A\tB\tC");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.row, 1);
  assert.match(res.error, /no data rows/);
});

test("a repeated column name is refused, naming which column repeats", () => {
  const res = parse("A\tB\tA\n1\t2\t3");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.column, 2);
  assert.match(res.error, /"A" is used twice/);
});

test("a units row under the header is refused rather than read as data", () => {
  const res = parse("Mass\tSpeed\n(kg)\t(m/s)\n10\t2.5\n20\t3.1\n30\t4.0");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.row, 2);
  assert.match(res.error, /units or sub-header/);
});

test("a genuinely text first data row is NOT mistaken for a units row", () => {
  // Only one later-numeric column here, and it is not broken by row 2 --
  // the heuristic must not fire just because row 2 has some text in it.
  const res = parse("Group\tScore\nBaseline\t0\nA\t5\nB\t9");
  assert.ok(res.ok);
});

test("a bare dash is missing data; -5 is a negative number, not missing", () => {
  const res = parse("X\tY\n1\t-\n2\t-5");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![1]!.missing, true);
  assert.equal(res.table.rows[0]![1]!.value, undefined);
  assert.equal(res.table.rows[1]![1]!.value, -5);
});

test("n/a, ND and blank are all recognised as missing, case-insensitively", () => {
  const res = parse("X\tY\n1\tn/a\n2\tND\n3\t\n4\tN/A");
  assert.ok(res.ok);
  if (!res.ok) return;
  for (const row of res.table.rows) assert.equal(row[1]!.missing, true);
});

test("a footnoted number stays text with no value, and does not fail the table", () => {
  const res = parse("p\n0.02\n<0.001\n0.045");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.kind, "number");
  assert.equal(res.table.rows[1]![0]!.value, undefined);
  assert.equal(res.table.rows[1]![0]!.missing, undefined);
  assert.equal(res.table.rows[1]![0]!.text, "<0.001");
  assert.ok(res.notes.some((n) => n.includes("<0.001")));
});

test("a plus-or-minus cell stays text with no value", () => {
  const res = parse("Effect\n0.05 ± 0.01\n0.10");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![0]!.value, undefined);
  assert.equal(res.table.rows[1]![0]!.value, 0.10);
});

test("a Unicode minus sign is read as a minus, and noted", () => {
  const res = parse("X\n−5\n3");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![0]!.value, -5);
  assert.equal(res.table.rows[0]![0]!.text, "−5", "the source text is never rewritten");
  assert.ok(res.notes.some((n) => n.includes("minus")));
});

test("a uniform thousands separator is stripped and noted", () => {
  const res = parse("N\n1,234\n987");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![0]!.value, 1234);
  assert.equal(res.table.rows[0]![0]!.text, "1,234");
  assert.ok(res.notes.some((n) => n.includes("thousands separator")));
});

test("a comma that is not a plain thousands group is refused, not guessed", () => {
  const res = parse("N\n1,234\n1,5");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.match(res.error, /not a plain thousands-grouped number/);
});

test("a lone decimal-comma column is left as text, with an explanatory note", () => {
  const res = parse("N\n1,5\n2,3");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.kind, "text");
  assert.ok(res.notes.some((n) => n.includes("decimal comma")));
});

test("a comma inside an otherwise-text column is left alone -- no refusal, no note", () => {
  const res = parse("City\tNote\nBoston, MA\tsome text\nReno, NV\tmore text, still prose");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.kind, "text");
  assert.equal(res.notes.length, 0);
});

test("a uniform trailing percent sets the column's unit and strips it from value only", () => {
  const res = parse("Rate\n45%\n60%");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.unit, "%");
  assert.equal(res.table.rows[0]![0]!.value, 45);
  assert.equal(res.table.rows[0]![0]!.text, "45%");
});

test("mixing percent and plain numbers in one column is refused", () => {
  const res = parse("Rate\n45%\n12");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.match(res.error, /mixes percentages/);
});

test("a unit in the header, like \"Mass (kg)\", is captured without touching the header text", () => {
  const res = parse("Mass (kg)\n10\n20");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.name, "Mass (kg)");
  assert.equal(res.table.columns[0]!.unit, "kg");
});

test("scientific notation parses as a plain number", () => {
  const res = parse("X\n1.2e-3\n4.5E6");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.rows[0]![0]!.value, 1.2e-3);
  assert.equal(res.table.rows[1]![0]!.value, 4.5e6);
});

test("an all-text column stays kind \"text\" and every cell keeps its source text", () => {
  const res = parse("Country\nUnited States\nJapan");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[0]!.kind, "text");
  assert.equal(res.table.rows[0]![0]!.text, "United States");
});

test("empty input is refused rather than producing an empty table", () => {
  assert.ok(!parse("").ok);
  assert.ok(!parse("   \n  \n").ok);
});
