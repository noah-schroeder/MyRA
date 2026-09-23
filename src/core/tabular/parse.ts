/**
 * Text, pasted or dropped, turned into a `DataTable` -- or refused.
 *
 * This is the one place in the whole tables-and-charts subsystem where a
 * wrong guess would matter, because everything downstream (`latex.ts`,
 * `markdown.ts`, every chart in `core/charts/`) only ever reads what this
 * module wrote. So the rule throughout is the one from the design
 * conversation that started this file: **parse under a rule that is stated
 * and unambiguous, or refuse and name the row or cell** -- never the
 * confident middle ground of guessing which reading was probably meant.
 *
 * Two different kinds of "cannot parse" are kept apart on purpose:
 *
 *   **Structural ambiguity fails the whole table.** A ragged row, a repeated
 *   header, a units row mistaken for data -- these change what every OTHER
 *   cell in the table means, so there is no safe partial result to return.
 *   `ParseResult` is a discriminated union rather than a table with holes in
 *   it for exactly this reason.
 *
 *   **A single cell with no safe numeric reading does not fail the table.**
 *   `12.3*`, `<0.001`, `0.05 ± 0.01` are real data, printed verbatim by every
 *   renderer. They simply carry no `Cell.value`, and it is charts and
 *   statistics -- not this module -- that refuse when asked to compute with
 *   one. A p-value column with one censored value among twenty plain numbers
 *   is still a table; only plotting that one cell is not it.
 *
 * Unicode normalisation (a minus sign U+2212, a non-breaking space) is
 * applied to a throwaway copy used only to decide `value`. It never touches
 * `Cell.text`, which is why `parse(render(table))` round-trips exactly --
 * pinned by tabularRender.test.ts.
 */

import type { Cell, Column, DataTable, ParseResult } from "./table.ts";

type Delimiter = "tab" | "pipe" | "comma" | "space" | "none";

const MISSING = new Set(["", "n/a", "na", "n.a.", "nd", "n.d.", "none", "null"]);
/** A cell that is nothing but a dash is a common convention for "no data" --
 *  as opposed to `-5`, which is two characters and parses as a number below. */
const MISSING_DASH = new Set(["-", "–", "—"]);

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const THOUSANDS_NUMBER = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?([eE][+-]?\d+)?$/;
/** A single comma with one or two trailing digits -- the shape a European
 *  decimal comma has, and never confused with a thousands group (exactly
 *  three digits). Recognised only to explain why such a cell stayed text. */
const DECIMAL_COMMA_LIKE = /^[+-]?\d+,\d{1,2}$/;
const HEADER_UNIT = /^(.*\S)\s*\(([^()]+)\)\s*$/;
const SEPARATOR_FIELD = /^:?-+:?$/;

/** Strip a Unicode minus sign and non-breaking spaces, for numeric reading
 *  only. `Cell.text` never sees the result of this function. */
function normalise(s: string): string {
  return s.replace(/\u2212/g, "-").replace(/[\u00a0\u202f]/g, " ").trim();
}

function isMissingText(trimmed: string): boolean {
  return MISSING.has(trimmed.toLowerCase()) || MISSING_DASH.has(trimmed);
}

/** Whether a raw cell, on its own, reads as a plain number -- used only for
 *  the header/units-row heuristic below, which must not yet know about a
 *  column's thousands-comma or percent convention (that is decided per
 *  column, further down, and would be circular here). */
function looksPlainNumeric(raw: string): boolean {
  const n = normalise(raw);
  return PLAIN_NUMBER.test(n) || PLAIN_NUMBER.test(n.replace(/%$/, ""));
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

function splitPipeLine(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const fields: string[] = [];
  let field = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { field += "|"; i++; } else if (s[i] === "|") {
      fields.push(field);
      field = "";
    } else field += s[i];
  }
  fields.push(field);
  return fields;
}

function splitLine(line: string, delim: Delimiter): string[] {
  const raw =
    delim === "tab" ? line.split("\t") :
    delim === "pipe" ? splitPipeLine(line) :
    delim === "comma" ? splitCsvLine(line) :
    delim === "space" ? line.split(/ {2,}/) :
    [line];
  return raw.map((f) => f.trim());
}

/**
 * The delimiter, chosen by which one appears in the HEADER LINE specifically
 * -- not merely anywhere in the pasted text.
 *
 * That distinction is the whole rule, and it exists because of a real
 * collision: a single column of thousands-separated numbers ("1,234") has a
 * comma in every data row and none in its one-word header. Scanning the
 * whole text for a comma would call that a two-column CSV, split "1,234"
 * into "1" and "234", and refuse the table as ragged the moment a plain row
 * like "987" showed up with only one field -- silently misreading real data
 * as a structural error. The header is where a delimiter is declared, so
 * requiring it to be there before trusting it turns that collision into an
 * ordinary single-column table instead, with the thousands comma handled
 * by the column-level check further down.
 *
 * Checked in this order because a paste from a spreadsheet or a document
 * uses tab or `|` and never quotes a field, so those are tried before comma
 * is ever allowed to split a number's own thousands separator apart.
 * Presence alone decides -- once chosen, a delimiter is not abandoned
 * because the split it produces turns out ragged; that is reported as a
 * structural refusal naming the row, not silently retried with a different
 * delimiter, because a second guess after the first one produced a ragged
 * table would be exactly the guessing this module exists not to do.
 */
function detectDelimiter(headerLine: string): Delimiter {
  if (headerLine.includes("\t")) return "tab";
  if (headerLine.includes("|")) return "pipe";
  if (headerLine.includes(",")) return "comma";
  if (/ {2,}/.test(headerLine)) return "space";
  return "none";
}

/** True for a markdown table's own `---|:--:|--:` rule line, which is layout
 *  and not a header or a data row. */
function isSeparatorRow(fields: string[]): boolean {
  return fields.length > 0 && fields.every((f) => SEPARATOR_FIELD.test(f.trim()));
}

interface CellParse {
  cell: Cell;
  /** True when a Unicode minus or non-breaking space was load-bearing for a
   *  successful parse, so the table can say so once rather than per cell. */
  usedNormalisation: boolean;
  hadPercent: boolean;
  hadComma: boolean;
  thousandsShaped: boolean;
  decimalCommaShaped: boolean;
}

function parseCellNumber(raw: string): CellParse {
  const trimmed = raw;
  if (isMissingText(trimmed)) {
    return {
      cell: { text: trimmed, missing: true },
      usedNormalisation: false, hadPercent: false, hadComma: false,
      thousandsShaped: false, decimalCommaShaped: false,
    };
  }

  const n = normalise(trimmed);
  const hadPercent = n.endsWith("%");
  const withoutPercent = hadPercent ? n.slice(0, -1) : n;
  const hadComma = withoutPercent.includes(",");
  const thousandsShaped = THOUSANDS_NUMBER.test(withoutPercent);
  const decimalCommaShaped = !thousandsShaped && DECIMAL_COMMA_LIKE.test(withoutPercent);

  if (PLAIN_NUMBER.test(withoutPercent)) {
    return {
      cell: { text: trimmed, value: Number(withoutPercent) },
      usedNormalisation: n !== trimmed.trim(), hadPercent, hadComma,
      thousandsShaped, decimalCommaShaped,
    };
  }

  // Thousands-grouped: valid only once the column-level check below confirms
  // every comma-bearing cell in the column shares this exact shape.
  return {
    cell: { text: trimmed },
    usedNormalisation: n !== trimmed.trim(), hadPercent, hadComma,
    thousandsShaped, decimalCommaShaped,
  };
}

export function parse(source: string): ParseResult {
  const rawLines = source.split(/\r\n|\r|\n/);

  // Leading/trailing blank lines are noise from the paste, not the table.
  let start = 0;
  let end = rawLines.length;
  while (start < end && rawLines[start]!.trim() === "") start++;
  while (end > start && rawLines[end - 1]!.trim() === "") end--;
  const trimmedLines = rawLines.slice(start, end);

  if (!trimmedLines.length) {
    return { ok: false, row: 1, error: "There is nothing to parse." };
  }

  // The header line decides the delimiter for the whole table -- see
  // detectDelimiter's header comment for why it must be the header and not
  // the text as a whole.
  const delim = detectDelimiter(trimmedLines[0]!);

  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (s: string): void => {
    if (!noted.has(s)) { noted.add(s); notes.push(s); }
  };

  // Split every line, then drop a markdown separator row (`---|---`)
  // wherever it appears -- it is layout, never header and never data.
  const split = trimmedLines.map((l) => splitLine(l, delim));
  const lines = split.filter((f) => !(delim === "pipe" && isSeparatorRow(f)));

  if (!lines.length) {
    return { ok: false, row: 1, error: "There is nothing to parse." };
  }

  const header = lines[0]!;
  const width = header.length;
  const bodyRaw = lines.slice(1);

  if (!bodyRaw.length) {
    return {
      ok: false, row: 1,
      error: "This looks like a header with no data rows under it.",
    };
  }

  for (let i = 0; i < bodyRaw.length; i++) {
    const row = bodyRaw[i]!;
    if (row.length !== width) {
      return {
        ok: false, row: i + 2,
        error:
          `Row ${i + 2} has ${row.length} cell${row.length === 1 ? "" : "s"}; the header has ` +
          `${width}. Every row needs the same number of columns as the header.`,
      };
    }
  }

  // Duplicate column names.
  const seenNames = new Map<string, number>();
  for (let c = 0; c < header.length; c++) {
    const name = header[c]!;
    if (seenNames.has(name)) {
      return {
        ok: false, row: 1, column: c,
        error: `The column "${name}" is used twice as a header. Rename one of them and paste again.`,
      };
    }
    seenNames.set(name, c);
  }

  // A units/sub-header row: every column that is otherwise plainly numeric
  // from the SECOND data row on is broken only by the first one. Needs at
  // least two later rows as evidence -- with only one, a single footnoted or
  // thousands-separated cell in an otherwise ordinary two-row table would
  // look identical to a units row and be refused on no real evidence at all.
  if (bodyRaw.length >= 3) {
    let numericCandidates = 0;
    let brokenByFirstRow = 0;
    for (let c = 0; c < width; c++) {
      const later = bodyRaw.slice(1).map((r) => r[c]!);
      const laterIsNumeric = later.every((v) => looksPlainNumeric(v) || isMissingText(v));
      const laterHasEvidence = later.some((v) => looksPlainNumeric(v));
      if (!laterIsNumeric || !laterHasEvidence) continue;
      numericCandidates++;
      const first = bodyRaw[0]![c]!;
      if (!looksPlainNumeric(first) && !isMissingText(first)) brokenByFirstRow++;
    }
    if (numericCandidates > 0 && numericCandidates === brokenByFirstRow) {
      const shown = bodyRaw[0]!.join(delim === "tab" ? " / " : ", ");
      return {
        ok: false, row: 2,
        error:
          `Row 2 ("${shown}") looks like a units or sub-header row, not data -- every column ` +
          "that is otherwise numeric from row 3 on fails to parse only on this row. Remove it, " +
          'or fold it into the column headers (e.g. "Mass (kg)"), then paste again.',
      };
    }
  }

  // Per-column cell parsing, then the column-level comma and percent checks.
  const columns: Column[] = header.map((name) => ({ name, kind: "text" }));
  const rows: Cell[][] = bodyRaw.map(() => []);

  for (let c = 0; c < width; c++) {
    const parsedCol = bodyRaw.map((r) => parseCellNumber(r[c]!));

    const commaCells = parsedCol.filter((p) => !p.cell.missing && p.hadComma);
    if (commaCells.length) {
      const allThousands = commaCells.every((p) => p.thousandsShaped);
      const anyThousands = commaCells.some((p) => p.thousandsShaped);
      if (allThousands) {
        for (let r = 0; r < parsedCol.length; r++) {
          const p = parsedCol[r]!;
          if (p.thousandsShaped) {
            const withoutCommas = normalise(p.cell.text).replace(/%$/, "").replace(/,/g, "");
            p.cell = { text: p.cell.text, value: Number(withoutCommas) };
          }
        }
        note(`Column "${header[c]}": read "," as a thousands separator.`);
      } else if (anyThousands) {
        const bad = commaCells.find((p) => !p.thousandsShaped)!;
        // Reference equality against `parsedCol`, not a text search: two rows
        // sharing the same malformed text must not make this point at the
        // wrong one of them.
        const badRow = parsedCol.indexOf(bad);
        return {
          ok: false, row: badRow + 2, column: c,
          error:
            `The column "${header[c]}" has a comma in "${bad.cell.text}" that is not a plain ` +
            'thousands-grouped number (groups of exactly three digits, like "1,234"). Fix it, ' +
            "or split this column with a different delimiter, then paste again.",
        };
      } else if (commaCells.some((p) => p.decimalCommaShaped)) {
        const example = commaCells.find((p) => p.decimalCommaShaped)!.cell.text;
        note(
          `Column "${header[c]}" has cells such as "${example}" that look like a decimal comma -- ` +
            'kept as text; MyRA does not guess at this. Rewrite with a period (e.g. "1.5") to ' +
            "include them as numbers.",
        );
      }
    }

    const withValue = parsedCol.filter((p) => p.cell.value !== undefined);
    const withPercent = withValue.filter((p) => p.hadPercent);
    const withoutPercent = withValue.filter((p) => !p.hadPercent);
    if (withPercent.length && withoutPercent.length) {
      // Reference equality against `parsedCol`, same reason as the comma
      // case above: cite the row the example actually came from.
      const pctRow = parsedCol.indexOf(withPercent[0]!);
      return {
        ok: false, row: pctRow + 2, column: c,
        error:
          `The column "${header[c]}" mixes percentages (e.g. "${withPercent[0]!.cell.text}") ` +
          `with plain numbers (e.g. "${withoutPercent[0]!.cell.text}"). Make every numeric cell ` +
          "in the column consistent, then paste again.",
      };
    }

    const unitFromHeader = HEADER_UNIT.exec(header[c]!);
    const column: Column = {
      name: header[c]!,
      kind: withValue.length ? "number" : "text",
      ...(withPercent.length
        ? { unit: "%" }
        : unitFromHeader
          ? { unit: unitFromHeader[2]! }
          : {}),
    };
    columns[c] = column;

    if (parsedCol.some((p) => p.usedNormalisation)) {
      note(`Column "${header[c]}": read "−" or a non-breaking space as an ordinary minus/space.`);
    }

    for (let r = 0; r < parsedCol.length; r++) rows[r]![c] = parsedCol[r]!.cell;
  }

  const textNoValue: { row: number; column: string; text: string }[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < width; c++) {
      const cell = rows[r]![c]!;
      if (columns[c]!.kind === "number" && cell.value === undefined && !cell.missing) {
        textNoValue.push({ row: r + 2, column: header[c]!, text: cell.text });
      }
    }
  }
  if (textNoValue.length) {
    const first = textNoValue[0]!;
    note(
      `${textNoValue.length} cell${textNoValue.length === 1 ? "" : "s"} in numeric columns did not ` +
        `parse as a plain number (e.g. row ${first.row}, column "${first.column}": ` +
        `"${first.text}") and stayed text with no value. A chart or statistic using that cell ` +
        "will refuse rather than guess what it means.",
    );
  }

  return { ok: true, table: { columns, rows }, notes };
}
