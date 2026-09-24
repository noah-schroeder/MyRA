import { useEffect, useState } from "react";

import { pageBox, paperForLocale, parseExportSize, type ExportSize, type PageBox } from "../../core/figures/exportSize.ts";

/**
 * The export-size picker shared by a chart, a flowchart and a PRISMA figure.
 *
 * A chart redraws to fit the panel on screen, but export answers a different
 * question -- what size does this figure need to BE, once it leaves MyRA for
 * a manuscript -- so it is a separate, explicit choice from exactly the three
 * options core/figures/exportSize.ts defines, never derived from whatever the
 * panel happened to be dragged to.
 */

export type ExportKind = "chart" | "diagram" | "prisma";

const KEY_PREFIX = "myra.exportSize.";

/** A PRISMA figure is conventionally a full portrait page; a chart or a
 *  model-drawn flowchart defaults to its own natural size. */
const DEFAULTS: Record<ExportKind, ExportSize> = {
  chart: "standard",
  diagram: "standard",
  prisma: "portrait",
};

function readStored(kind: ExportKind): ExportSize {
  try {
    return parseExportSize(localStorage.getItem(KEY_PREFIX + kind)) ?? DEFAULTS[kind];
  } catch {
    return DEFAULTS[kind];
  }
}

/**
 * Remembered per kind, not globally: a PRISMA figure and a flowchart are
 * drawn by the same component but answer to different defaults, and a run of
 * figures for one paper should come out at one size each without re-picking
 * it on every tab.
 *
 * Re-reads on a `kind` change rather than only at mount, because DiagramView
 * is not remounted when the active tab switches from a flowchart to a PRISMA
 * figure -- only its props change -- so a state initializer alone would keep
 * showing the previous kind's remembered size.
 */
export function useExportSize(kind: ExportKind): [ExportSize, (v: ExportSize) => void] {
  const [size, setSize] = useState<ExportSize>(() => readStored(kind));
  useEffect(() => {
    setSize(readStored(kind));
  }, [kind]);
  const set = (v: ExportSize): void => {
    setSize(v);
    try {
      localStorage.setItem(KEY_PREFIX + kind, v);
    } catch {
      /* Best effort; the picker still works, it just forgets. */
    }
  };
  return [size, set];
}

/** The paper this account's locale implies, read once here so the picker's
 *  labels and the page size ChartView/DiagramView actually export at can
 *  never name two different papers. */
export function pageBoxForExport(size: ExportSize): PageBox | undefined {
  return pageBox(size, paperForLocale(navigator.language));
}

export function ExportSizeSelect({
  value, onChange, standardLabel,
}: {
  value: ExportSize;
  onChange: (v: ExportSize) => void;
  /** "640 × 420" for a chart, "Natural size" for a diagram -- the caller
   *  knows which, this component does not. */
  standardLabel: string;
}) {
  const paperLabel = paperForLocale(navigator.language) === "letter" ? "Letter" : "A4";
  return (
    <select
      className="fig-size"
      aria-label="Export size"
      value={value}
      onChange={(e) => onChange(parseExportSize(e.target.value) ?? "standard")}
    >
      <option value="standard">{standardLabel}</option>
      <option value="portrait">Portrait page ({paperLabel})</option>
      <option value="landscape">Landscape page ({paperLabel})</option>
    </select>
  );
}
