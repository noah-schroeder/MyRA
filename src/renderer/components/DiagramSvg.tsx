import { useId } from "react";

import type { Layout, PlacedNode } from "../../core/diagrams/layout.ts";
import { LOOKS } from "../../core/diagrams/styles.ts";
import {
  arrowHead, boxPaintStyle, dashFor, edgeColors, edgeLabelBox, edgePath, hasShadow, lineY, nodeColors,
  nodePath, strokeFor, subroutineBars, textAnchorAt, textTurn, type DiagramTheme,
} from "../../core/diagrams/svg.ts";

/**
 * One placed diagram as React elements -- the single drawing routine behind
 * the artifact panel and the chat thumbnail, which used to carry two copies
 * of it.
 *
 * Two colour modes. With no `theme` it is the standard look on screen: colours
 * from CSS classes, so it follows the app's light or dark theme, exactly as
 * figures always have. With a `theme` -- a named look -- every colour is set
 * explicitly from `nodeColors`/`edgeColors`, the same function the exporter
 * uses, on the look's own paper-white ground, so what is on screen is what the
 * file will be.
 *
 * Every element is constructed here, never parsed from the exported string:
 * a diagram's labels are model output, and a label becomes the text of a
 * `<text>` node and can be nothing else -- the promise `Markdown.tsx` makes.
 */
export function DiagramSvg({
  layout,
  theme,
  edgeLabels,
  width,
  height,
  label,
  className,
}: {
  layout: Layout;
  theme?: DiagramTheme | undefined;
  /** Off in a thumbnail, where edge labels are clutter at that size. */
  edgeLabels: boolean;
  width: number;
  height: number;
  /** An accessible name; absent marks the drawing decorative. */
  label?: string | undefined;
  className?: string | undefined;
}) {
  /* A conversation can hold several diagrams, so a literal filter id would
     collide the moment two are on screen at once -- the same reason svg.ts
     draws arrowheads as triangles instead of `<marker>` refs. */
  const shadowId = useId();
  const look = layout.look ?? LOOKS.standard;

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={width}
      height={height}
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...(theme ? { fontFamily: look.fontFamily, fontSize: look.fontSize, fontWeight: look.fontWeight } : {})}
    >
      {look.shadow ? (
        <defs>
          <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow
              dx="0"
              dy={look.shadowDy}
              stdDeviation={look.shadowBlur}
              floodColor={theme ? theme.shadowColor : "var(--dg-shadow)"}
            />
          </filter>
        </defs>
      ) : null}
      {theme ? <rect width={layout.width} height={layout.height} fill={theme.background} /> : null}

      {layout.edges.map((e, i) => {
        const head = arrowHead(e, look);
        const dash = dashFor(e.style);
        const box = edgeLabels ? edgeLabelBox(e, look) : undefined;
        const colors = theme ? edgeColors(e, theme, look) : undefined;
        return (
          <g key={`e${i}`}>
            <path
              d={edgePath(e, look)}
              fill="none"
              {...(dash ? { strokeDasharray: dash } : {})}
              {...(colors
                ? { stroke: colors.stroke, strokeWidth: colors.width }
                : {
                    className: "dg-edge",
                    strokeWidth: strokeFor(e.style, e.paint?.strokeWidth, look),
                    ...(e.paint?.stroke ? { style: { stroke: e.paint.stroke } } : {}),
                  })}
            />
            {head ? (
              <path
                d={head}
                {...(colors
                  ? { fill: colors.stroke }
                  : { className: "dg-arrow", ...(e.paint?.stroke ? { style: { fill: e.paint.stroke } } : {}) })}
              />
            ) : null}
            {box && e.label && e.labelAt ? (
              <g>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={3}
                  {...(theme ? { fill: theme.edgeLabelBg } : { className: "dg-elabel-bg" })}
                />
                <text
                  x={e.labelAt.x}
                  y={box.textY}
                  textAnchor="middle"
                  {...(colors
                    ? { fill: colors.label, fontSize: box.fontSize }
                    : { className: "dg-elabel", ...(e.paint?.text ? { style: { fill: e.paint.text } } : {}) })}
                >
                  {e.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {layout.nodes.map((n: PlacedNode) => {
        const bars = subroutineBars(n);
        const { x, anchor } = textAnchorAt(n);
        const turn = textTurn(n);
        const colors = theme ? nodeColors(n, theme, look) : undefined;
        const texts = n.lines.map((line, i) => (
          <text
            key={i}
            x={x}
            y={lineY(n, i, n.lines.length, look)}
            textAnchor={anchor}
            {...(colors
              ? { fill: colors.text }
              : { className: "dg-text", ...(n.box?.text ? { style: { fill: n.box.text } } : {}) })}
          >
            {line}
          </text>
        ));
        return (
          <g key={n.id}>
            <path
              d={nodePath(n, look)}
              filter={hasShadow(n, look) ? `url(#${shadowId})` : undefined}
              {...(colors
                ? { fill: colors.fill, stroke: colors.stroke, strokeWidth: colors.strokeWidth }
                : {
                    className:
                      n.box?.category !== undefined
                        ? `dg-node dg-cat-${n.box.category}`
                        : n.box?.tint ? "dg-node dg-tint" : "dg-node",
                    style: boxPaintStyle(n),
                  })}
            />
            {bars ? (
              <path
                d={bars}
                fill="none"
                {...(colors
                  ? { stroke: colors.stroke, strokeWidth: colors.strokeWidth }
                  : { className: "dg-node-bars", style: { ...boxPaintStyle(n), fill: "none" } })}
              />
            ) : null}
            {turn ? <g transform={turn}>{texts}</g> : texts}
          </g>
        );
      })}
    </svg>
  );
}
