/**
 * A `DataTable`, typeset as a LaTeX table.
 *
 * Every cell prints `Cell.text` -- the source, verbatim -- never a value
 * reformatted from `Cell.value`. This is the half of the subsystem the design
 * conversation that started it called the more dangerous one, not the safer
 * one: an unescaped `%` in a cell comments out the rest of the row, so the
 * compiled PDF silently loses columns while the .tex source looks perfect.
 * `texEscape` exists to make that unrepresentable, the same way `xmlEscape`
 * (core/diagrams/svg.ts) does for an exported diagram.
 */

import { displayText, type Column, type DataTable } from "./table.ts";

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "$": "\\$",
  "&": "\\&",
  "#": "\\#",
  "^": "\\textasciicircum{}",
  "_": "\\_",
  "%": "\\%",
  "~": "\\textasciitilde{}",
};

/**
 * Escape a cell's text for LaTeX.
 *
 * One regular expression with a replacer function, exactly as `xmlEscape`
 * does it: every matched character of the ORIGINAL string is replaced
 * independently, so there is no double-escaping to order around -- a
 * replacement's own backslash is never re-scanned, because `String.replace`
 * never looks at what it just wrote.
 */
export function texEscape(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) => ESCAPES[c] ?? c);
}

export type LatexStyle = "booktabs" | "siunitx";

/** A column may use a siunitx `S` (decimal-aligning) spec only when every one
 *  of its cells parsed to a plain value -- an `S` column fed "12.3*" or
 *  "<0.001" is a LaTeX warning or a silently broken alignment, not a
 *  gracefully degraded one.
 *
 *  A percent column fails the same way for a different reason: `cellText`
 *  prints the cell's own text verbatim, and a percent cell's text carries its
 *  own trailing "%" (see table.ts's `Column.unit`), so the printed cell reads
 *  "45\%" -- not the plain numeral `S`'s default grammar expects. Every other
 *  unit comes from the header alone ("Mass (kg)"), leaving the cell text
 *  clean, so only the percent case is excluded here. */
function isCleanNumeric(table: DataTable, c: number): boolean {
  if (table.columns[c]!.kind !== "number") return false;
  if (table.columns[c]!.unit === "%") return false;
  return table.rows.every((row) => {
    const cell = row[c]!;
    return cell.value !== undefined || cell.missing === true;
  });
}

function colSpec(table: DataTable, style: LatexStyle): string {
  return table.columns
    .map((col: Column, c) => {
      if (col.kind !== "number") return "l";
      if (style === "siunitx" && isCleanNumeric(table, c)) return "S";
      return "r";
    })
    .join("");
}

function cellText(table: DataTable, r: number, c: number): string {
  return texEscape(displayText(table, r, c));
}

/**
 * A standalone `table` environment, ready to paste into a manuscript.
 *
 * Wrapped in `table`/`\centering`/`\caption` only when a title is given --
 * otherwise just the `tabular`, for a caller who wants to place it inside
 * their own float.
 */
export function latexOf(table: DataTable, opts: { title?: string; style?: LatexStyle } = {}): string {
  const style: LatexStyle = opts.style === "siunitx" ? "siunitx" : "booktabs";
  const spec = colSpec(table, style);
  const header = table.columns.map((c) => texEscape(c.name)).join(" & ");
  const bodyRows = table.rows.map((row, r) =>
    table.columns.map((_c, c) => cellText(table, r, c)).join(" & "),
  );

  const lines: string[] = [];
  lines.push(`% Requires \\usepackage{booktabs}${style === "siunitx" ? " and \\usepackage{siunitx}" : ""}`);
  const wrap = Boolean(opts.title);
  if (wrap) {
    lines.push("\\begin{table}");
    lines.push("\\centering");
    lines.push(`\\caption{${texEscape(opts.title!)}}`);
  }
  lines.push(`\\begin{tabular}{${spec}}`);
  lines.push("\\toprule");
  lines.push(`${header} \\\\`);
  lines.push("\\midrule");
  for (const row of bodyRows) lines.push(`${row} \\\\`);
  lines.push("\\bottomrule");
  lines.push("\\end{tabular}");
  if (wrap) lines.push("\\end{table}");
  return lines.join("\n");
}
