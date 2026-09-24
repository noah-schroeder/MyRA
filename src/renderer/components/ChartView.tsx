import { useEffect, useMemo, useRef, useState } from "react";

import { CANVAS_H, CANVAS_W, chartSizeFor, layoutChart, type ChartLayout, type ChartSize } from "../../core/charts/layout.ts";
import {
  barRect, boxRect, errorBarPath, frameRect, gridLineY, histRect, markerPath, medianLine,
  seriesLinePath, toChartSvg, whiskerPath,
} from "../../core/charts/svg.ts";
import { pgfplotsOf } from "../../core/charts/pgfplots.ts";
import { PNG_SCALE_PAGE, PNG_SCALE_STANDARD, type ExportSize } from "../../core/figures/exportSize.ts";
import type { ChartUpdate } from "../types.ts";
import { useSaid } from "./useSaid.ts";
import { svgToPng } from "./rasterise.ts";
import { ExportSizeSelect, pageBoxForExport, useExportSize } from "./ExportSize.tsx";

const SCREEN_PALETTE = [
  "var(--chart-1, #0072b2)", "var(--chart-2, #d55e00)", "var(--chart-3, #009e73)",
  "var(--chart-4, #cc79a7)", "var(--chart-5, #e69f00)", "var(--chart-6, #56b4e9)",
];
function screenColor(i: number): string {
  return SCREEN_PALETTE[i % SCREEN_PALETTE.length]!;
}

/** Before the canvas has been measured -- the first paint only, corrected by
 *  the ResizeObserver below on the same frame it fires. */
const INITIAL_SIZE: ChartSize = { width: 360, height: 280 };

/**
 * A figure `create_chart` built, drawn from its `ChartData` every time it is
 * shown -- the same reasoning as `DiagramView`: what travels is the pure
 * numbers, not a picture of them, so the figure can be re-themed and
 * re-exported without ever having been rasterised until Export is pressed.
 *
 * Every element here is constructed from `layoutChart`'s own output, using
 * the same path-building functions `toChartSvg` uses for the exported file
 * -- never a string parsed into markup -- so the on-screen figure and the
 * exported one are guaranteed to be the same geometry.
 *
 * On screen the chart redraws at the canvas's own measured size, unlike a
 * diagram, which scrolls: a diagram's labels are its entire content and
 * shrinking them defeats the point, but a chart has no fixed geometry to
 * preserve -- its axes, ticks and marks are all recomputed from the data at
 * whatever size they are asked to fill, so there is nothing lost by asking
 * for a different size. Export answers a different question from what fits
 * the panel, so it is a separate, explicit choice -- see ExportSize.tsx.
 */
export function ChartView({ chart: item }: { chart: ChartUpdate }) {
  const [said, say] = useSaid();
  const [exportSize, setExportSize] = useExportSize("chart");
  const canvasRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<ChartSize>(INITIAL_SIZE);

  /* Redraws the chart to fill the canvas box whenever it changes size --
     dragging the artifact panel's edge, or resizing the window -- rather
     than leaving the fixed-size figure to overflow it. Set only when the
     rounded size actually changes, so this cannot loop against its own
     layout pass. */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const size = chartSizeFor({ width: box.width, height: box.height });
      setAvail((prev) => (prev.width === size.width && prev.height === size.height ? prev : size));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartOpts = useMemo(
    () => ({
      ...(item.spec.title ? { title: item.spec.title } : {}),
      ...(item.spec.xLabel ? { xLabel: item.spec.xLabel } : (item.spec.x ? { xLabel: item.spec.x } : {})),
      ...(item.spec.yLabel ? { yLabel: item.spec.yLabel } : {}),
    }),
    [item.spec],
  );

  const layout: ChartLayout = useMemo(
    () => layoutChart(item.data, { ...chartOpts, size: avail }),
    [item.data, chartOpts, avail],
  );

  /** The export figure is laid out separately from the on-screen one, at
   *  whichever of the three sizes the picker holds -- never at `avail`,
   *  which is an artifact of how wide the panel happens to be right now. */
  const exportLayout = (): { layout: ChartLayout; physical?: { widthIn: number; heightIn: number } } => {
    const box = pageBoxForExport(exportSize);
    const built = layoutChart(item.data, { ...chartOpts, ...(box ? { size: { width: box.width, height: box.height } } : {}) });
    return { layout: built, ...(box ? { physical: { widthIn: box.widthIn, heightIn: box.heightIn } } : {}) };
  };

  const toPng = async (): Promise<string | undefined> => {
    const { layout: built, physical } = exportLayout();
    const svg = toChartSvg(built, undefined, physical);
    const scale = physical ? PNG_SCALE_PAGE : PNG_SCALE_STANDARD;
    return svgToPng(svg, built.width * scale, built.height * scale);
  };

  const saveSvg = async (): Promise<void> => {
    const { layout: built, physical } = exportLayout();
    const res = await window.myra.chartSave(item.title, "svg", toChartSvg(built, undefined, physical));
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  const savePng = async (): Promise<void> => {
    const data = await toPng();
    if (!data) { say("Could not rasterise it"); return; }
    const res = await window.myra.chartSave(item.title, "png", data);
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  const copyImage = async (): Promise<void> => {
    const data = await toPng();
    if (!data) { say("Could not rasterise it"); return; }
    const res = await window.myra.chartCopyImage(data);
    say(res.ok ? "Figure copied" : res.error ?? "Could not copy it");
  };

  const pgfplots = (): string =>
    pgfplotsOf(item.data, {
      ...(item.spec.title ? { title: item.spec.title } : {}),
      ...(item.spec.xLabel ? { xLabel: item.spec.xLabel } : {}),
      ...(item.spec.yLabel ? { yLabel: item.spec.yLabel } : {}),
    });

  const copyPgfplots = (): void => {
    void window.myra.copy(pgfplots());
    say("PGFPlots source copied");
  };

  const savePgfplots = async (): Promise<void> => {
    const res = await window.myra.chartSave(item.title, "tex", pgfplots());
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  return (
    <div className="ch">
      <div className="ch-canvas" ref={canvasRef}>
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={item.title}
          className="ch-svg"
        >
          {layout.title ? (
            <text x={layout.width / 2} y={18} textAnchor="middle" className="ch-title">{layout.title}</text>
          ) : null}

          {layout.yTicks.map((t, i) => (
            <g key={`y${i}`}>
              <path d={gridLineY(t.pos, layout)} className="ch-grid" />
              <text x={layout.plot.x - 8} y={t.pos + 4} textAnchor="end" className="ch-tick">{t.label}</text>
            </g>
          ))}
          {(layout.xTicks ?? layout.categoryTicks ?? []).map((t, i) => (
            <text key={`x${i}`} x={t.pos} y={layout.plot.y + layout.plot.h + 16} textAnchor="middle" className="ch-tick">
              {t.label}
            </text>
          ))}
          <path d={frameRect(layout)} className="ch-frame" fill="none" />

          {layout.xLabel ? (
            <text x={layout.plot.x + layout.plot.w / 2} y={layout.height - 8} textAnchor="middle" className="ch-axis-label">
              {layout.xLabel}
            </text>
          ) : null}
          {layout.yLabel ? (
            <text
              x={14} y={layout.plot.y + layout.plot.h / 2} textAnchor="middle" className="ch-axis-label"
              transform={`rotate(-90 14 ${layout.plot.y + layout.plot.h / 2})`}
            >
              {layout.yLabel}
            </text>
          ) : null}

          {(layout.series ?? []).map((series) => (
            <g key={series.name}>
              {layout.kind === "line" ? (
                <path d={seriesLinePath(series)} fill="none" stroke={screenColor(series.colorIndex)} strokeWidth={2} />
              ) : null}
              {series.points.map((p, i) => (
                <g key={i}>
                  {p.errorTop !== undefined && p.errorBottom !== undefined ? (
                    <path d={errorBarPath(p.x, p.errorTop, p.errorBottom)} stroke={screenColor(series.colorIndex)} strokeWidth={1.2} />
                  ) : null}
                  <path d={markerPath(p.x, p.y)} fill={screenColor(series.colorIndex)} />
                </g>
              ))}
            </g>
          ))}

          {layout.fit ? (
            <g>
              <path
                d={`M ${layout.fit.x1} ${layout.fit.y1} L ${layout.fit.x2} ${layout.fit.y2}`}
                className="ch-fit" fill="none"
              />
              <text x={layout.plot.x + layout.plot.w - 4} y={layout.plot.y + 14} textAnchor="end" className="ch-fit-label">
                {layout.fit.label}
              </text>
            </g>
          ) : null}

          {(layout.bars ?? []).map((bar, i) => {
            const r = barRect(bar);
            return (
              <g key={i}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={screenColor(bar.colorIndex)} />
                {bar.errorTop !== undefined && bar.errorBottom !== undefined ? (
                  <path d={errorBarPath(bar.x + bar.w / 2, bar.errorTop, bar.errorBottom)} className="ch-frame" />
                ) : null}
              </g>
            );
          })}

          {(layout.boxes ?? []).map((box, i) => {
            const r = boxRect(box);
            return (
              <g key={i}>
                <path d={whiskerPath(box)} className="ch-frame" fill="none" />
                <rect x={r.x} y={r.y} width={r.w} height={r.h} className="ch-box" />
                <path d={medianLine(box)} className="ch-median" />
                {box.outliers.map((o, j) => (
                  <path key={j} d={markerPath(box.x, o, 2.5)} fill="none" className="ch-frame" />
                ))}
              </g>
            );
          })}

          {(layout.histogram ?? []).map((bar, i) => {
            const r = histRect(bar);
            return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={screenColor(0)} />;
          })}

          {layout.legend.map((entry) => (
            <g key={entry.name}>
              <rect x={entry.x} y={entry.y - 8} width={10} height={10} fill={screenColor(entry.colorIndex)} />
              <text x={entry.x + 14} y={entry.y + 1} className="ch-tick">{entry.name}</text>
            </g>
          ))}
        </svg>
      </div>

      <div className="dg-acts">
        <ExportSizeSelect
          value={exportSize}
          onChange={(v: ExportSize) => setExportSize(v)}
          standardLabel={`${CANVAS_W} × ${CANVAS_H}`}
        />
        <button type="button" className="artifact-open" onClick={() => void saveSvg()}>Save SVG</button>
        <button type="button" className="artifact-open" onClick={() => void savePng()}>Save PNG</button>
        <button type="button" className="artifact-open" onClick={() => void copyImage()}>Copy figure</button>
        <button type="button" className="artifact-open" onClick={copyPgfplots}>Copy PGFPlots</button>
        <button type="button" className="artifact-open" onClick={() => void savePgfplots()}>Save .tex</button>
        {said ? <span className="dg-said">{said}</span> : null}
      </div>
    </div>
  );
}
