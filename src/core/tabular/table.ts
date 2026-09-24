/**
 * The canonical shape a pasted or dropped table is parsed into.
 *
 * One struct, read by both renderers this subsystem has (`latex.ts`,
 * `markdown.ts`) and by every chart in `core/charts/` -- the parser
 * (`parse.ts`) is where all of this feature's risk lives, and a chart is just
 * a second reader of what it produced. See parse.ts's header for what "risk"
 * means here and how this shape is built.
 *
 * The text/value split is the whole design. `text` is what was actually
 * typed or pasted -- captured once, trimmed of surrounding whitespace and
 * never touched again -- and `value` is a SEPARATE field, set only when the
 * cell is unambiguously a plain number, used only for arithmetic and for
 * plotting. Nothing in this subsystem ever writes a formatted number back
 * into `text`: a renderer that did would be free to turn 0.050 into 0.05 and
 * silently change what a results table claims.
 */

export interface Cell {
  /** Exactly the characters between delimiters, trimmed of surrounding
   *  whitespace and nothing else -- never rewritten, rounded or re-encoded.
   *  Every table and chart renderer in this app prints THIS, not `value`. */
  text: string;
  /**
   * Set only when the entire cell is a plain number and nothing else, per the
   * rules in parse.ts. `12.3*`, `<0.001`, `0.05 ± 0.01` and prose all have
   * none: a cell with no value is real data with no safe numeric reading, and
   * a consumer that needs one (a chart, a statistic) refuses by naming it
   * rather than guessing which part of the text to use.
   */
  value?: number | undefined;
  /**
   * True for a cell parse.ts recognised as a missing-data marker (`n/a`,
   * `ND`, a bare `-`/`–`/`—`, blank). Distinct from a cell that simply has no
   * value: a missing cell is data the source explicitly declared absent, so a
   * chart or statistic may drop it and report how many it dropped. A cell
   * with neither `value` nor `missing` is present but not safely numeric, and
   * dropping it silently would be excluding real data on the tool's own
   * authority -- so that case is refused instead, by the consumer that hit it.
   */
  missing?: boolean | undefined;
}

export type ColumnKind = "number" | "text";

export interface Column {
  /** The header exactly as given -- see `text` above, same rule. */
  name: string;
  /** "number" when at least one cell in the column carries a `value`, so it
   *  is offered as a candidate axis or series. A column can be "number" and
   *  still hold cells with no value (a p-value column with one "<0.001" among
   *  twenty plain numbers is still a numeric column with one refusing cell). */
  kind: ColumnKind;
  /** Pulled out of a heading like "Mass (kg)", or a column whose numbers were
   *  uniformly written with a trailing "%". Metadata only -- never subtracted
   *  from `name`, which stays verbatim. */
  unit?: string | undefined;
}

export interface DataTable {
  columns: Column[];
  /** Row-major; `rows[r]![c]` is column `c` of row `r`. Every row has exactly
   *  `columns.length` cells -- parse.ts refuses a ragged input rather than
   *  padding or truncating it, so this invariant holds for every `DataTable`
   *  that exists, not just the ones a caller happens to have checked. */
  rows: Cell[][];
}

export type ParseResult =
  | { ok: true; table: DataTable; notes: string[] }
  | {
      /** 1-based, counting the header as row 1 -- what a person sees when
       *  they count lines in what they pasted. */
      row: number;
      column?: number | undefined;
      ok: false;
      error: string;
    };

/** How many data rows a table holds -- never `table.rows.length + 1`, which
 *  would be wrong the day a caller adds a second header row. */
export function rowCount(table: DataTable): number {
  return table.rows.length;
}

/** The columns carrying at least one number, in order -- what a chart's
 *  column pickers are populated from. */
export function numericColumns(table: DataTable): Column[] {
  return table.columns.filter((c) => c.kind === "number");
}

/** A column's position by name, or -1. Column names are matched exactly,
 *  because a header is never reformatted and neither is a lookup against it. */
export function columnIndex(table: DataTable, name: string): number {
  return table.columns.findIndex((c) => c.name === name);
}

/**
 * What a renderer prints for one cell -- shared by latex.ts and markdown.ts
 * so "missing becomes an em dash, everything else is the source text
 * verbatim" is one rule rather than two copies that could drift.
 *
 * The em dash is the conventional typeset symbol for "no data", printed
 * uniformly rather than the source's own marker -- which might be "n/a" in
 * one row and "ND" in the next for the same reason -- and never blank, which
 * reads as a mistake rather than a declared absence.
 */
export function displayText(table: DataTable, r: number, c: number): string {
  const cell = table.rows[r]![c]!;
  return cell.missing ? "—" : cell.text;
}
