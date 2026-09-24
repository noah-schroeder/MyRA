import { useId, useMemo } from "react";

import { drawDiagram } from "../../core/diagrams/draw.ts";
import type { PlacedNode } from "../../core/diagrams/layout.ts";
import { arrowHead, dashFor, edgePath, hasShadow, lineY, nodePath, strokeFor, subroutineBars, textAnchorAt, textTurn } from "../../core/diagrams/svg.ts";
import type { DiagramUpdate } from "../types.ts";

const THUMB_W = 220;
const THUMB_H = 130;

/**
 * A small, non-interactive preview shown beside the tool card that drew a
 * diagram, so the figure is visible in the chat stream itself rather than
 * only in the side panel.
 *
 * Reuses the exact geometry and element-construction functions
 * DiagramView.tsx does -- never a second drawing routine, and never the
 * exported SVG *string* piped in as markup, which is the one shortcut that
 * would reopen the risk `Markdown.tsx` was built to close (a diagram's
 * labels are model output). Edge labels are left off: at this size they are
 * clutter, not information, and the full panel a click opens still has them.
 *
 * The `viewBox` keeps the diagram's own coordinate space; only the outer
 * `width`/`height` shrink, so SVG's own `preserveAspectRatio` scales the
 * whole figure down for free with no re-layout.
 */
export function DiagramThumbnail({ diagram, onClick }: { diagram: DiagramUpdate; onClick: () => void }) {
  const shadowId = useId();
  const drawn = useMemo(() => drawDiagram(diagram), [diagram.source, diagram.prisma]);

  // Reachable the same way DiagramView.tsx's own error branch is: a source
  // edited by hand, or drawn by a build whose parser has since narrowed. The
  // tool card's plain-text output is the fallback; no broken thumbnail.
  if ("error" in drawn) return null;
  const { layout } = drawn;

  return (
    <button type="button" className="dg-thumb" onClick={onClick} aria-label={`Open figure: ${diagram.title}`}>
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={THUMB_W} height={THUMB_H} aria-hidden="true">
        <defs>
          <filter id={shadowId} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="var(--dg-shadow)" />
          </filter>
        </defs>
        {layout.edges.map((e, i) => {
          const head = arrowHead(e);
          const dash = dashFor(e.style);
          return (
            <g key={`e${i}`}>
              <path
                d={edgePath(e)}
                className="dg-edge"
                fill="none"
                strokeWidth={strokeFor(e.style)}
                {...(dash ? { strokeDasharray: dash } : {})}
              />
              {head ? <path d={head} className="dg-arrow" /> : null}
            </g>
          );
        })}
        {layout.nodes.map((n: PlacedNode) => {
          const bars = subroutineBars(n);
          const { x, anchor } = textAnchorAt(n);
          const turn = textTurn(n);
          const texts = n.lines.map((line, i) => (
            <text key={i} className="dg-text" x={x} y={lineY(n, i, n.lines.length)} textAnchor={anchor}>
              {line}
            </text>
          ));
          return (
            <g key={n.id}>
              <path
                d={nodePath(n)}
                className={
                  n.box?.category !== undefined
                    ? `dg-node dg-cat-${n.box.category}`
                    : n.box?.tint ? "dg-node dg-tint" : "dg-node"
                }
                filter={hasShadow(n) ? `url(#${shadowId})` : undefined}
              />
              {bars ? <path d={bars} className="dg-node-bars" fill="none" /> : null}
              {turn ? <g transform={turn}>{texts}</g> : texts}
            </g>
          );
        })}
      </svg>
    </button>
  );
}
