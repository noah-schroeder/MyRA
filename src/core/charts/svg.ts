/**
 * Turning a laid-out chart into shapes, and into an SVG file.
 *
 * Two consumers, one set of numbers -- exactly diagrams/svg.ts's own
 * arrangement, for the same reason: the renderer maps these functions onto
 * React elements and `toChartSvg` writes the same strings into a standalone
 * file, so a figure never exports differently from how it looked on screen.
 *
 * `xmlEscape` is imported rather than reimplemented. A chart's tick labels
 * and series names are as capable of carrying a stray `<` or `&` as a
 * diagram's node labels are, and a second, separately-maintained escaper is
 * exactly the kind of duplication that drifts.
 */

import { xmlEscape } from "../diagrams/svg.ts";
import { FONT_SIZE, type ChartLayout, type HistBar, type PlottedBar, type PlottedBox, type PlottedSeries } from "./layout.ts";

export { xmlEscape };

export interface ChartTheme {
  background: string;
  axis: string;
  grid: string;
  text: string;
  textDim: string;
  palette: string[];
}

/**
 * White, dark axes, black text -- the export default regardless of the app's
 * theme, exactly as diagrams/svg.ts's `PAPER_THEME` is: a figure goes into a
 * manuscript, and one exported in dark mode arrives as white text on white.
 * The palette is colour-blind-safe (Okabe-Ito), the same reasoning most
 * journals now ask for explicitly.
 */
export const PAPER_THEME: ChartTheme = {
  background: "#ffffff",
  axis: "#33373f",
  grid: "#e4e6ea",
  text: "#14161a",
  textDim: "#5b6270",
  palette: ["#0072b2", "#d55e00", "#009e73", "#cc79a7", "#e69f00", "#56b4e9", "#000000"],
};

function colorFor(theme: ChartTheme, i: number): string {
  return theme.palette[i % theme.palette.length]!;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The plot area's border, as a path. */
export function frameRect(layout: ChartLayout): string {
  const { x, y, w, h } = layout.plot;
  return `M ${round(x)} ${round(y)} h ${round(w)} v ${round(h)} h ${round(-w)} Z`;
}

/** One horizontal gridline at a y-tick's device position. */
export function gridLineY(y: number, layout: ChartLayout): string {
  return `M ${round(layout.plot.x)} ${round(y)} h ${round(layout.plot.w)}`;
}

/** A scatter/line point marker: a small circle, drawn as a path so it needs
 *  no `<circle>` element of its own. */
export function markerPath(x: number, y: number, r = 3.5): string {
  return `M ${round(x - r)} ${round(y)} a ${r} ${r} 0 1 0 ${round(r * 2)} 0 a ${r} ${r} 0 1 0 ${round(-r * 2)} 0 Z`;
}

/** A line series' own polyline. */
export function seriesLinePath(series: PlottedSeries): string {
  return series.points.map((p, i) => `${i ? "L" : "M"} ${round(p.x)} ${round(p.y)}`).join(" ");
}

/** One point's error bar, as a path -- a vertical line with two short caps. */
export function errorBarPath(x: number, top: number, bottom: number, capHalf = 4): string {
  return (
    `M ${round(x)} ${round(top)} L ${round(x)} ${round(bottom)} ` +
    `M ${round(x - capHalf)} ${round(top)} L ${round(x + capHalf)} ${round(top)} ` +
    `M ${round(x - capHalf)} ${round(bottom)} L ${round(x + capHalf)} ${round(bottom)}`
  );
}

export function barRect(bar: PlottedBar): { x: number; y: number; w: number; h: number } {
  return { x: round(bar.x), y: round(bar.yTop), w: round(bar.w), h: round(Math.max(0, bar.yBottom - bar.yTop)) };
}

export function histRect(bar: HistBar, gap = 1): { x: number; y: number; w: number; h: number } {
  return {
    x: round(bar.x0 + gap / 2), y: round(bar.yTop),
    w: round(Math.max(0, bar.x1 - bar.x0 - gap)), h: round(Math.max(0, bar.yBottom - bar.yTop)),
  };
}

/** A box plot's whisker: the two vertical lines from the box to each fence,
 *  with a horizontal cap at each end. */
export function whiskerPath(box: PlottedBox): string {
  const half = box.w * 0.3;
  return (
    `M ${round(box.x)} ${round(box.whiskerLo)} L ${round(box.x)} ${round(box.q1)} ` +
    `M ${round(box.x)} ${round(box.q3)} L ${round(box.x)} ${round(box.whiskerHi)} ` +
    `M ${round(box.x - half)} ${round(box.whiskerLo)} L ${round(box.x + half)} ${round(box.whiskerLo)} ` +
    `M ${round(box.x - half)} ${round(box.whiskerHi)} L ${round(box.x + half)} ${round(box.whiskerHi)}`
  );
}

export function boxRect(box: PlottedBox): { x: number; y: number; w: number; h: number } {
  return { x: round(box.x - box.w / 2), y: round(box.q3), w: round(box.w), h: round(Math.max(0, box.q1 - box.q3)) };
}

export function medianLine(box: PlottedBox): string {
  return `M ${round(box.x - box.w / 2)} ${round(box.median)} L ${round(box.x + box.w / 2)} ${round(box.median)}`;
}

/** A standalone SVG file, ready to drop into a manuscript.
 *
 * `physical`, when given, writes the outer `width`/`height` in inches while
 * the `viewBox` stays in layout pixels -- so a document that inserts the file
 * places it at that physical size with no transform of its own. Omitted, the
 * output is exactly what it always was: the on-screen pixel size twice over,
 * which is what pins this function's byte-for-byte output in chartSvg.test.ts. */
export function toChartSvg(
  layout: ChartLayout,
  theme: ChartTheme = PAPER_THEME,
  physical?: { widthIn: number; heightIn: number },
): string {
  const parts: string[] = [];
  const outerW = physical ? `${physical.widthIn}in` : `${layout.width}`;
  const outerH = physical ? `${physical.heightIn}in` : `${layout.height}`;
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerW}" height="${outerH}" ` +
    `viewBox="0 0 ${layout.width} ${layout.height}" font-family="system-ui, -apple-system, ` +
    `'Segoe UI', sans-serif" font-size="${FONT_SIZE}">`,
  );
  parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="${theme.background}"/>`);

  if (layout.title) {
    parts.push(
      `<text x="${round(layout.width / 2)}" y="18" text-anchor="middle" fill="${theme.text}" ` +
      `font-size="${FONT_SIZE + 2}" font-weight="600">${xmlEscape(layout.title)}</text>`,
    );
  }

  for (const t of layout.yTicks) {
    parts.push(`<path d="${gridLineY(t.pos, layout)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(
      `<text x="${round(layout.plot.x - 8)}" y="${round(t.pos + 4)}" text-anchor="end" ` +
      `fill="${theme.textDim}" font-size="${FONT_SIZE - 1}">${xmlEscape(t.label)}</text>`,
    );
  }
  if (layout.xTicks) {
    for (const t of layout.xTicks) {
      parts.push(
        `<text x="${round(t.pos)}" y="${round(layout.plot.y + layout.plot.h + 16)}" text-anchor="middle" ` +
        `fill="${theme.textDim}" font-size="${FONT_SIZE - 1}">${xmlEscape(t.label)}</text>`,
      );
    }
  }
  if (layout.categoryTicks) {
    for (const t of layout.categoryTicks) {
      parts.push(
        `<text x="${round(t.pos)}" y="${round(layout.plot.y + layout.plot.h + 16)}" text-anchor="middle" ` +
        `fill="${theme.textDim}" font-size="${FONT_SIZE - 1}">${xmlEscape(t.label)}</text>`,
      );
    }
  }
  parts.push(`<path d="${frameRect(layout)}" fill="none" stroke="${theme.axis}" stroke-width="1.5"/>`);

  if (layout.xLabel) {
    parts.push(
      `<text x="${round(layout.plot.x + layout.plot.w / 2)}" y="${round(layout.height - 8)}" ` +
      `text-anchor="middle" fill="${theme.text}">${xmlEscape(layout.xLabel)}</text>`,
    );
  }
  if (layout.yLabel) {
    const cx = 14;
    const cy = round(layout.plot.y + layout.plot.h / 2);
    parts.push(
      `<text x="${cx}" y="${cy}" text-anchor="middle" fill="${theme.text}" ` +
      `transform="rotate(-90 ${cx} ${cy})">${xmlEscape(layout.yLabel)}</text>`,
    );
  }

  for (const series of layout.series ?? []) {
    const color = colorFor(theme, series.colorIndex);
    if (layout.kind === "line") {
      parts.push(`<path d="${seriesLinePath(series)}" fill="none" stroke="${color}" stroke-width="2"/>`);
    }
    for (const p of series.points) {
      if (p.errorTop !== undefined && p.errorBottom !== undefined) {
        parts.push(`<path d="${errorBarPath(p.x, p.errorTop, p.errorBottom)}" stroke="${color}" stroke-width="1.2"/>`);
      }
      parts.push(`<path d="${markerPath(p.x, p.y)}" fill="${color}"/>`);
    }
  }

  if (layout.fit) {
    const { x1, y1, x2, y2, label } = layout.fit;
    parts.push(
      `<path d="M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}" stroke="${theme.text}" ` +
      `stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>`,
    );
    parts.push(
      `<text x="${round(layout.plot.x + layout.plot.w - 4)}" y="${round(layout.plot.y + 14)}" ` +
      `text-anchor="end" fill="${theme.textDim}" font-size="${FONT_SIZE - 1}">${xmlEscape(label)}</text>`,
    );
  }

  for (const bar of layout.bars ?? []) {
    const r = barRect(bar);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${colorFor(theme, bar.colorIndex)}"/>`);
    if (bar.errorTop !== undefined && bar.errorBottom !== undefined) {
      parts.push(
        `<path d="${errorBarPath(bar.x + bar.w / 2, bar.errorTop, bar.errorBottom)}" stroke="${theme.axis}" stroke-width="1.2"/>`,
      );
    }
  }

  for (const box of layout.boxes ?? []) {
    parts.push(`<path d="${whiskerPath(box)}" stroke="${theme.axis}" stroke-width="1.3" fill="none"/>`);
    const r = boxRect(box);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${theme.palette[0]}" fill-opacity="0.25" stroke="${theme.axis}" stroke-width="1.3"/>`);
    parts.push(`<path d="${medianLine(box)}" stroke="${theme.axis}" stroke-width="2"/>`);
    for (const o of box.outliers) parts.push(`<path d="${markerPath(box.x, o, 2.5)}" fill="none" stroke="${theme.axis}" stroke-width="1"/>`);
  }

  for (const bar of layout.histogram ?? []) {
    const r = histRect(bar);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${theme.palette[0]}"/>`);
  }

  layout.legend.forEach((entry) => {
    parts.push(
      `<rect x="${round(entry.x)}" y="${round(entry.y - 8)}" width="10" height="10" ` +
      `fill="${colorFor(theme, entry.colorIndex)}"/>`,
    );
    parts.push(
      `<text x="${round(entry.x + 14)}" y="${round(entry.y + 1)}" fill="${theme.text}" ` +
      `font-size="${FONT_SIZE - 1}">${xmlEscape(entry.name)}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}
