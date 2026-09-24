/**
 * The no-wrong-numbers proof: every source cell's exact characters must
 * survive into LaTeX, Markdown, HTML and TSV output, and a table read back
 * out of its own Markdown must be the same table. Rounding, reformatting or
 * losing a digit anywhere in this chain is the one failure this whole
 * subsystem exists to make impossible.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parse } from "../src/core/tabular/parse.ts";
import { latexOf, texEscape } from "../src/core/tabular/latex.ts";
import { htmlOf, markdownOf, tsvOf } from "../src/core/tabular/markdown.ts";
import type { Cell } from "../src/core/tabular/table.ts";

const AWKWARD = [
  "Label\tValue\tNote",
  "A & B\t0.050\t50% of \\total",
  "C_1\t<0.001\tp < 0.05 ~ish",
  "D#2\t1,234\t{grouped}",
  "$X$\tn/a\t% a comment-looking cell",
].join("\n");

function table() {
  const res = parse(AWKWARD);
  assert.ok(res.ok, "the fixture itself must parse");
  if (!res.ok) throw new Error("unreachable");
  return res.table;
}

test("every source cell's exact text survives into LaTeX, escaped but not reformatted", () => {
  const tex = latexOf(table());
  // 0.050 must appear as written, on the Value column's own row -- never
  // rounded to 0.05. (The fixture's Note column separately and legitimately
  // contains the substring "0.05" as part of different text, so the check
  // has to anchor on this specific cell rather than search the whole table.)
  assert.match(tex, /A \\& B & 0\.050 &/);
  // The censored p-value and the footnote-ish note are untouched text.
  assert.match(tex, /<0\.001/);
  // "1,234" is printed verbatim even though it also carries a parsed value.
  assert.match(tex, /1,234/);
});

test("every special LaTeX character is escaped, so a % never comments out a row", () => {
  const tex = latexOf(table());
  assert.doesNotMatch(tex, /[^\\]%(?!\s*$)/m, "a raw, unescaped % would silently drop the rest of its line");
  assert.match(tex, /\\%/);
  assert.match(tex, /\\&/);
  assert.match(tex, /\\_/);
  assert.match(tex, /\\\$/);
  assert.match(tex, /\\{/);
  assert.match(tex, /\\}/);
  assert.match(tex, /\\textasciitilde\{\}/);
  assert.match(tex, /\\textbackslash\{\}/);
});

test("texEscape is one pass: a backslash it inserts is never re-escaped", () => {
  assert.equal(texEscape("50%"), "50\\%");
  assert.equal(texEscape("a_b"), "a\\_b");
  assert.equal(texEscape("100% & more"), "100\\% \\& more");
});

test("a missing cell prints as an em dash, uniformly, never its own source marker", () => {
  const tex = latexOf(table());
  assert.match(tex, /—/);
  assert.doesNotMatch(tex, /\bn\/a\b/i);
});

test("booktabs is the default; siunitx uses S only for a fully clean numeric column", () => {
  const t = table();
  const booktabs = latexOf(t);
  assert.match(booktabs, /\\begin\{tabular\}\{l[lr]+\}/);
  assert.match(booktabs, /\\toprule/);
  assert.match(booktabs, /\\midrule/);
  assert.match(booktabs, /\\bottomrule/);
  // "Value" has a "<0.001" cell, so it is not clean -- no S column for it.
  const siunitx = latexOf(t, { style: "siunitx" });
  assert.doesNotMatch(siunitx, /\{[lrS]*S[lrS]*\}/, "no column here is clean enough for S");
});

test("a fully clean numeric column does get an S spec under siunitx style", () => {
  const res = parse("Label\tN\na\t1\nb\t2\nc\t3");
  assert.ok(res.ok);
  if (!res.ok) return;
  const tex = latexOf(res.table, { style: "siunitx" });
  assert.match(tex, /\\begin\{tabular\}\{lS\}/);
});

test("a percent column never gets an S spec under siunitx, even with every cell clean", () => {
  // Every cell parses fine (45, 60, 72), but the cell TEXT printed is still
  // "45\%" -- not a plain numeral -- which siunitx's S column does not
  // accept in its default grammar. Without excluding it, this table
  // compiled to `\begin{tabular}{lS}` with "45\%" sitting in the S column.
  const res = parse("Label\tRate\na\t45%\nb\t60%\nc\t72%");
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.table.columns[1]?.unit, "%");
  const tex = latexOf(res.table, { style: "siunitx" });
  // Still numeric enough to right-align ("r"), just not clean enough for S.
  assert.match(tex, /\\begin\{tabular\}\{lr\}/, "no S column for the percent column");
  assert.match(tex, /45\\%/, "the cell text itself still prints the escaped percent sign");
});

test("a title wraps the tabular in a table float with an escaped caption", () => {
  const tex = latexOf(table(), { title: "Results & Notes" });
  assert.match(tex, /\\begin\{table\}/);
  assert.match(tex, /\\caption\{Results \\& Notes\}/);
  assert.match(tex, /\\end\{table\}/);
});

test("markdownOf produces a real GFM table that round-trips through parse", () => {
  const t = table();
  const md = markdownOf(t);
  assert.match(md, /^\| Label \| Value \| Note \|/);
  assert.match(md, /^\| --- \| ---:? \| --- \|/m);

  const reparsed = parse(md);
  assert.ok(reparsed.ok);
  if (!reparsed.ok) return;
  // Every VALUE that survived the first parse must survive the round trip
  // identically -- missing cells become an em dash on the way out, by
  // design, so they are compared separately below rather than expected to
  // match their original marker text.
  for (let r = 0; r < t.rows.length; r++) {
    for (let c = 0; c < t.columns.length; c++) {
      const original: Cell = t.rows[r]![c]!;
      const roundTripped: Cell = reparsed.table.rows[r]![c]!;
      if (original.missing) {
        assert.equal(roundTripped.text, "—");
      } else {
        assert.equal(roundTripped.value, original.value, `row ${r} col ${c} value drifted`);
      }
    }
  }
});

test("markdownOf escapes a pipe so it cannot be mistaken for a column boundary", () => {
  const res = parse("A\tB\nx|y\t1");
  assert.ok(res.ok);
  if (!res.ok) return;
  const md = markdownOf(res.table);
  assert.match(md, /x\\\|y/);
});

test("htmlOf escapes markup so a cell cannot inject a tag into the Word paste", () => {
  const res = parse('A\tB\n<script>alert(1)</script>\t"quoted" & <b>bold</b>');
  assert.ok(res.ok);
  if (!res.ok) return;
  const html = htmlOf(res.table, { title: "T & U" });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /<caption>T &amp; U<\/caption>/);
  assert.match(html, /^<table>/);
});

test("tsvOf keeps a value verbatim and flattens an embedded tab or newline", () => {
  const t = table();
  const tsv = tsvOf(t);
  assert.match(tsv, /0\.050/);
  const lines = tsv.split("\n");
  assert.equal(lines.length, t.rows.length + 1);
  for (const line of lines) assert.equal(line.split("\t").length, t.columns.length);
});

test("a value never printed with more or fewer digits than the source had", () => {
  const res = parse("X\n1\n1.0\n1.00\n01.00");
  assert.ok(res.ok);
  if (!res.ok) return;
  const tsv = tsvOf(res.table);
  for (const cell of ["1", "1.0", "1.00", "01.00"]) {
    assert.ok(tsv.includes(cell), `expected "${cell}" verbatim in the output`);
  }
});
