import { useEffect, useMemo, useRef, useState } from "react";

import { layoutChart } from "../../core/charts/layout.ts";
import { money } from "../../core/pricing.ts";
import {
  DIMENSION_WORDS, tokensPerSecond, USAGE_DIMENSIONS, type UsageDimension, type UsageFilters,
  type UsageQuery, type UsageRow, type UsageSummary, type UsageTotals,
} from "../../core/usage/aggregate.ts";
import {
  compactCount, exactCount, localDay, parseDay, presetRange, PRESETS, type DateRange, type UsagePreset,
} from "../../core/usage/range.ts";
import { FEATURE_WORDS, USAGE_FEATURES, type UsageFeature } from "../../core/usage/record.ts";
import { THIS_COMPUTER } from "../../core/usage/classify.ts";
import type { Settings } from "../types.ts";
import { ChartSvg, screenColor } from "./ChartSvg.tsx";
import {
  audioLength, axisLabel, chartFor, formatMetric, METRICS, metricOf, shareOf, type UsageMetric,
} from "./usageView.ts";

/** The dimensions the chart can be stacked by. Research stage is a table, not a stack. */
const SPLITS: UsageDimension[] = ["model", "project", "feature", "where", "source"];

/** Sentinel for "no filter" in a select whose real values include "" (no project). */
const ALL = "\u0000all";

type SortKey = "label" | "requests" | "input" | "output" | "cached" | "speed" | "cost";

/**
 * Settings → Usage: how much MyRA has asked of its models, and of whom.
 *
 * Everything shown is read from the record main keeps (core/usage/), which is
 * counts only -- this page could not show a prompt if it wanted to. A filter or
 * a range is a fresh question to main rather than arithmetic here, so the
 * window never holds more than one summary.
 */
export function UsagePane({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (changes: Partial<Settings>) => Promise<void>;
}) {
  const [preset, setPreset] = useState<UsagePreset | "custom">("30d");
  const [custom, setCustom] = useState<DateRange>(() => presetRange("30d", new Date()));
  const [earliest, setEarliest] = useState<string | undefined>();
  const [filters, setFilters] = useState<UsageFilters>({});
  const [splitBy, setSplitBy] = useState<UsageDimension>("model");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [table, setTable] = useState<UsageDimension>("model");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | undefined>();
  const [summary, setSummary] = useState<UsageSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState<string | undefined>();

  const range: DateRange = useMemo(
    () => (preset === "custom" ? custom : presetRange(preset, new Date(), earliest)),
    // `refresh` too: "Today" has to move on at midnight for a page left open.
    [preset, custom, earliest, refresh],
  );
  const query: UsageQuery = useMemo(() => ({ range, filters, splitBy }), [range, filters, splitBy]);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let live = true;
    void window.myra.usageSummary(query).then((res) => {
      if (!live) return;
      if (res.ok) {
        setSummary(res.summary);
        setError(undefined);
        if (res.earliest !== earliest) setEarliest(res.earliest);
      } else {
        setError(res.error);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value, not identity
  }, [queryKey, refresh]);

  /* A model call anywhere in the app redraws this page, a little after the
     fact: main sends at most one notice a second, and a research run sends
     one every second for minutes, so this waits for a pause too. */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.myra.onUsageChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh((n) => n + 1), 1500);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, []);

  const say = (text: string): void => {
    setSaid(text);
    setTimeout(() => setSaid((now) => (now === text ? undefined : now)), 4000);
  };

  const setFilter = <K extends keyof UsageFilters>(key: K, value: UsageFilters[K] | undefined): void => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  /** Clicking a row narrows everything else to it -- the table's own dimension. */
  const drill = (dim: UsageDimension, row: UsageRow): void => {
    if (dim === "model") setFilter("model", row.key);
    else if (dim === "project") setFilter("project", row.key);
    else if (dim === "feature") setFilter("feature", row.key as UsageFeature);
    else if (dim === "source") setFilter("source", row.key);
    else if (dim === "where") setFilter("where", row.key === "local" ? "local" : "external");
  };

  const exportCsv = async (): Promise<void> => {
    const res = await window.myra.usageExport(query);
    if (!res.ok) say(res.error ?? "Could not export it");
    else if (res.saved) say(`Saved ${res.rows ?? 0} rows`);
  };

  const clearLog = async (): Promise<void> => {
    setConfirming(false);
    const res = await window.myra.usageClear();
    say(res.ok ? "Usage log cleared — counting starts fresh from here" : res.error ?? "Could not clear it");
    setRefresh((n) => n + 1);
  };

  const t = summary?.totals;
  const filtered = Object.keys(filters).length > 0;
  const nothing = summary && t && t.requests === 0 &&
    summary.media.transcription.requests + summary.media.speech.requests + summary.media.image.requests === 0;

  return (
    <div className="pane pane-wide usage">
      <h3>Usage</h3>
      <p className="pane-lead">
        How much MyRA has asked of its models — which model, for what, in which project, on this
        computer or a hosted provider — and how much other apps have asked through its API. Counts
        only: MyRA never records what was said.
      </p>

      <div className="usage-range" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={preset === p.id ? "review-type on" : "review-type"}
            aria-pressed={preset === p.id}
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
        <span className="usage-custom">
          <input
            type="date"
            aria-label="From"
            value={range.from}
            max={range.to}
            onChange={(e) => {
              if (!parseDay(e.target.value)) return;
              setCustom({ from: e.target.value, to: range.to < e.target.value ? e.target.value : range.to });
              setPreset("custom");
            }}
          />
          <span className="unit">to</span>
          <input
            type="date"
            aria-label="To"
            value={range.to}
            min={range.from}
            max={localDay(new Date())}
            onChange={(e) => {
              if (!parseDay(e.target.value)) return;
              setCustom({ from: range.from > e.target.value ? e.target.value : range.from, to: e.target.value });
              setPreset("custom");
            }}
          />
        </span>
      </div>

      <div className="usage-filters">
        <FilterSelect
          label="Where it ran"
          value={filters.where}
          options={[{ key: "local", label: "This computer" }, { key: "external", label: "Hosted" }]}
          onChange={(v) => setFilter("where", v as UsageFilters["where"])}
        />
        <FilterSelect
          label="Who asked"
          value={filters.source}
          options={[
            ...(summary?.options.sources ?? []).filter((o) => o.key === "app"),
            ...((summary?.options.sources ?? []).some((o) => o.key !== "app")
              ? [{ key: "api", label: "Any API key" }]
              : []),
            ...(summary?.options.sources ?? []).filter((o) => o.key !== "app").map((o) => ({ ...o, label: `API: ${o.label}` })),
          ]}
          onChange={(v) => setFilter("source", v)}
        />
        <FilterSelect
          label="Project"
          value={filters.project}
          options={summary?.options.projects ?? []}
          onChange={(v) => setFilter("project", v)}
        />
        <FilterSelect
          label="Model"
          value={filters.model}
          options={summary?.options.models ?? []}
          onChange={(v) => setFilter("model", v)}
        />
        <FilterSelect
          label="Feature"
          value={filters.feature}
          options={USAGE_FEATURES.filter((f) => summary?.options.features.some((o) => o.key === f) || filters.feature === f)
            .map((f) => ({ key: f, label: FEATURE_WORDS[f] }))}
          onChange={(v) => setFilter("feature", v as UsageFeature | undefined)}
        />
        {filtered ? (
          <button type="button" className="lem-act usage-reset" onClick={() => setFilters({})}>
            Clear filters
          </button>
        ) : null}
      </div>

      {error ? <p className="warning">{error}</p> : null}

      {!summary || !t ? (
        <p className="hint">Reading the record…</p>
      ) : nothing ? (
        <div className="usage-empty">
          <p>Nothing was recorded {filtered ? "that matches these filters " : ""}between {summary.range.from} and {summary.range.to}.</p>
          {!settings.recordUsage ? <p className="hint">Recording is switched off below.</p> : null}
        </div>
      ) : (
        <>
          {/* Only speech or images in this range: no token figures to show at all. */}
          {t.requests > 0 ? (
            <>
              <Tiles totals={t} />
              <Notes totals={t} />
              <UsageChartPanel
                summary={summary}
                metric={metric}
                setMetric={setMetric}
                splitBy={splitBy}
                setSplitBy={setSplitBy}
              />
              <Breakdown
                summary={summary}
                dim={table}
                setDim={setTable}
                sort={sort}
                setSort={setSort}
                splitBy={splitBy}
                onRow={(row) => drill(table, row)}
              />
            </>
          ) : null}
          <Media summary={summary} />
        </>
      )}

      <div className="usage-foot">
        <label className="check">
          <input
            type="checkbox"
            checked={settings.recordUsage}
            onChange={(e) => void patch({ recordUsage: e.target.checked })}
          />
          <span>Record usage</span>
        </label>
        <span className="build-spacer" />
        <button type="button" className="lem-act" onClick={() => void exportCsv()} disabled={!t || t.requests === 0}>
          Export CSV
        </button>
        {/* Never disabled: the range on screen may be empty while other months
            are not, and "start fresh" means all of them. */}
        {confirming ? (
          <>
            <span className="hint">Deletes every record, for every date — not just this range. It cannot be undone.</span>
            <button type="button" className="lem-act" onClick={() => setConfirming(false)}>Keep it</button>
            <button type="button" className="lem-act danger on" onClick={() => void clearLog()}>Delete all records</button>
          </>
        ) : (
          <button type="button" className="lem-act" onClick={() => setConfirming(true)}>Clear usage log…</button>
        )}
      </div>
      <p className="hint">
        Kept on this computer only, readable by your account alone, one file per month. Turning
        recording off stops new counts; what is already recorded stays until you clear it.
        {said ? <> <strong className="usage-said">{said}</strong></> : null}
      </p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { key: string; label: string }[];
  onChange: (value: string | undefined) => void;
}) {
  /* A value chosen earlier that no longer appears in this range is kept in
     the list, so the select shows what is actually filtering the page. */
  const shown = value !== undefined && !options.some((o) => o.key === value)
    ? [...options, { key: value, label: "(not in this range)" }]
    : options;
  return (
    <label className="usage-filter">
      <span>{label}</span>
      <select value={value ?? ALL} onChange={(e) => onChange(e.target.value === ALL ? undefined : e.target.value)}>
        <option value={ALL}>All</option>
        {shown.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function Tile({ label, value, exact, sub }: { label: string; value: string; exact?: string; sub?: string }) {
  return (
    <div className="usage-tile" {...(exact ? { title: exact } : {})}>
      <span className="usage-tile-label">{label}</span>
      <span className="usage-tile-value">{value}</span>
      {sub ? <span className="usage-tile-sub">{sub}</span> : null}
    </div>
  );
}

function Tiles({ totals: t }: { totals: UsageTotals }) {
  const speed = tokensPerSecond(t);
  const hosted = t.requests - t.local;
  return (
    <div className="usage-tiles">
      <Tile
        label="Input tokens"
        value={compactCount(t.input)}
        exact={`${exactCount(t.input)} input tokens`}
        {...(t.cached > 0 ? { sub: `${compactCount(t.cached)} from cache` } : {})}
      />
      <Tile
        label="Output tokens"
        value={compactCount(t.output)}
        exact={`${exactCount(t.output)} output tokens`}
        {...(t.reasoning > 0 ? { sub: `${compactCount(t.reasoning)} reasoning` } : {})}
      />
      <Tile
        label="Requests"
        value={compactCount(t.requests)}
        exact={`${exactCount(t.requests)} requests`}
        {...(t.errors || t.cancelled
          ? { sub: [t.errors ? `${t.errors} failed` : "", t.cancelled ? `${t.cancelled} stopped` : ""].filter(Boolean).join(", ") }
          : {})}
      />
      <Tile
        label="Estimated cost"
        value={t.priced > 0 ? money(t.cost) : "—"}
        {...(t.priced > 0 ? { exact: `US$${t.cost.toFixed(4)}, at the prices the providers reported` } : {})}
        sub={
          t.unpriced > 0
            ? `${t.unpriced} hosted call${t.unpriced === 1 ? "" : "s"} had no price`
            : hosted === 0
              ? "All on this computer"
              : "As the providers reported"
        }
      />
      <Tile
        label="On this computer"
        value={t.requests ? `${Math.round((t.local / t.requests) * 100)}%` : "—"}
        sub={hosted > 0 ? `${compactCount(hosted)} hosted` : "Nothing hosted"}
      />
      <Tile
        label="Generation speed"
        value={speed !== undefined ? `${speed.toFixed(1)}` : "—"}
        sub={speed !== undefined ? "tokens a second, where measured" : "Not measured"}
      />
    </div>
  );
}

/** What the totals cannot say on their own. Said once, plainly, rather than as asterisks. */
function Notes({ totals: t }: { totals: UsageTotals }) {
  const notes: string[] = [];
  if (t.unreported > 0) {
    notes.push(
      `${t.unreported} request${t.unreported === 1 ? "" : "s"} finished without the server reporting token ` +
        "counts, so they are counted as requests and add nothing to the token totals. An API client " +
        "that does not ask for usage on a streamed reply is the usual reason.",
    );
  }
  if (t.unpriced > 0) {
    notes.push(
      "A cost is shown only where the provider published a price for that model when its models were " +
        "last fetched (Settings → Providers). MyRA keeps no price list of its own, so the estimate " +
        "leaves those calls out rather than guess.",
    );
  }
  if (!notes.length) return null;
  return (
    <ul className="plain usage-notes">
      {notes.map((n) => <li key={n} className="hint">{n}</li>)}
    </ul>
  );
}

function UsageChartPanel({
  summary,
  metric,
  setMetric,
  splitBy,
  setSplitBy,
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  setMetric: (m: UsageMetric) => void;
  splitBy: UsageDimension;
  setSplitBy: (d: UsageDimension) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = { width: Math.max(320, width), height: 260 };
  // About one label per 64px: "12 Oct" at 11px needs roughly that much air.
  const chart = useMemo(() => chartFor(summary, metric, Math.max(2, Math.floor(size.width / 64))), [summary, metric, size.width]);
  const layout = useMemo(
    () => layoutChart(chart.data, { size, yTickFormat: (v) => axisLabel(v, metric) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- size is derived from width
    [chart, metric, size.width],
  );
  const series = summary.timeline.series;

  return (
    <section className="usage-chart">
      <div className="usage-chart-head">
        <div className="lem-tabs" role="group" aria-label="What to chart">
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={metric === m.id ? "lem-tab on" : "lem-tab"}
              aria-pressed={metric === m.id}
              onClick={() => setMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="usage-filter usage-split">
          <span>Stacked by</span>
          <select value={splitBy} onChange={(e) => setSplitBy(e.target.value as UsageDimension)}>
            {SPLITS.map((d) => <option key={d} value={d}>{DIMENSION_WORDS[d]}</option>)}
          </select>
        </label>
      </div>
      <div className="usage-canvas" ref={ref}>
        {chart.empty ? (
          <p className="hint usage-chart-empty">
            {metric === "cost" ? "No priced calls in this range." : "Nothing to chart for this measure."}
          </p>
        ) : (
          <ChartSvg
            layout={layout}
            label={`${METRICS.find((m) => m.id === metric)?.label ?? ""} by ${summary.bucket}`}
            barTitle={(bar) => {
              const s = series[bar.seriesIndex];
              const v = s?.values[bar.category];
              if (!s || !v) return undefined;
              const n = metricOf(v, metric);
              const when = summary.bucket === "week" ? `week of ${chart.labels[bar.category]}` : chart.labels[bar.category];
              const tokens = metric === "tokens" || metric === "input" || metric === "output";
              if (tokens && v.requests > 0 && v.unreported === v.requests) return `${s.label} — ${when}: not reported`;
              return `${s.label} — ${when}: ${metric === "cost" ? money(n) : exactCount(n)}`;
            }}
          />
        )}
      </div>
      <p className="hint">
        {summary.bucket === "day" ? "One bar a day." : summary.bucket === "week" ? "One bar a week, from Monday." : "One bar a month."}{" "}
        Hover a bar for its exact figure.
      </p>
    </section>
  );
}

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "label", label: "", numeric: false },
  { key: "requests", label: "Requests", numeric: true },
  { key: "input", label: "Input", numeric: true },
  { key: "output", label: "Output", numeric: true },
  { key: "cached", label: "Cached", numeric: true },
  { key: "speed", label: "Tok/s", numeric: true },
  { key: "cost", label: "Cost", numeric: true },
];

/**
 * A header click: biggest first for a number and A–Z for a name, then the
 * other way, then back to the order main sent -- which is by weight, the order
 * the chart's stacks are in.
 */
function nextSort(
  current: { key: SortKey; desc: boolean } | undefined,
  key: SortKey,
  numeric: boolean,
): { key: SortKey; desc: boolean } | undefined {
  if (current?.key !== key) return { key, desc: numeric };
  if (current.desc === numeric) return { key, desc: !numeric };
  return undefined;
}

function sortValue(row: UsageRow, key: SortKey): number | string {
  switch (key) {
    case "label": return row.label.toLowerCase();
    case "requests": return row.totals.requests;
    case "input": return row.totals.input;
    case "output": return row.totals.output;
    case "cached": return row.totals.cached;
    case "speed": return tokensPerSecond(row.totals) ?? -1;
    case "cost": return row.totals.priced ? row.totals.cost : -1;
  }
}

function Breakdown({
  summary,
  dim,
  setDim,
  sort,
  setSort,
  splitBy,
  onRow,
}: {
  summary: UsageSummary;
  dim: UsageDimension;
  setDim: (d: UsageDimension) => void;
  sort: { key: SortKey; desc: boolean } | undefined;
  setSort: (s: { key: SortKey; desc: boolean } | undefined) => void;
  splitBy: UsageDimension;
  onRow: (row: UsageRow) => void;
}) {
  const rows = summary.breakdowns[dim];
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const out = [...rows];
    out.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, sort]);

  /* The chart's colours, on the rows the chart drew -- so a stack and its
     row are matched by more than position in two different lists. */
  const colourOf = new Map(
    dim === splitBy ? summary.timeline.series.map((s, i) => [s.key, i] as const) : [],
  );
  const canDrill = dim !== "stage";
  // The where-it-ran table is that pill; a stage is always the research run's own model.
  const showWhere = dim !== "where";
  const tabs = USAGE_DIMENSIONS.filter((d) => d !== "stage" || summary.breakdowns.stage.length > 0);

  return (
    <section className="usage-breakdown">
      <div className="lem-tabs" role="tablist" aria-label="Break down by">
        {tabs.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={dim === d}
            className={dim === d ? "lem-tab on" : "lem-tab"}
            onClick={() => {
              setDim(d);
              setSort(undefined);
            }}
          >
            {DIMENSION_WORDS[d]}
            <span className="lem-tab-count">{summary.breakdowns[d].length}</span>
          </button>
        ))}
      </div>
      <div className="usage-table-wrap">
        <table className="privacy-table usage-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const on = sort?.key === c.key;
                return (
                  <th key={c.key} className={c.numeric ? "num" : undefined} aria-sort={on ? (sort!.desc ? "descending" : "ascending") : "none"}>
                    <button type="button" className="usage-sort" onClick={() => setSort(nextSort(sort, c.key, c.numeric))}>
                      {c.label || DIMENSION_WORDS[dim]}
                      {on ? (sort!.desc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                );
              })}
              <th className="usage-share-col">Share</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const speed = tokensPerSecond(row.totals);
              const share = shareOf(row.totals, summary.totals);
              const colour = colourOf.get(row.key);
              const silent = row.totals.unreported > 0 && row.totals.unreported === row.totals.requests;
              return (
                <tr
                  key={row.key}
                  className={canDrill ? "usage-row" : undefined}
                  {...(canDrill
                    ? { onClick: () => onRow(row), title: `Show only ${row.label}` }
                    : {})}
                >
                  <td>
                    <span className="usage-name">
                      {colour !== undefined ? <span className="usage-swatch" style={{ background: screenColor(colour) }} /> : null}
                      <span>{row.label}</span>
                    </span>
                    {row.detail || showWhere ? (
                      <span className="usage-detail">
                        {row.detail ? <span>{row.detail}</span> : null}
                        {/* Not beside "This computer", which already said it. */}
                        {showWhere && row.where && row.detail !== THIS_COMPUTER ? (
                          <span className={row.where === "local" ? "pill on" : "pill"}>
                            {row.where === "local" ? "this computer" : row.where === "external" ? "hosted" : "both"}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </td>
                  <td className="num" title={exactCount(row.totals.requests)}>{compactCount(row.totals.requests)}</td>
                  {/* Nothing reported is not zero: a row whose every call came back
                      without counts says so instead of printing 0. */}
                  {silent ? (
                    <>
                      <td className="num" title="The server reported no token counts">—</td>
                      <td className="num" title="The server reported no token counts">—</td>
                    </>
                  ) : (
                    <>
                      <td className="num" title={exactCount(row.totals.input)}>{compactCount(row.totals.input)}</td>
                      <td className="num" title={exactCount(row.totals.output)}>{compactCount(row.totals.output)}</td>
                    </>
                  )}
                  <td className="num" title={exactCount(row.totals.cached)}>{row.totals.cached ? compactCount(row.totals.cached) : "—"}</td>
                  <td className="num">{speed !== undefined ? speed.toFixed(1) : "—"}</td>
                  <td className="num">
                    {row.totals.priced ? money(row.totals.cost) : row.where === "local" ? "free" : "—"}
                  </td>
                  <td className="usage-share-col">
                    <span className="usage-share" aria-label={`${Math.round(share * 100)}%`}>
                      <span style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canDrill ? <p className="hint">Click a row to show only that {DIMENSION_WORDS[dim].toLowerCase()}.</p> : null}
    </section>
  );
}

function Media({ summary }: { summary: UsageSummary }) {
  const { transcription, speech, image } = summary.media;
  if (!transcription.requests && !speech.requests && !image.requests) return null;
  const failed = (n: number): string => (n ? ` (${n} failed)` : "");
  return (
    <section className="usage-media">
      <h4 className="pane-sub">Speech and images</h4>
      <ul className="plain">
        {transcription.requests ? (
          <li>
            Heard {audioLength(transcription.seconds)} of audio in {transcription.requests} transcription
            {transcription.requests === 1 ? "" : "s"}{failed(transcription.errors)}
          </li>
        ) : null}
        {speech.requests ? (
          <li>
            Spoke {compactCount(speech.characters)} characters in {speech.requests} repl
            {speech.requests === 1 ? "y" : "ies"}{failed(speech.errors)}
          </li>
        ) : null}
        {image.requests ? (
          <li>
            Drew {image.images} image{image.images === 1 ? "" : "s"}
            {image.images ? `, ${Math.round(image.ms / image.images / 1000)} s each on average` : ""}
            {failed(image.errors)}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
