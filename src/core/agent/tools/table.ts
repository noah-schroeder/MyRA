/**
 * A manuscript-ready table, built from data the user pasted -- never from
 * numbers the model typed.
 *
 * The whole design turns on one property, checked directly by
 * tabularTool.test.ts: **no property in this tool's schema can hold a data
 * value.** `data_id` names an attachment the composer captured verbatim when
 * it was pasted (see main/attachments.ts's `saveDataAttachment`); `columns`
 * and `style` are names and a formatting choice, never numbers. A model that
 * transcribes a results table into a JSON argument will eventually drop a
 * digit or "tidy" 0.050 into 0.05 -- so the fix is not asking it to be
 * careful, it is removing the argument slot a number could occupy at all.
 *
 * The parse can still fail -- a ragged paste, a units row mistaken for data
 * -- and when it does, `parse`'s own message (which names the row or column)
 * becomes this tool's result, exactly as `create_diagram` turns a Mermaid
 * syntax error into the repair loop the agent already runs on any failed
 * call.
 */

import type { ToolDef, ToolResult } from "../registry.ts";
import { parse } from "../../tabular/parse.ts";
import type { LatexStyle } from "../../tabular/latex.ts";
import { rowCount, type DataTable } from "../../tabular/table.ts";
import { makeIdCounter, makeWatcher } from "./artifactWatch.ts";

/** What a data attachment resolves to: the name it arrived under, for a
 *  caption default, and the pasted or dropped text itself. */
export interface DataSource {
  name: string;
  text: string;
}

let dataHost: ((id: string) => Promise<DataSource | undefined>) | undefined;

/**
 * Installed by main, closing over the current session -- the same shape
 * `setDiagramWatcher` already is, except async: resolving an id means an
 * `fs.readFile`, and unlike `resolveImage` (which has to be synchronous
 * because it runs inside the pure `buildRequest`) a tool handler is already a
 * `Promise`, so there is no reason to pre-read every attachment up front. Left
 * uninstalled, every `data_id` resolves to nothing, which is the right
 * behaviour for the test suite and for a headless run: nothing here should
 * reach into a session it was not handed.
 */
export function setDataHost(fn: ((id: string) => Promise<DataSource | undefined>) | undefined): void {
  dataHost = fn;
}

export async function resolveDataSource(id: string): Promise<DataSource | undefined> {
  return await dataHost?.(id);
}

/** A table this conversation produced, pushed at whatever is showing them --
 *  the artifact panel's counterpart to `DiagramUpdate`. */
export interface TableUpdate {
  /** Stable for the life of the conversation, so a redraw replaces its
   *  predecessor rather than stacking a second tab of the same table. */
  id: string;
  title: string;
  table: DataTable;
  notes: string[];
  /** Carried through so the panel's "Copy LaTeX" renders in the style that
   *  was actually asked for, without re-deciding it. */
  style: LatexStyle;
}

const tableWatcher = makeWatcher<TableUpdate>();

export function setTableWatcher(fn: ((table: TableUpdate) => void) | undefined): void {
  tableWatcher.set(fn);
}

const tableIds = makeIdCounter("table");

/** Reset between conversations, so ids restart with the thread -- mirrors
 *  `resetDiagramIds`, including the optional replay-seeded starting point. */
export function resetTableIds(from = 0): void {
  tableIds.reset(from);
}

function subsetColumns(table: DataTable, names: string[]): DataTable | { error: string } {
  const indices: number[] = [];
  for (const name of names) {
    const i = table.columns.findIndex((c) => c.name === name);
    if (i === -1) {
      const have = table.columns.map((c) => `"${c.name}"`).join(", ");
      return { error: `There is no column named "${name}". The columns in this data are: ${have}.` };
    }
    indices.push(i);
  }
  return {
    columns: indices.map((i) => table.columns[i]!),
    rows: table.rows.map((row) => indices.map((i) => row[i]!)),
  };
}

export const createTableTool: ToolDef = {
  name: "create_table",
  description:
    "Build a manuscript-ready table from data the user pasted or dropped into the conversation, " +
    "and show it to the user as a figure they can copy into Word or LaTeX. Give the data_id of " +
    "the data attachment to use -- never retype the numbers yourselves, this tool reads them " +
    "directly from what the user provided. Optionally choose which columns to include and in " +
    "what order, by their exact header text; omit to include all of them. Call it again with a " +
    "corrected data_id or column name if it returns an error.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      data_id: {
        type: "string",
        description: "The id of the data attachment holding the table, from the [data ...] line in the conversation.",
      },
      title: { type: "string", description: "A short caption for the table, as it would read in a paper." },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Which columns to include, in order, by their exact header text. Omit for all columns.",
      },
      style: {
        type: "string",
        description:
          "LaTeX table style: \"booktabs\" (default, works with almost every journal template) or " +
          "\"siunitx\" (additionally decimal-aligns clean numeric columns, needs the siunitx package).",
      },
    },
    required: ["data_id"],
    additionalProperties: false,
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const dataId = typeof params["data_id"] === "string" ? params["data_id"] : "";
    const title = typeof params["title"] === "string" && params["title"].trim()
      ? params["title"].trim()
      : "Table";
    const style: LatexStyle = params["style"] === "siunitx" ? "siunitx" : "booktabs";
    const columnNames = Array.isArray(params["columns"])
      ? params["columns"].filter((c): c is string => typeof c === "string")
      : undefined;

    if (!dataId.trim()) {
      return { content: "No data_id was given. Pass the id of a data attachment from this conversation." };
    }

    const source = await resolveDataSource(dataId);
    if (!source) {
      return {
        content:
          `There is no data attachment with id "${dataId}" in this conversation. Use the id from ` +
          "the [data ...] line, or ask the user to paste the table again.",
      };
    }

    const parsed = parse(source.text);
    if (!parsed.ok) {
      return {
        content:
          `"${source.name}" could not be read as a table. Row ${parsed.row}` +
          `${parsed.column !== undefined ? `, column ${parsed.column + 1}` : ""}: ${parsed.error}\n\n` +
          "This is a problem with the pasted data itself, not something to retry with different " +
          "arguments -- tell the user what is wrong so they can fix the source and paste it again.",
      };
    }

    let table = parsed.table;
    if (columnNames?.length) {
      const subset = subsetColumns(table, columnNames);
      if ("error" in subset) {
        return { content: `${subset.error} Call create_table again with corrected column names.` };
      }
      table = subset;
    }

    const id = tableIds.next();
    const notes = parsed.notes;
    tableWatcher.announce({ id, title, table, notes, style });

    const noteText = notes.length ? ` Notes on how it was read: ${notes.join(" ")}` : "";
    return {
      content:
        `Built "${title}": ${table.columns.length} columns and ${rowCount(table)} rows, from ` +
        `"${source.name}". It is shown to the user beside the conversation, where they can copy it ` +
        `for Word or LaTeX.${noteText} Do not repeat the table in your reply; say what it shows.`,
      detail: { id, title, table, notes, style },
    };
  },
};

export const TABLE_TOOL_DEFS: ToolDef[] = [createTableTool];
