import { useMemo } from "react";

import { layoutChart, type ChartLayout } from "../../core/charts/layout.ts";
import {
  barRect, boxRect, errorBarPath, frameRect, gridLineY, histRect, markerPath, medianLine,
  seriesLinePath, toChartSvg, whiskerPath,
} from "../../core/charts/svg.ts";
import { pgfplotsOf } from "../../core/charts/pgfplots.ts";
import type { ChartUpdate } from "../types.ts";
import { useSaid } from "./useSaid.ts";

const SCREEN_PALETTE = [
  "var(--chart-1, #0072b2)", "var(--chart-2, #d55e00)", "var(--chart-3, #009e73)",
  "var(--chart-4, #cc79a7)", "var(--chart-5, #e69f00)", "var(--chart-6, #56b4e9)",
];
function screenColor(i: number): string {
  return SCREEN_PALETTE[i % SCREEN_PALETTE.length]!;
}

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
 */
export function ChartView({ chart: item }: { chart: ChartUpdate }) {
  const [said, say] = useSaid();

  const layout: ChartLayout = useMemo(
    () => layoutChart(item.data, {
      ...(item.spec.title ? { title: item.spec.title } : {}),
      ...(item.spec.xLabel ? { xLabel: item.spec.xLabel } : (item.spec.x ? { xLabel: item.spec.x } : {})),
      ...(item.spec.yLabel ? { yLabel: item.spec.yLabel } : {}),
    }),
    [item.data, item.spec],
  );

  const toPng = async (): Promise<string | undefined> => {
    const svg = toChartSvg(layout);
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    const image = new Image();
    const loaded = new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
    });
    image.src = url;
    if (!(await loaded)) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = layout.width * 2;
    canvas.height = layout.height * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };

  const saveSvg = async (): Promise<void> => {
    const res = await window.myra.chartSave(item.title, "svg", toChartSvg(layout));
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
      <div className="ch-canvas">
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

          {layout.legend.map((entry, i) => {
            const lx = layout.plot.x + layout.plot.w + 14;
            const ly = layout.plot.y + 8 + i * 18;
            return (
              <g key={entry.name}>
                <rect x={lx} y={ly - 8} width={10} height={10} fill={screenColor(entry.colorIndex)} />
                <text x={lx + 14} y={ly + 1} className="ch-tick">{entry.name}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="dg-acts">
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
