import { useEffect, useState, type ReactNode } from "react";
import type { ResearchConfig, ResearchMode, SearchCategory } from "../types.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";

const MODES: { id: ResearchMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Karen decides whether to search" },
  { id: "web", label: "Web search", hint: "One pass: search and return ranked results" },
  { id: "deep", label: "Deep research", hint: "Multi-question sweep: search, read sources, cite them" },
];

/**
 * The research control.
 *
 * The category list is fetched from the running SearXNG rather than hardcoded,
 * so it shows exactly the categories the user's own engine configuration
 * supports -- and the engine counts make an empty category obvious before it
 * returns nothing.
 */
export function ResearchBar({
  value,
  connected,
  onChange,
  trailing,
}: {
  value: ResearchConfig;
  connected: boolean;
  onChange: (next: ResearchConfig) => void;
  /** Rendered hard against the right edge of the row, above the Send button. */
  trailing?: ReactNode;
}) {
  const [categories, setCategories] = useState<SearchCategory[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await window.karen.getSearchCategories();
      setCategories(res?.categories ?? []);
      setError(res?.categories?.length ? undefined : "SearXNG returned no categories.");
    } catch (err) {
      // Almost always SearXNG being down; say so rather than showing an empty list.
      setError((err as Error).message);
      setCategories([]);
    } finally {
      setLoading(false);
    }
  };

  // Only worth asking once the VM is actually reachable.
  useEffect(() => {
    if (connected && categories.length === 0 && !error) void load();
  }, [connected]);

  /*
   * A time filter is worse than useless where nothing supports it: SearXNG
   * drops every engine that lacks the capability, and when that leaves none the
   * search returns zero results with no error. No scholarly engine supports
   * one, so the control is disabled rather than left to look effective.
   */
  const selected = value.category.split(",").map((c) => c.trim()).filter(Boolean);
  const known = new Map(categories.map((c) => [c.name, c]));
  const timeRangeWorks =
    categories.length === 0 || selected.some((c) => known.get(c)?.timeRange !== false);

  const setMode = (mode: ResearchMode) => {
    // Fetch the list lazily: no point querying SearXNG for a user who never
    // turns research on.
    if (mode !== "off" && categories.length === 0) void load();
    onChange({ ...value, mode });
  };

  return (
    <div className="research-bar">
      <div className="seg" role="group" aria-label="Research mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`seg-btn ${value.mode === m.id ? "on" : ""}`}
            title={m.hint}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {value.mode !== "off" ? (
        <>
          <span className="research-label">searching</span>
          <CategoryPicker
            value={value.category}
            options={categories}
            loading={loading}
            onChange={(category) => {
              // Drop a time filter the new selection cannot honour, rather than
              // leaving a stale value behind a disabled control.
              const names = category.split(",").map((c) => c.trim()).filter(Boolean);
              const works =
                categories.length === 0 || names.some((c) => known.get(c)?.timeRange !== false);
              onChange({ ...value, category, ...(works ? {} : { timeRange: "" as const }) });
            }}
          />

<select
            className="select select-sm"
            value={value.timeRange ?? ""}
            disabled={!timeRangeWorks}
            onChange={(e) => onChange({ ...value, timeRange: e.target.value })}
            title={
              timeRangeWorks
                ? "Restrict to recently published results"
                : `No engine in ${selected.join(" or ")} supports a time filter — ` +
                  `SearXNG would return nothing rather than everything.`
            }
          >
            <option value="">any time</option>
            <option value="day">past day</option>
            <option value="week">past week</option>
            <option value="month">past month</option>
            <option value="year">past year</option>
          </select>

          <button className="btn btn-ghost btn-sm" onClick={() => void load()} title="Reload categories">
            ⟳
          </button>
        </>
      ) : null}

      {error && value.mode !== "off" ? <span className="research-error">{error}</span> : null}

      {trailing ? (
        <>
          <span className="research-spacer" />
          {trailing}
        </>
      ) : null}
    </div>
  );
}
