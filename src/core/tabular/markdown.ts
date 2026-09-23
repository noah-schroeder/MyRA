/**
 * A `DataTable` in the three plain-interchange shapes: GitHub-Flavored
 * Markdown, a Word-pasteable HTML table, and TSV.
 *
 * Kept together, apart from `latex.ts`, because they share one escaping
 * story that LaTeX does not, and every one of them prints `displayText` --
 * the source text, verbatim -- for the same reason `latex.ts` does: nothing
 * here ever reformats a number.
 */

import { displayText, type DataTable } from "./table.ts";

/** `|` breaks a GFM table's own column count; a literal newline breaks the
 *  row. Cell.text cannot contain one from this app's own parser, but a
 *  DataTable can in principle be built by hand, so this is not skipped. */
function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A real GFM table: a header row, the `---` rule GFM requires, then the
 *  body. Numeric columns are right-aligned, matching how a scientific table
 *  is conventionally set. */
export function markdownOf(table: DataTable): string {
  const align = table.columns.map((c) => (c.kind === "number" ? "---:" : "---"));
  const header = `| ${table.columns.map((c) => mdEscape(c.name)).join(" | ")} |`;
  const rule = `| ${align.join(" | ")} |`;
  const rows = table.rows.map(
    (_row, r) => `| ${table.columns.map((_c, c) => mdEscape(displayText(table, r, c))).join(" | ")} |`,
  );
  return [header, rule, ...rows].join("\n");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * A standalone HTML `<table>`, for the clipboard's `text/html` flavour --
 * Word, Google Docs and Sheets each paste this as a real, editable table with
 * no converter involved, which is the whole reason this exists instead of a
 * pandoc round trip.
 */
export function htmlOf(table: DataTable, opts: { title?: string } = {}): string {
  const head = `<tr>${table.columns.map((c) => `<th>${htmlEscape(c.name)}</th>`).join("")}</tr>`;
  const body = table.rows
    .map((_row, r) => {
      const cells = table.columns
        .map((col, c) => {
          const align = col.kind === "number" ? ' style="text-align:right"' : "";
          return `<td${align}>${htmlEscape(displayText(table, r, c))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const caption = opts.title ? `<caption>${htmlEscape(opts.title)}</caption>` : "";
  return `<table>${caption}<thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** Tab-separated, for the clipboard's `text/plain` flavour beside the HTML
 *  one -- what a paste into Excel or Sheets falls back to when the receiving
 *  cell does not accept the HTML flavour. TSV has no quoting convention worth
 *  relying on across spreadsheet applications, so a tab or newline inside a
 *  cell is flattened to a space rather than risking a misread column. */
export function tsvOf(table: DataTable): string {
  const esc = (s: string): string => s.replace(/[\t\r\n]/g, " ");
  const header = table.columns.map((c) => esc(c.name)).join("\t");
  const rows = table.rows.map((_row, r) => table.columns.map((_c, c) => esc(displayText(table, r, c))).join("\t"));
  return [header, ...rows].join("\n");
}
