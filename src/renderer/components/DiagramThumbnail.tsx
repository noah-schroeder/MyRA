import { useMemo } from "react";

import { drawDiagram } from "../../core/diagrams/draw.ts";
import { themeForStyle } from "../../core/diagrams/svg.ts";
import type { DiagramUpdate } from "../types.ts";
import { useDiagramStyle } from "./DiagramStyle.tsx";
import { DiagramSvg } from "./DiagramSvg.tsx";

const THUMB_W = 220;
const THUMB_H = 130;

/**
 * A small, non-interactive preview shown beside the tool card that drew a
 * diagram, so the figure is visible in the chat stream itself rather than
 * only in the side panel.
 *
 * Drawn by DiagramSvg, the same routine the panel uses -- never a second
 * drawing routine, and never the exported SVG *string* piped in as markup,
 * which is the one shortcut that would reopen the risk `Markdown.tsx` was
 * built to close (a diagram's labels are model output). Edge labels are left off: at this size they are
 * clutter, not information, and the full panel a click opens still has them.
 *
 * The `viewBox` keeps the diagram's own coordinate space; only the outer
 * `width`/`height` shrink, so SVG's own `preserveAspectRatio` scales the
 * whole figure down for free with no re-layout.
 */
export function DiagramThumbnail({ diagram, onClick }: { diagram: DiagramUpdate; onClick: () => void }) {
  const [preferred] = useDiagramStyle();
  /* The same rule the panel applies, so the preview in the thread is the look
     the figure will open and export in. */
  const style = diagram.prisma ? "standard" : diagram.style ?? preferred;
  const drawn = useMemo(() => drawDiagram(diagram, style), [diagram.source, diagram.prisma, style]);

  // Reachable the same way DiagramView.tsx's own error branch is: a source
  // edited by hand, or drawn by a build whose parser has since narrowed. The
  // tool card's plain-text output is the fallback; no broken thumbnail.
  if ("error" in drawn) return null;
  const theme = style === "standard" ? undefined : themeForStyle(style);

  return (
    <button
      type="button"
      className={theme ? "dg-thumb paper" : "dg-thumb"}
      onClick={onClick}
      aria-label={`Open figure: ${diagram.title}`}
    >
      <DiagramSvg
        layout={drawn.layout}
        theme={theme}
        edgeLabels={false}
        width={THUMB_W}
        height={THUMB_H}
      />
    </button>
  );
}
