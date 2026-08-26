import { useEffect, useState } from "react";
import type { ResearchConfig, ResearchMode } from "../types.ts";

/**
 * One control for the whole question of how a search happens.
 *
 * Three of these four choices decide how hard the *model* looks; the fourth
 * takes the model out of the loop and hands the query to OpenAlex and arXiv
 * directly. They were two separate controls -- a mode switch here and a "Look
 * up papers" button beside it -- which read as unrelated features when they are
 * really one decision with four answers, and hid the fastest of them behind a
 * modal.
 *
 * "Look up" is deliberately not a persisted research mode. It changes nothing
 * about what the agent may do on your next turn; it changes where the composer
 * sends what you type. Leaving it restores the mode you had, rather than
 * silently having turned research off while you were reading.
 */
const MODES: { value: ResearchMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The model answers from what it knows." },
  { value: "web", label: "Quick", hint: "The model searches and cites. Seconds." },
  { value: "deep", label: "Deep", hint: "Plan, read, verify, synthesise. Minutes." },
];

const LOOKUP_HINT = "Search OpenAlex and arXiv yourself. No model, no waiting, nothing logged.";

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
  { value: "science", label: "Scholarly", hint: "Searches OpenAlex and arXiv; resolves open-access full text via Semantic Scholar" },
  {
    value: "general",
    label: "General web (no backend yet)",
    hint: "Scholarly search needs no setup; general web search needs a backend this build does not ship.",
    disabled: true,
  },
];

export function ResearchBar({
  lookup,
  onLookup,
  onLeaveLookup,
}: {
  lookup: boolean;
  onLookup: () => void;
  onLeaveLookup: () => void;
}) {
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
      <div className="research-modes" role="group" aria-label="How to search">
        {MODES.map((m) => {
          const on = !lookup && config.mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              aria-pressed={on}
              className={on ? "mode active" : "mode"}
              onClick={() => {
                onLeaveLookup();
                apply({ mode: m.value });
              }}
            >
              {m.label}
            </button>
          );
        })}
        <button
          type="button"
          title={LOOKUP_HINT}
          aria-pressed={lookup}
          className={lookup ? "mode lookup active" : "mode lookup"}
          onClick={onLookup}
        >
          Look up
        </button>
      </div>

      {/* Lookup is scholarly by construction -- it queries OpenAlex and arXiv
          and nothing else -- so the choice does not apply while it is on. */}
      {config.mode !== "off" && !lookup ? (
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
