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

const CATEGORIES = [
  { value: "science", label: "Scholarly", hint: "OpenAlex, arXiv, Crossref, Semantic Scholar" },
  { value: "general", label: "General web", hint: "Needs a backend configured in Settings" },
];

export function ResearchBar({ onNotice }: { onNotice?: (text: string) => void }) {
  const [config, setConfig] = useState<ResearchConfig>({ mode: "off", category: "science" });
  const [webAvailable, setWebAvailable] = useState(true);

  useEffect(() => {
    void window.karen.getResearch().then(setConfig);
  }, []);

  const apply = (patch: Partial<ResearchConfig>): void => {
    const next = { ...config, ...patch };
    setConfig(next);
    void window.karen.setResearch(next);
    if (patch.category === "general" && !webAvailable) {
      onNotice?.(
        "General web search has no backend configured. Scholarly search works without one.",
      );
    }
  };

  useEffect(() => {
    // A general-web provider is optional and usually absent, so say so before
    // the user picks it and gets an empty result they cannot explain.
    void window.karen.getResearch().then(() => setWebAvailable(false));
  }, []);

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
            <option key={c.value} value={c.value} title={c.hint}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
