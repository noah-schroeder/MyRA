import { useMemo } from "react";

import { parseMermaid } from "../../core/diagrams/mermaid.ts";
import { layoutDiagram, type PlacedNode } from "../../core/diagrams/layout.ts";
import {
  arrowHead, dashFor, edgePath, lineY, nodePath, strokeFor, subroutineBars, textAnchorAt, textTurn, toSvg,
} from "../../core/diagrams/svg.ts";
import { prismaLayout } from "../../core/prisma/layout.ts";
import type { DiagramUpdate } from "../types.ts";
import { useSaid } from "./useSaid.ts";

/**
 * A figure, drawn from its source every time it is shown -- Mermaid parsed and
 * laid out, or a PRISMA figure placed directly, whichever `diagram` carries.
 *
 * The source is what travels, not a picture of it: an image would be a
 * screenshot the app could never re-theme, re-export at a different size, or
 * redraw when the layout improved. Placing either kind is microseconds, so
 * there is nothing to cache.
 *
 * Every element here is constructed, never parsed out of a string -- which is
 * the promise `Markdown.tsx` makes two files away, and has to be kept here for
 * the same reason: a diagram's labels are model output, sometimes quoted from a
 * page the model fetched. A label becomes the text of a `<text>` node and can
 * be nothing else.
 *
 * Colours come from CSS so the figure follows the app's theme on screen, while
 * export uses `PAPER_THEME` and is always light -- a figure goes into a
 * manuscript, and one exported in dark mode arrives as white text on white.
 */
export function DiagramView({ diagram }: { diagram: DiagramUpdate }) {
  const [said, say] = useSaid();

  const drawn = useMemo(() => {
    if (diagram.prisma) return { layout: prismaLayout(diagram.prisma) } as const;
    const parsed = parseMermaid(diagram.source ?? "");
    if (!parsed.ok) return { error: `Line ${parsed.line}: ${parsed.error}` } as const;
    return { layout: layoutDiagram(parsed.diagram) } as const;
  }, [diagram.source, diagram.prisma]);

  /* Rasterised from the exported SVG rather than from what is on screen: the
     two must be the same picture, and the on-screen one carries the app's
     theme. Two-times scale, because a figure lands in a document at print
     resolution and a 1x PNG of a 500px diagram looks soft next to the text. */
  const toPng = async (): Promise<string | undefined> => {
    if (!("layout" in drawn)) return undefined;
    const { layout } = drawn;
    const svg = toSvg(layout);
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
    if (!("layout" in drawn)) return;
    const res = await window.myra.diagramSave(diagram.title, "svg", toSvg(drawn.layout));
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  const savePng = async (): Promise<void> => {
    const data = await toPng();
    if (!data) { say("Could not rasterise it"); return; }
    const res = await window.myra.diagramSave(diagram.title, "png", data);
    say(res.ok ? "Saved to Documents" : res.error ?? "Could not save it");
  };

  const copyImage = async (): Promise<void> => {
    const data = await toPng();
    if (!data) { say("Could not rasterise it"); return; }
    const res = await window.myra.diagramCopyImage(data);
    say(res.ok ? "Figure copied" : res.error ?? "Could not copy it");
  };

  const copySource = (): void => {
    if (!diagram.source) return;
    void window.myra.copy(diagram.source);
    say("Source copied");
  };

  /* Reopens the same figure's form, prefilled with what is on screen, and
     redraws it in place on the id it already has -- the push this triggers
     re-renders this component with the corrected diagram, so there is
     nothing else for this handler to update itself. */
  const editNumbers = async (): Promise<void> => {
    if (!diagram.prisma) return;
    const res = await window.myra.prismaEdit(diagram.id, diagram.title, diagram.prisma);
    say(res.ok ? "Updated" : res.error ?? "Could not update it");
  };

  if ("error" in drawn) {
    /* Reachable although the tool validates before announcing: a source edited
       by hand, or one drawn by a build of MyRA whose parser has since narrowed.
       The source is shown because it is the only thing left to act on. A
       PRISMA figure never reaches this branch -- placing one cannot fail. */
    return (
      <div className="dg-broken">
        <p className="dg-broken-why">This diagram could not be drawn. {drawn.error}</p>
        <pre className="md-pre"><code>{diagram.source ?? ""}</code></pre>
      </div>
    );
  }

  const { layout } = drawn;

  return (
    <div className="dg">
      <div className="dg-canvas">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={diagram.title}
          className="dg-svg"
        >
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
                {e.label && e.labelAt ? (
                  <g>
                    <rect
                      className="dg-elabel-bg"
                      x={e.labelAt.x - (e.label.length * 7.2) / 2 - 4}
                      y={e.labelAt.y - 9}
                      width={e.label.length * 7.2 + 8}
                      height={18}
                      rx={3}
                    />
                    <text className="dg-elabel" x={e.labelAt.x} y={e.labelAt.y + 4} textAnchor="middle">
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
            const texts = n.lines.map((line, i) => (
              <text key={i} className="dg-text" x={x} y={lineY(n, i, n.lines.length)} textAnchor={anchor}>
                {line}
              </text>
            ));
            return (
              <g key={n.id}>
                <path d={nodePath(n)} className={n.box?.tint ? "dg-node dg-tint" : "dg-node"} />
                {bars ? <path d={bars} className="dg-node-bars" fill="none" /> : null}
                {turn ? <g transform={turn}>{texts}</g> : texts}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="dg-acts">
        {/* SVG first: it is the vector one, and the one a journal asks for. */}
        <button type="button" className="artifact-open" onClick={() => void saveSvg()}>
          Save SVG
        </button>
        <button type="button" className="artifact-open" onClick={() => void savePng()}>
          Save PNG
        </button>
        <button type="button" className="artifact-open" onClick={() => void copyImage()}>
          Copy figure
        </button>
        {diagram.prisma ? (
          <button type="button" className="artifact-open" onClick={() => void editNumbers()}>
            Edit numbers
          </button>
        ) : (
          <button type="button" className="artifact-open" onClick={copySource}>
            Copy source
          </button>
        )}
        {said ? <span className="dg-said">{said}</span> : null}
      </div>
    </div>
  );
}
