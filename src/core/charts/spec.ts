/**
 * What the model asks for: a chart kind and column names -- never a value.
 *
 * The same discipline as tools/table.ts's schema, for the same reason: a
 * model that transcribes a plotted number into a JSON argument will
 * eventually get one wrong, so the fix is removing the argument slot a
 * number could occupy, not asking for care. Every field here names a column
 * or chooses a boolean; the actual numbers are read out of the DataTable the
 * data_id resolves to, by chart.ts, never typed by the model.
 */

export type ChartKind = "scatter" | "line" | "bar" | "box" | "histogram";

export interface ChartSpec {
  kind: ChartKind;
  /** The x-axis column. Scatter/line: numeric. Bar: categorical (one bar
   *  group per distinct value). Box: categorical, one box per distinct value
   *  (an alternative to giving several `y` columns). Unused for histogram. */
  x?: string | undefined;
  /** Value column(s). Scatter/line: one series per name, plotted against
   *  `x`. Bar: one series per name (grouped or stacked). Box, with no `x`:
   *  one box per name. Histogram: exactly the first name is used. */
  y: string[];
  /** A column naming a category to split a scatter into multiple series by
   *  colour. Unused for the other kinds, which already have their own way of
   *  naming a series (`y`) or a category (`x`). */
  group?: string | undefined;
  /** A column of error half-widths, aligned row by row with `y[0]`. Scatter,
   *  line and bar only. */
  errors?: string | undefined;
  stacked?: boolean | undefined;
  /** Draw an ordinary least-squares fit line. Scatter only, and only when
   *  `core/tabular/stats.ts`'s `linearFit` returns a finite slope -- a
   *  vertical scatter draws no line rather than a wrong one. */
  fit?: boolean | undefined;
  title?: string | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
}
