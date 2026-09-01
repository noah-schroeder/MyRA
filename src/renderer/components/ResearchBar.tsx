import { useEffect, useState } from "react";
import type { ResearchConfig, ResearchMode } from "../types.ts";

/**
 * One control for the whole question of how far Karen may reach.
 *
 * Four of these five choices are a ladder, each rung a superset of the one
 * below: nothing, then your files, then the literature, then the literature
 * done properly. The fifth takes the model out of the loop entirely and hands
 * the query to OpenAlex and arXiv directly. They were two separate controls --
 * a mode switch here and a "Look up papers" button beside it -- which read as
 * unrelated features when they are really one decision, and hid the fastest of
 * them behind a modal.
 *
 * The labels name what each rung can reach, not how hard it tries, because the
 * thing a person needs to predict is what Karen might do without being asked.
 * "Off" in particular has to be true: it used to leave the three document tools
 * in the schema, so a model greeted with "hi" had something to call and called
 * it, under a button that said the opposite.
 *
 * "Look up" is deliberately not a persisted mode. It changes nothing about what
 * the agent may do on your next turn; it changes where the composer sends what
 * you type. Leaving it restores the mode you had, rather than silently having
 * turned research off while you were reading.
 */
const MODES: { value: ResearchMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No tools at all. The model answers from what it knows, and cannot search, open a URL, or touch a file." },
  { value: "assistant", label: "Documents", hint: "The model can read and write in your documents folder. It still cannot reach the network." },
  { value: "web", label: "Quick", hint: "The model searches OpenAlex and arXiv, and cites what it used. Seconds." },
  { value: "deep", label: "Deep", hint: "Plan, search, read, verify and synthesise a cited report. Minutes." },
];

const LOOKUP_HINT = "Search OpenAlex and arXiv yourself. No model, no waiting, nothing logged.";

/* Scholarly is the only body of literature this build can search, so it is not
   offered as a choice; it is stored so the setting survives a future one. */
const CATEGORY = "science";

/**
 * Where to search.
 *
 * One live option, so no control.
 *
 * The general-web choice used to sit here greyed out, on the reasoning that a
 * capability the app supports should not be hidden just because no backend
 * ships. In use it reads as a broken control -- the only thing a permanently
 * disabled item teaches is that something is wrong -- and a select with a
 * single option is not a choice either. What both searching modes do is said
 * instead in the tooltip on the mode itself, which is where someone is already
 * looking when they decide how hard to search.
 */

export function ResearchBar({
  lookup,
  onLookup,
  onLeaveLookup,
}: {
  lookup: boolean;
  onLookup: () => void;
  onLeaveLookup: () => void;
}) {
  /* Matches DEFAULT_RESEARCH in core/research/config.ts. The real value lands a
     tick later from getResearch(); starting at "off" would light the wrong
     button on every launch and then move it. */
  const [config, setConfig] = useState<ResearchConfig>({ mode: "assistant", category: "science" });

  useEffect(() => {
    void window.karen.getResearch().then(setConfig);
  }, []);

  const apply = (patch: Partial<ResearchConfig>): void => {
    const next = { ...config, category: CATEGORY, ...patch };
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

    </div>
  );
}
