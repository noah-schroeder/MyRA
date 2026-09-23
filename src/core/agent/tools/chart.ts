/**
 * A publication figure, built from data the user pasted -- never from
 * numbers the model typed.
 *
 * Same guarantee as tools/table.ts, checked the same way in
 * chartTool.test.ts: no property in this tool's schema, at any depth, is
 * typed as a number. `data_id` names an attachment; `x`, `y`, `group` and
 * `errors` name columns; `stacked` and `fit` are booleans. There is no
 * argument slot a plotted value could occupy.
 *
 * What is computed rather than supplied, and by whom:
 *
 *   - A scatter's fit line is `core/tabular/stats.ts`'s `linearFit`, run over
 *     the actual points. The model cannot ask for a slope; it can only ask
 *     for `fit: true` and receive whatever the arithmetic produces, including
 *     "no line" when the x values do not vary.
 *   - A box's quartiles and whiskers are the same module's `quartiles`, with
 *     the standard 1.5x-IQR fence for outliers. Both travel into the LaTeX
 *     export via `pgfplots.ts`'s `boxplot prepared`, so the on-screen figure
 *     and the compiled one are guaranteed to show the same numbers.
 *
 * What a cell without a safe numeric reading does: a MISSING cell (the
 * source's own "n/a", "ND", a bare dash) is dropped and counted, because the
 * data itself declared it absent. A PRESENT cell with no value -- "12.3*",
 * "<0.001" -- is refused outright, naming the row and column, because
 * silently excluding a real, annotated value from a scientific figure is an
 * editorial decision this tool has no business making unilaterally. See
 * core/tabular/parse.ts's header for why the parser keeps these two cases
 * apart in the first place.
 */

import type { ToolDef, ToolResult } from "../registry.ts";
import { parse } from "../../tabular/parse.ts";
import { linearFit } from "../../tabular/stats.ts";
import type { Cell, DataTable } from "../../tabular/table.ts";
import { resolveDataSource } from "./table.ts";
import type { ChartKind, ChartSpec } from "../../charts/spec.ts";
import { layoutChart, type BoxGroupData, type ChartData, type Series } from "../../charts/layout.ts";
import { makeIdCounter, makeWatcher } from "./artifactWatch.ts";

export interface ChartUpdate {
  /** Stable for the life of the conversation, so a redraw replaces its
   *  predecessor rather than stacking a second tab of the same figure. */
  id: string;
  title: string;
  data: ChartData;
  spec: ChartSpec;
}

const chartWatcher = makeWatcher<ChartUpdate>();

export function setChartWatcher(fn: ((chart: ChartUpdate) => void) | undefined): void {
  chartWatcher.set(fn);
}

const chartIds = makeIdCounter("chart");

/** Reset between conversations, so ids restart with the thread -- mirrors
 *  resetDiagramIds / resetTableIds, including the optional replay-seeded
 *  starting point. */
export function resetChartIds(from = 0): void {
  chartIds.reset(from);
}

interface Refused { error: string; }
function isRefused(v: unknown): v is Refused {
  return typeof v === "object" && v !== null && "error" in v;
}

function findColumn(table: DataTable, name: string): number | Refused {
  const i = table.columns.findIndex((c) => c.name === name);
  if (i === -1) {
    const have = table.columns.map((c) => `"${c.name}"`).join(", ");
    return { error: `There is no column named "${name}". The columns in this data are: ${have}.` };
  }
  return i;
}

/** One row's reading of a numeric column: a value, "missing" (drop and
 *  count), or a refusal naming the cell -- the three-way split this whole
 *  tool exists to keep apart. */
type CellReading = { value: number } | { missing: true } | Refused;

function readNumeric(table: DataTable, r: number, c: number, columnName: string): CellReading {
  const cell: Cell = table.rows[r]![c]!;
  if (cell.missing) return { missing: true };
  if (cell.value !== undefined) return { value: cell.value };
  return {
    error:
      `Row ${r + 2}, column "${columnName}" is "${cell.text}", which is not a plain number. ` +
      "A chart cannot silently drop or guess at a real value -- fix the source cell (or remove " +
      "the row) and paste the table again, or choose a different column.",
  };
}

function buildXY(
  table: DataTable, xIdx: number, yIdx: number, errIdx: number | undefined,
): { points: { x: number; y: number; error?: number | undefined }[]; dropped: number } | Refused {
  const points: { x: number; y: number; error?: number | undefined }[] = [];
  let dropped = 0;
  for (let r = 0; r < table.rows.length; r++) {
    const x = readNumeric(table, r, xIdx, table.columns[xIdx]!.name);
    if (isRefused(x)) return x;
    const y = readNumeric(table, r, yIdx, table.columns[yIdx]!.name);
    if (isRefused(y)) return y;
    if ("missing" in x || "missing" in y) { dropped++; continue; }
    let error: number | undefined;
    if (errIdx !== undefined) {
      const e = readNumeric(table, r, errIdx, table.columns[errIdx]!.name);
      if (isRefused(e)) return e;
      if (!("missing" in e)) error = e.value;
    }
    points.push({ x: x.value, y: y.value, ...(error !== undefined ? { error } : {}) });
  }
  return { points, dropped };
}

function buildValues(table: DataTable, colIdx: number): { values: number[]; dropped: number } | Refused {
  const values: number[] = [];
  let dropped = 0;
  for (let r = 0; r < table.rows.length; r++) {
    const v = readNumeric(table, r, colIdx, table.columns[colIdx]!.name);
    if (isRefused(v)) return v;
    if ("missing" in v) { dropped++; continue; }
    values.push(v.value);
  }
  return { values, dropped };
}

/** Turn a validated spec and table into the pure numbers `layoutChart` and
 *  `pgfplotsOf` both draw from. The only place in this tool that can refuse
 *  is a cell read, above -- everything below is bookkeeping. */
function buildChartData(table: DataTable, spec: ChartSpec): { data: ChartData; dropped: number; notes: string[] } | Refused {
  const notes: string[] = [];

  if (spec.kind === "scatter" || spec.kind === "line") {
    if (!spec.x) return { error: "A scatter or line chart needs an x column." };
    if (!spec.y.length) return { error: "A scatter or line chart needs at least one y column." };
    const xIdx = findColumn(table, spec.x);
    if (isRefused(xIdx)) return xIdx;
    const errIdx = spec.errors ? findColumn(table, spec.errors) : undefined;
    if (isRefused(errIdx)) return errIdx;

    /* group restructures the series -- it is not an annotation like fit --
       so silently falling through to the plain, ungrouped branch below (the
       only other place `spec.kind === "scatter"` leads) would draw
       something other than what was asked for with nothing telling the
       model its grouping never happened. The schema names this restriction
       now too, but a model that misses it should hear about it here. */
    if (spec.kind === "scatter" && spec.group && spec.y.length !== 1) {
      return {
        error:
          `group only works with exactly one y column, but ${spec.y.length} were given. Call ` +
          "again with a single y column to use group, or remove group to plot them all ungrouped.",
      };
    }

    if (spec.kind === "scatter" && spec.group && spec.y.length === 1) {
      const groupIdx = findColumn(table, spec.group);
      if (isRefused(groupIdx)) return groupIdx;
      const yIdx = findColumn(table, spec.y[0]!);
      if (isRefused(yIdx)) return yIdx;
      const byGroup = new Map<string, { x: number; y: number; error?: number | undefined }[]>();
      let dropped = 0;
      for (let r = 0; r < table.rows.length; r++) {
        const x = readNumeric(table, r, xIdx, table.columns[xIdx]!.name);
        if (isRefused(x)) return x;
        const y = readNumeric(table, r, yIdx, table.columns[yIdx]!.name);
        if (isRefused(y)) return y;
        if ("missing" in x || "missing" in y) { dropped++; continue; }
        const label = table.rows[r]![groupIdx]!.text || "(blank)";
        let error: number | undefined;
        if (errIdx !== undefined) {
          const e = readNumeric(table, r, errIdx, table.columns[errIdx]!.name);
          if (isRefused(e)) return e;
          if (!("missing" in e)) error = e.value;
        }
        if (!byGroup.has(label)) byGroup.set(label, []);
        byGroup.get(label)!.push({ x: x.value, y: y.value, ...(error !== undefined ? { error } : {}) });
      }
      const series: Series[] = [...byGroup.entries()].map(([name, points]) => ({ name, points }));
      if (dropped) notes.push(`${dropped} row(s) with a missing x or y were dropped from the plot.`);
      /* byGroup only ever gains a key at the moment a real point is pushed
         into it, so an empty `series` here means every row was dropped --
         the same blank-plot failure the plain scatter/line branch below
         refuses, not a case unique to grouping. */
      if (!series.length) {
        return { error: `No row has both "${spec.x}" and "${spec.y[0]}" present at once.` };
      }
      let fit: { slope: number; intercept: number; r2: number } | undefined;
      /* Matches the plain multi-series branch's own rule below: a fit line
         is drawn only when there is exactly one series to draw it through.
         Pooling every group's points into one OLS line was the bug -- a
         single fit across groups a model asked to see kept separate is a
         real Simpson's-paradox risk, drawn with no caveat, while the
         identical "more than one series" situation without a group was
         already refused with an explanatory note. */
      if (spec.fit && series.length === 1) {
        const f = linearFit(series[0]!.points.map((p) => p.x), series[0]!.points.map((p) => p.y));
        if (Number.isFinite(f.slope)) fit = f;
        else notes.push("A fit line was requested but the x values do not vary enough to define one.");
      } else if (spec.fit) {
        notes.push("A fit line is only drawn for a single series; this data had more than one group.");
      }
      return { data: { kind: "scatter", series, ...(fit ? { fit } : {}) }, dropped, notes };
    }

    const series: Series[] = [];
    let dropped = 0;
    for (const yName of spec.y) {
      const yIdx = findColumn(table, yName);
      if (isRefused(yIdx)) return yIdx;
      const built = buildXY(table, xIdx, yIdx, errIdx);
      if (isRefused(built)) return built;
      series.push({ name: yName, points: built.points });
      dropped += built.dropped;
    }
    if (dropped) notes.push(`${dropped} row(s) with a missing x or y were dropped from the plot.`);
    /* Every series empty means Math.min/max over an empty array on the axis
       scale, which degrades to a blank plot frame with no ticks and no
       points -- silently accepting the request rather than saying why
       nothing is drawn. Refused the way the histogram kind already refuses
       too few values. */
    if (!series.some((s) => s.points.length)) {
      return { error: `No row has both "${spec.x}" and a given y column present at once.` };
    }

    if (spec.kind === "line") return { data: { kind: "line", series }, dropped, notes };

    let fit: { slope: number; intercept: number; r2: number } | undefined;
    if (spec.fit && series.length === 1) {
      const f = linearFit(series[0]!.points.map((p) => p.x), series[0]!.points.map((p) => p.y));
      if (Number.isFinite(f.slope)) fit = f;
      else notes.push("A fit line was requested but the x values do not vary enough to define one.");
    } else if (spec.fit) {
      notes.push("A fit line is only drawn for a single series; give one y column to use it.");
    }
    return { data: { kind: "scatter", series, ...(fit ? { fit } : {}) }, dropped, notes };
  }

  if (spec.kind === "bar") {
    if (!spec.x) return { error: "A bar chart needs an x column to use as the categories." };
    if (!spec.y.length) return { error: "A bar chart needs at least one y column." };
    const xIdx = findColumn(table, spec.x);
    if (isRefused(xIdx)) return xIdx;
    const errIdx = spec.errors ? findColumn(table, spec.errors) : undefined;
    if (isRefused(errIdx)) return errIdx;

    const categories = table.rows.map((row) => row[xIdx]!.text);
    let dropped = 0;
    const series: Series[] = [];
    for (const yName of spec.y) {
      const yIdx = findColumn(table, yName);
      if (isRefused(yIdx)) return yIdx;
      const points: { x: number; y: number; error?: number | undefined }[] = [];
      for (let r = 0; r < table.rows.length; r++) {
        const y = readNumeric(table, r, yIdx, table.columns[yIdx]!.name);
        if (isRefused(y)) return y;
        if ("missing" in y) { dropped++; points.push({ x: r, y: 0 }); continue; }
        let error: number | undefined;
        if (errIdx !== undefined) {
          const e = readNumeric(table, r, errIdx, table.columns[errIdx]!.name);
          if (isRefused(e)) return e;
          if (!("missing" in e)) error = e.value;
        }
        points.push({ x: r, y: y.value, ...(error !== undefined ? { error } : {}) });
      }
      series.push({ name: yName, points });
    }
    if (dropped) notes.push(`${dropped} missing cell(s) were drawn as a zero-height bar rather than dropped, so every category keeps its place on the axis.`);
    return { data: { kind: "bar", categories, series, stacked: spec.stacked === true }, dropped, notes };
  }

  if (spec.kind === "box") {
    if (spec.x) {
      const groupIdx = findColumn(table, spec.x);
      if (isRefused(groupIdx)) return groupIdx;
      if (!spec.y.length) return { error: "A box plot needs a value column in y, alongside the group in x." };
      const yIdx = findColumn(table, spec.y[0]!);
      if (isRefused(yIdx)) return yIdx;
      const byGroup = new Map<string, number[]>();
      let dropped = 0;
      for (let r = 0; r < table.rows.length; r++) {
        const v = readNumeric(table, r, yIdx, table.columns[yIdx]!.name);
        if (isRefused(v)) return v;
        if ("missing" in v) { dropped++; continue; }
        const label = table.rows[r]![groupIdx]!.text || "(blank)";
        if (!byGroup.has(label)) byGroup.set(label, []);
        byGroup.get(label)!.push(v.value);
      }
      if (dropped) notes.push(`${dropped} row(s) with a missing value were left out.`);
      const groups: BoxGroupData[] = [...byGroup.entries()].map(([label, values]) => ({ label, values }));
      return { data: { kind: "box", groups }, dropped, notes };
    }
    if (!spec.y.length) return { error: "A box plot needs either an x column to group by, or one y column per box." };
    let dropped = 0;
    const groups: BoxGroupData[] = [];
    const empty: string[] = [];
    for (const yName of spec.y) {
      const yIdx = findColumn(table, yName);
      if (isRefused(yIdx)) return yIdx;
      const built = buildValues(table, yIdx);
      if (isRefused(built)) return built;
      dropped += built.dropped;
      /* A column with no measured value at all is left out, never drawn as a
         box collapsed to zero -- the same "count nobody measured" rule the
         PRISMA figure already keeps. Without this, boxOf's own fallback for
         an empty array produces a real-looking box sitting exactly at y=0,
         indistinguishable from "measured, and it was zero". */
      if (!built.values.length) { empty.push(yName); continue; }
      groups.push({ label: yName, values: built.values });
    }
    if (dropped) notes.push(`${dropped} missing cell(s) were left out.`);
    if (empty.length) {
      notes.push(
        `${empty.map((n) => `"${n}"`).join(", ")} had no measured value and drew no box, rather ` +
          "than one collapsed to zero.",
      );
    }
    if (!groups.length) {
      return { error: "None of the given columns has a measured value to draw a box from." };
    }
    return { data: { kind: "box", groups }, dropped, notes };
  }

  // histogram
  if (!spec.y.length) return { error: "A histogram needs one column, in y, to bin." };
  const yIdx = findColumn(table, spec.y[0]!);
  if (isRefused(yIdx)) return yIdx;
  const built = buildValues(table, yIdx);
  if (isRefused(built)) return built;
  if (built.dropped) notes.push(`${built.dropped} missing cell(s) were left out.`);
  if (built.values.length < 2) return { error: `Column "${spec.y[0]}" has too few numeric values to draw a histogram.` };
  return { data: { kind: "histogram", values: built.values }, dropped: built.dropped, notes };
}

const KINDS: ChartKind[] = ["scatter", "line", "bar", "box", "histogram"];

export const createChartTool: ToolDef = {
  name: "create_chart",
  description:
    "Build a publication figure from data the user pasted or dropped into the conversation, and " +
    "show it to the user as a figure they can export. Give the data_id of the data attachment to " +
    "use -- never retype the numbers yourselves, this tool reads them directly from what the user " +
    "provided, and computes any fit line or box-plot statistic itself. Name columns by their exact " +
    "header text. kind is one of scatter, line, bar, box or histogram. scatter and line need x and " +
    "one or more y columns; bar needs x as the category and one or more y columns as series " +
    "(optionally stacked); box needs either x as the group and one y value column, or one y column " +
    "per box with no x; histogram needs one y column, auto-binned. errors names a column of " +
    "already-computed half-widths for an error bar. Call it again with corrected arguments if it " +
    "returns an error.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      data_id: {
        type: "string",
        description: "The id of the data attachment holding the table, from the [data ...] line in the conversation.",
      },
      kind: { type: "string", description: "One of: scatter, line, bar, box, histogram." },
      x: { type: "string", description: "The x-axis (or category, or group) column, by its exact header text." },
      y: {
        type: "array",
        items: { type: "string" },
        description: "One or more value columns, by their exact header text. See kind-specific rules above.",
      },
      group: {
        type: "string",
        description:
          "Scatter only, with exactly one y column: split points into a series per value of this column.",
      },
      errors: { type: "string", description: "A column of already-computed error-bar half-widths." },
      stacked: { type: "boolean", description: "Bar only: stack the series instead of grouping them side by side." },
      fit: { type: "boolean", description: "Scatter only: draw an ordinary least-squares fit line, computed here, never supplied." },
      title: { type: "string", description: "A short caption for the figure, as it would read in a paper." },
      xLabel: { type: "string", description: "The x-axis title. Defaults to the x column's name." },
      yLabel: { type: "string", description: "The y-axis title. Defaults to the y column's name." },
    },
    required: ["data_id", "kind", "y"],
    additionalProperties: false,
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const dataId = typeof params["data_id"] === "string" ? params["data_id"] : "";
    const kindRaw = typeof params["kind"] === "string" ? params["kind"] : "";
    const title = typeof params["title"] === "string" && params["title"].trim() ? params["title"].trim() : "Chart";
    const y = Array.isArray(params["y"]) ? params["y"].filter((v): v is string => typeof v === "string") : [];

    if (!dataId.trim()) {
      return { content: "No data_id was given. Pass the id of a data attachment from this conversation." };
    }
    if (!KINDS.includes(kindRaw as ChartKind)) {
      return { content: `kind must be one of ${KINDS.join(", ")}. Call create_chart again with a valid kind.` };
    }
    if (!y.length) {
      return { content: "No y column was given. Call create_chart again naming at least one value column." };
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

    const spec: ChartSpec = {
      kind: kindRaw as ChartKind, y,
      ...(typeof params["x"] === "string" ? { x: params["x"] } : {}),
      ...(typeof params["group"] === "string" ? { group: params["group"] } : {}),
      ...(typeof params["errors"] === "string" ? { errors: params["errors"] } : {}),
      ...(params["stacked"] === true ? { stacked: true } : {}),
      ...(params["fit"] === true ? { fit: true } : {}),
      ...(typeof params["xLabel"] === "string" ? { xLabel: params["xLabel"] } : {}),
      ...(typeof params["yLabel"] === "string" ? { yLabel: params["yLabel"] } : {}),
    };

    const built = buildChartData(parsed.table, spec);
    if (isRefused(built)) {
      return { content: `${built.error} Call create_chart again once that is fixed.` };
    }

    const id = chartIds.next();
    chartWatcher.announce({ id, title, data: built.data, spec });

    const noteText = built.notes.length ? ` ${built.notes.join(" ")}` : "";
    return {
      content:
        `Drew "${title}" as a ${spec.kind} chart from "${source.name}".${noteText} It is shown to ` +
        "the user beside the conversation, where they can export it as SVG, PNG or PGFPlots " +
        "source. Do not repeat the data in your reply; say what it shows.",
      detail: { id, title, data: built.data, spec },
    };
  },
};

export const CHART_TOOL_DEFS: ToolDef[] = [createChartTool];
