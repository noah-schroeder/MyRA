/**
 * Whether a table column's header already states its own unit.
 *
 * parse.ts captures a unit two ways: pulled out of a heading like
 * "Mass (kg)" (where the header text is left verbatim, unit and all), or
 * detected from a column whose cells were uniformly written with a trailing
 * "%" (where the header itself -- something like "Response Rate" -- says
 * nothing about it). Appending "(kg)" after a header that already ends in
 * "(kg)" prints it twice; appending "(%)" after a header that never
 * mentioned percent at all is the only place a reader learns the unit.
 * `col.name` is never rewritten to settle this -- see table.ts's own
 * `Column.unit` doc comment -- so the two cases are told apart at render
 * time instead, by whether the header text already contains the unit.
 */
export function headerUnitSuffix(col: { name: string; unit?: string | undefined }): string | undefined {
  if (!col.unit) return undefined;
  return col.name.includes(col.unit) ? undefined : col.unit;
}
