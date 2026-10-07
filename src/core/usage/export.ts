/**
 * The usage record as a spreadsheet.
 *
 * One row per call -- or per burst, for an API client's rapid repeats merged
 * into one line a second, which the `requests` column counts -- so whoever
 * opens it can pivot however they like -- the
 * dashboard's breakdowns are a few of the questions a grant report or a
 * departmental cost claim asks, not all of them. Blank where the server
 * reported nothing, never 0, for the reason the record itself keeps the two
 * apart.
 */

import { costOf, projectOf, type ProjectContext } from "./aggregate.ts";
import { FEATURE_WORDS, type UsageRecord } from "./record.ts";
import { localDay } from "./range.ts";

const COLUMNS = [
  "date", "time", "kind", "who", "feature", "model", "provider", "where", "project", "stage",
  "requests", "input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "units",
  "duration_ms", "outcome", "cost_usd",
] as const;

/**
 * One cell, quoted when it has to be.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe: a model name
 * or a project name is somebody's text, and a spreadsheet would otherwise run
 * it as a formula -- the CSV-injection that turns an export into a payload.
 */
export function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function time(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function usageCsv(records: readonly UsageRecord[], ctx: ProjectContext): string {
  const lines = [COLUMNS.join(",")];
  for (const r of records) {
    const at = new Date(r.at);
    const project = projectOf(r, ctx);
    const cost = costOf(r);
    const row = [
      localDay(at),
      time(at),
      r.kind,
      r.source === "api" ? `API: ${r.key?.label ?? "key"}` : "MyRA",
      FEATURE_WORDS[r.feature],
      r.model,
      r.provider.name,
      r.where === "local" ? "this computer" : "hosted",
      project.key ? `${project.label}${project.detail ? " (deleted)" : ""}` : "",
      r.stage,
      // More than one only for a merged burst from an API client; the figures after it are its sums.
      r.count ?? 1,
      r.input,
      r.output,
      r.cached,
      r.reasoning,
      r.units,
      Math.round(r.ms),
      r.outcome,
      cost === undefined ? undefined : Number(cost.toFixed(6)),
    ];
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
