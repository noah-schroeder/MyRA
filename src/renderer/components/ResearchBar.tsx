import { useEffect, useState } from "react";
import type { ResearchConfig, ResearchMode } from "../types.ts";

/**
 * The research control.
 *
 * v1 offered SearXNG's live category list, fetched from the container's
 * /config. There is no container, so the choice is the honest one: which body
 * of literature to search, and how hard to look.
 *
 * The mode does more than filter: picking one gates the tool set, so the model
 * cannot quietly do a shallow lookup when the user asked for a report.
 */
const MODES: { value: ResearchMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The model decides whether to search." },
  { value: "web", label: "Quick", hint: "Search and cite. Seconds." },
  { value: "deep", label: "Deep", hint: "Plan, read, verify, synthesise. Minutes." },
];

/**
 * Where to search.
 *
 * The general-web option is listed and disabled rather than hidden. It is a
 * real capability the app supports and simply has no backend for yet, and a
 * control that quietly does not exist teaches the user the feature does not
 * exist either. Offering it as a live choice would be worse: it would fail at
 * search time, several seconds into a run, with an error about providers.
 */
const CATEGORIES = [
  { value: "science", label: "Scholarly", hint: "OpenAlex, arXiv, Crossref, Semantic Scholar" },
  {
    value: "general",
    label: "General web (no backend yet)",
    hint: "Scholarly search needs no setup; general web search needs a backend this build does not ship.",
    disabled: true,
  },
];

export function ResearchBar() {
  const [config, setConfig] = useState<ResearchConfig>({ mode: "off", category: "science" });

  useEffect(() => {
    void window.karen.getResearch().then(setConfig);
  }, []);

  const apply = (patch: Partial<ResearchConfig>): void => {
    const next = { ...config, ...patch };
    setConfig(next);
    void window.karen.setResearch(next);
  };

  return (
    <div className="research-bar">
      <div className="research-modes" role="group" aria-label="Research depth">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            title={m.hint}
            aria-pressed={config.mode === m.value}
            className={config.mode === m.value ? "mode active" : "mode"}
            onClick={() => apply({ mode: m.value })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {config.mode !== "off" ? (
        <select
          className="research-category"
          aria-label="Where to search"
          value={config.category}
          onChange={(e) => apply({ category: e.target.value })}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value} title={c.hint} disabled={c.disabled ?? false}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
