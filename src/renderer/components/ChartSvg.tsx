import type { ChartLayout, PlottedBar } from "../../core/charts/layout.ts";
import {
  barRect, boxRect, errorBarPath, frameRect, gridLineY, histRect, markerPath, medianLine,
  seriesLinePath, whiskerPath,
} from "../../core/charts/svg.ts";

const SCREEN_PALETTE = [
  "var(--chart-1, #0072b2)", "var(--chart-2, #d55e00)", "var(--chart-3, #009e73)",
  "var(--chart-4, #cc79a7)", "var(--chart-5, #e69f00)", "var(--chart-6, #56b4e9)",
];

/** A series' colour on screen -- the legend, the marks, and any table beside the chart. */
export function screenColor(i: number): string {
  return SCREEN_PALETTE[i % SCREEN_PALETTE.length]!;
}

/**
 * One laid-out chart as React elements -- the drawing routine behind the
 * artifact panel's charts and the usage dashboard, the way `DiagramSvg` is
 * behind every diagram.
 *
 * Every element is built from `layoutChart`'s output with the same
 * path-building functions `toChartSvg` uses for the exported file -- never a
 * string parsed into markup -- so the on-screen figure and the exported one
 * are the same geometry. `barTitle` and `onBar` are for a chart somebody
 * explores rather than exports: a tooltip with the exact figure, and a click
 * that filters by what the bar is.
 */
export function ChartSvg({
  layout,
  label,
  barTitle,
  onBar,
}: {
  layout: ChartLayout;
  label: string;
  barTitle?: ((bar: PlottedBar) => string | undefined) | undefined;
  onBar?: ((bar: PlottedBar) => void) | undefined;
}) {
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label={label}
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
        const tip = barTitle?.(bar);
        return (
          <g key={i} {...(onBar ? { onClick: () => onBar(bar), className: "ch-bar-hit" } : {})}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={screenColor(bar.colorIndex)}>
              {tip ? <title>{tip}</title> : null}
            </rect>
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
  );
}
