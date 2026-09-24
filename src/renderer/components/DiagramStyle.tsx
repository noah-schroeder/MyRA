import { useState } from "react";

import { DIAGRAM_STYLES, parseDiagramStyle, STYLE_LABELS, type DiagramStyleName } from "../../core/diagrams/styles.ts";

/**
 * The look a flowchart is drawn in, picked on the figure itself.
 *
 * The model may name a look when asked ("make it poster-style"), and the menu
 * always wins over it: picking here rewrites that figure's own style. The pick
 * is also remembered as the look for figures the model draws without naming
 * one, so a run of figures for one poster comes out as posters without
 * re-picking on every tab -- the reason ExportSize.tsx remembers a size.
 */

const KEY = "myra.diagramStyle";

function readStored(): DiagramStyleName {
  try {
    return parseDiagramStyle(localStorage.getItem(KEY)) ?? "standard";
  } catch {
    return "standard";
  }
}

export function useDiagramStyle(): [DiagramStyleName, (v: DiagramStyleName) => void] {
  const [style, setStyle] = useState<DiagramStyleName>(readStored);
  const set = (v: DiagramStyleName): void => {
    setStyle(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* Best effort; the picker still works, it just forgets. */
    }
  };
  return [style, set];
}

export function DiagramStyleSelect({
  value,
  onChange,
}: {
  value: DiagramStyleName;
  onChange: (v: DiagramStyleName) => void;
}) {
  return (
    <select
      className="fig-size"
      aria-label="Figure style"
      title="How the figure looks, on screen and in every export"
      value={value}
      onChange={(e) => onChange(parseDiagramStyle(e.target.value) ?? "standard")}
    >
      {DIAGRAM_STYLES.map((s) => (
        <option key={s} value={s}>
          {STYLE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
