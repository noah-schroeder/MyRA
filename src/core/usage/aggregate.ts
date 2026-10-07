/**
 * The usage dashboard's arithmetic, with no disk and no window.
 *
 * Main reads a range of records and hands them here with what it knows about
 * projects; the window receives the finished summary and only draws it. Every
 * breakdown is computed in one pass so switching a table tab costs nothing,
 * and a filter or a split is a fresh question rather than client-side surgery
 * on a stale answer.
 *
 * Three rules the numbers keep:
 *
 *   - A count nobody reported is not zero. Calls whose server sent no usage
 *     are counted as requests and named in `unreported`, and contribute
 *     nothing to the token sums -- the same refusal `speed.ts` makes for a
 *     rate it did not measure.
 *   - A cost is the provider's own price, frozen on the record when the call
 *     was made, times the tokens it reported. A hosted call without both is
 *     counted in `unpriced` rather than costed at a guess.
 *   - A project is whoever holds the work NOW. A conversation filed into a
 *     project after it was had carries its usage with it, because projects
 *     are an index and filing after the fact is the ordinary case; only when
 *     no project holds the item does the project recorded at the time stand in.
 */

import {
  countsTokens,
  FEATURE_WORDS,
  type UsageFeature,
  type UsageRecord,
  type UsageWhere,
} from "./record.ts";
import { bucketFor, bucketKey, bucketLabel, bucketsIn, localDay, type Bucket, type DateRange } from "./range.ts";

export const USAGE_DIMENSIONS = ["model", "project", "feature", "source", "where", "stage"] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export const DIMENSION_WORDS: Record<UsageDimension, string> = {
  model: "Model",
  project: "Project",
  feature: "Feature",
  source: "Who asked",
  where: "Where it ran",
  stage: "Research stage",
};

export interface UsageFilters {
  where?: UsageWhere | undefined;
  /** "app", or "key:<id>" for one gateway key, or "api" for every key. */
  source?: string | undefined;
  /** A project id, or "" for work in no project. */
  project?: string | undefined;
  /** A model row's key. */
  model?: string | undefined;
  feature?: UsageFeature | undefined;
}

export interface UsageQuery {
  range: DateRange;
  filters?: UsageFilters | undefined;
  /** What the chart's stacks are split by. */
  splitBy?: UsageDimension | undefined;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  cancelled: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  /** Calls whose server sent no token counts at all. */
  unreported: number;
  ms: number;
  /** Generation time and the output tokens it produced, for an honest tok/s. */
  genMs: number;
  genTokens: number;
  /** US dollars, from priced calls only. */
  cost: number;
  /** Calls that could be costed -- so "$0" from free models is not "no price". */
  priced: number;
  /** Hosted calls that could not be costed: no price, or no counts to multiply. */
  unpriced: number;
  /** Calls made on this machine, for the local share. */
  local: number;
}

export interface UsageRow {
  key: string;
  label: string;
  /** A second line: the provider of a model, "deleted" for a project. */
  detail?: string;
  where?: UsageWhere | "mixed";
  totals: UsageTotals;
}

export interface Option {
  key: string;
  label: string;
}

export interface MediaTotals {
  transcription: { requests: number; seconds: number; errors: number };
  speech: { requests: number; characters: number; errors: number };
  image: { requests: number; images: number; ms: number; errors: number };
}

export interface UsageSummary {
  range: DateRange;
  bucket: Bucket;
  totals: UsageTotals;
  breakdowns: Record<UsageDimension, UsageRow[]>;
  timeline: {
    buckets: string[];
    labels: string[];
    splitBy: UsageDimension;
    series: { key: string; label: string; values: UsageTotals[] }[];
  };
  options: { models: Option[]; projects: Option[]; sources: Option[]; features: Option[] };
  media: MediaTotals;
}

/** What main knows about projects at the moment of asking. */
export interface ProjectContext {
  /** Current name of every project that exists. */
  names: ReadonlyMap<string, string>;
  /** `kind:ref` of every member, to the id of the project holding it. */
  owners: ReadonlyMap<string, string>;
}

export const NO_PROJECT = "";
export const OTHER = "\u0000other";
/** How many named stacks the chart draws before the rest become "Other". */
export const TOP_SERIES = 6;

export function emptyTotals(): UsageTotals {
  return {
    requests: 0, errors: 0, cancelled: 0, input: 0, output: 0, cached: 0, reasoning: 0,
    unreported: 0, ms: 0, genMs: 0, genTokens: 0, cost: 0, priced: 0, unpriced: 0, local: 0,
  };
}

/** What one record costs, or undefined when it cannot honestly be said. */
export function costOf(r: UsageRecord): number | undefined {
  if (!r.price) return undefined;
  if (r.input === undefined && r.output === undefined) return undefined;
  return ((r.input ?? 0) * r.price.input + (r.output ?? 0) * r.price.output) / 1_000_000;
}

function add(t: UsageTotals, r: UsageRecord): void {
  // A merged line from an API burst stands for `count` requests, all alike.
  const n = r.count ?? 1;
  t.requests += n;
  if (r.outcome === "error") t.errors += n;
  if (r.outcome === "cancelled") t.cancelled += n;
  if (r.where === "local") t.local += n;
  t.ms += r.ms;
  const reported = r.input !== undefined || r.output !== undefined;
  /* A failed or cancelled call usually reports nothing because there was
     nothing to report; only a call that finished is "unreported". */
  if (!reported && r.outcome === "ok") t.unreported += n;
  t.input += r.input ?? 0;
  t.output += r.output ?? 0;
  t.cached += r.cached ?? 0;
  t.reasoning += r.reasoning ?? 0;
  if (r.genMs !== undefined && r.genMs > 0 && (r.output ?? 0) > 0) {
    t.genMs += r.genMs;
    t.genTokens += r.output!;
  }
  const cost = costOf(r);
  if (cost !== undefined) {
    t.cost += cost;
    t.priced += n;
  } else if (r.where === "external" && r.outcome === "ok") t.unpriced += n;
}

function merge(into: UsageTotals, from: UsageTotals): void {
  for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += from[k];
}

/** Generation speed over a set of calls, when there is anything to divide. */
export function tokensPerSecond(t: UsageTotals): number | undefined {
  return t.genMs > 0 && t.genTokens > 0 ? Math.round((t.genTokens / t.genMs) * 10_000) / 10 : undefined;
}

/** A dimension's key and label for one record, with any detail worth a second line. */
interface Keyed {
  key: string;
  label: string;
  detail?: string;
}

export function projectOf(r: UsageRecord, ctx: ProjectContext): Keyed {
  const owner = r.item ? ctx.owners.get(`${r.item.kind}:${r.item.ref}`) : undefined;
  const id = owner ?? r.project?.id ?? NO_PROJECT;
  if (!id) return { key: NO_PROJECT, label: "No project" };
  const current = ctx.names.get(id);
  if (current !== undefined) return { key: id, label: current };
  /* A project deleted since: its name is whatever it was called when the work
     was done, said plainly rather than shown as if it still existed. */
  const recorded = r.project?.id === id ? r.project.name : "";
  return { key: id, label: recorded || "A deleted project", detail: "deleted" };
}

function keyed(dim: UsageDimension, r: UsageRecord, ctx: ProjectContext): Keyed | undefined {
  switch (dim) {
    case "model":
      return { key: `${r.provider.id}::${r.model}`, label: r.model || "(unnamed model)", detail: r.provider.name };
    case "project":
      return projectOf(r, ctx);
    case "feature":
      return { key: r.feature, label: FEATURE_WORDS[r.feature] };
    case "source":
      return r.source === "api" && r.key
        ? { key: `key:${r.key.id}`, label: r.key.label || "Unnamed key", detail: "API key" }
        : { key: "app", label: "MyRA" };
    case "where":
      return r.where === "local"
        ? { key: "local", label: "This computer" }
        : { key: "external", label: "Hosted" };
    case "stage":
      // Only a research run has stages; everything else simply is not in this table.
      return r.feature === "research" && r.stage ? { key: r.stage, label: r.stage } : undefined;
  }
}

function matches(r: UsageRecord, f: UsageFilters | undefined, ctx: ProjectContext): boolean {
  if (!f) return true;
  if (f.where && r.where !== f.where) return false;
  if (f.feature && r.feature !== f.feature) return false;
  if (f.source !== undefined && f.source !== "") {
    if (f.source === "app" && r.source !== "app") return false;
    if (f.source === "api" && r.source !== "api") return false;
    if (f.source.startsWith("key:") && !(r.source === "api" && `key:${r.key?.id ?? ""}` === f.source)) return false;
  }
  if (f.model !== undefined && f.model !== "" && `${r.provider.id}::${r.model}` !== f.model) return false;
  if (f.project !== undefined && projectOf(r, ctx).key !== f.project) return false;
  return true;
}

/** Biggest first, by tokens and then by requests, so a table opens on what matters. */
function byWeight(a: UsageRow, b: UsageRow): number {
  const ta = a.totals.input + a.totals.output;
  const tb = b.totals.input + b.totals.output;
  return tb - ta || b.totals.requests - a.totals.requests || a.label.localeCompare(b.label);
}

function addMedia(m: MediaTotals, r: UsageRecord): void {
  const failed = r.outcome !== "ok";
  const n = r.count ?? 1;
  if (r.kind === "transcription") {
    m.transcription.requests += n;
    if (failed) m.transcription.errors += n;
    else m.transcription.seconds += r.units ?? 0;
  } else if (r.kind === "speech") {
    m.speech.requests += n;
    if (failed) m.speech.errors += n;
    else m.speech.characters += r.units ?? 0;
  } else if (r.kind === "image") {
    m.image.requests += n;
    if (failed) m.image.errors += n;
    else {
      m.image.images += r.units ?? n;
      m.image.ms += r.ms;
    }
  }
}

function inRangeOf(records: readonly UsageRecord[], range: DateRange): UsageRecord[] {
  return records.filter((r) => {
    const day = localDay(new Date(r.at));
    return day >= range.from && day <= range.to;
  });
}

/** Exactly the records a summary with this query counts -- for the CSV export. */
export function selectRecords(
  records: readonly UsageRecord[],
  query: UsageQuery,
  ctx: ProjectContext,
): UsageRecord[] {
  return inRangeOf(records, query.range).filter((r) => matches(r, query.filters, ctx));
}

export function summarize(records: readonly UsageRecord[], query: UsageQuery, ctx: ProjectContext): UsageSummary {
  const { range } = query;
  const bucket = bucketFor(range);
  const splitBy = query.splitBy ?? "model";
  const buckets = bucketsIn(range, bucket);
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const inRange = inRangeOf(records, range);

  /* The dropdowns are built from the range BEFORE filtering, so choosing one
     model does not make every other model vanish from the menu that would
     un-choose it. */
  const optionMaps = { models: new Map<string, Option>(), projects: new Map<string, Option>(),
    sources: new Map<string, Option>(), features: new Map<string, Option>() };
  for (const r of inRange) {
    if (!countsTokens(r.kind)) continue;
    const m = keyed("model", r, ctx)!;
    optionMaps.models.set(m.key, { key: m.key, label: m.detail ? `${m.label} · ${m.detail}` : m.label });
    const p = projectOf(r, ctx);
    optionMaps.projects.set(p.key, { key: p.key, label: p.detail ? `${p.label} (deleted)` : p.label });
    const s = keyed("source", r, ctx)!;
    optionMaps.sources.set(s.key, { key: s.key, label: s.label });
    optionMaps.features.set(r.feature, { key: r.feature, label: FEATURE_WORDS[r.feature] });
  }
  const sorted = (m: Map<string, Option>): Option[] => [...m.values()].sort((a, b) => a.label.localeCompare(b.label));

  const totals = emptyTotals();
  const media: MediaTotals = {
    transcription: { requests: 0, seconds: 0, errors: 0 },
    speech: { requests: 0, characters: 0, errors: 0 },
    image: { requests: 0, images: 0, ms: 0, errors: 0 },
  };
  const rows = Object.fromEntries(USAGE_DIMENSIONS.map((d) => [d, new Map<string, UsageRow>()])) as Record<
    UsageDimension,
    Map<string, UsageRow>
  >;
  /* Per split key, per bucket. Folded into the top few plus "Other" once the
     weights are known, which needs the whole pass first. */
  const perSplit = new Map<string, { label: string; values: UsageTotals[] }>();

  for (const r of inRange) {
    if (!matches(r, query.filters, ctx)) continue;
    if (!countsTokens(r.kind)) {
      addMedia(media, r);
      continue;
    }
    add(totals, r);
    for (const dim of USAGE_DIMENSIONS) {
      const k = keyed(dim, r, ctx);
      if (!k) continue;
      let row = rows[dim].get(k.key);
      if (!row) {
        row = { key: k.key, label: k.label, ...(k.detail ? { detail: k.detail } : {}), where: r.where, totals: emptyTotals() };
        rows[dim].set(k.key, row);
      } else if (row.where !== r.where) {
        row.where = "mixed";
      }
      add(row.totals, r);
    }
    const s = keyed(splitBy, r, ctx);
    if (!s) continue;
    let series = perSplit.get(s.key);
    if (!series) {
      series = { label: s.label, values: buckets.map(() => emptyTotals()) };
      perSplit.set(s.key, series);
    }
    const i = bucketIndex.get(bucketKey(localDay(new Date(r.at)), bucket));
    if (i !== undefined) add(series.values[i]!, r);
  }

  const breakdowns = Object.fromEntries(
    USAGE_DIMENSIONS.map((d) => [d, [...rows[d].values()].sort(byWeight)]),
  ) as Record<UsageDimension, UsageRow[]>;

  /* The chart keeps the same order as the table for the same dimension, so the
     first colour is the biggest row in both places. */
  const order = breakdowns[splitBy].map((row) => row.key).filter((k) => perSplit.has(k));
  const top = order.slice(0, TOP_SERIES);
  const series = top.map((key) => ({ key, label: perSplit.get(key)!.label, values: perSplit.get(key)!.values }));
  const rest = order.slice(TOP_SERIES);
  if (rest.length) {
    const values = buckets.map(() => emptyTotals());
    for (const key of rest) {
      perSplit.get(key)!.values.forEach((v, i) => merge(values[i]!, v));
    }
    series.push({ key: OTHER, label: `${rest.length} more`, values });
  }

  return {
    range,
    bucket,
    totals,
    breakdowns,
    timeline: { buckets, labels: buckets.map((b) => bucketLabel(b, bucket)), splitBy, series },
    options: {
      models: sorted(optionMaps.models),
      projects: sorted(optionMaps.projects),
      sources: sorted(optionMaps.sources),
      features: sorted(optionMaps.features),
    },
    media,
  };
}
