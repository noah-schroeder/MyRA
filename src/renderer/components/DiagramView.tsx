import { useMemo } from "react";

import { drawDiagram } from "../../core/diagrams/draw.ts";
import type { Layout } from "../../core/diagrams/layout.ts";
import type { DiagramStyleName } from "../../core/diagrams/styles.ts";
import { themeForStyle, toSvg } from "../../core/diagrams/svg.ts";
import { fitWithin, PNG_SCALE_PAGE, PNG_SCALE_STANDARD, PX_PER_IN, type ExportSize } from "../../core/figures/exportSize.ts";
import type { DiagramUpdate } from "../types.ts";
import { useSaid } from "./useSaid.ts";
import { svgToPng } from "./rasterise.ts";
import { ExportSizeSelect, pageBoxForExport, useExportSize } from "./ExportSize.tsx";
import { DiagramStyleSelect, useDiagramStyle } from "./DiagramStyle.tsx";
import { DiagramSvg } from "./DiagramSvg.tsx";

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
 * In the standard look colours come from CSS so the figure follows the app's
 * theme on screen, while export uses `PAPER_THEME` and is always light -- a
 * figure goes into a manuscript, and one exported in dark mode arrives as white
 * text on white. A named look (Journal, Poster, Monochrome -- see
 * core/diagrams/styles.ts) is drawn on screen in exactly its export colours
 * instead, since previewing a poster in dark mode would preview something else.
 * The Style menu always wins over a look the model named.
 *
 * On screen a diagram's own size is never touched by the export choice: the
 * canvas scrolls rather than shrinking it, because a flowchart's labels are
 * its entire content. Export alone offers the natural size, a portrait page
 * or a landscape page -- a PRISMA figure is conventionally a full portrait
 * page and a flowchart a landscape one, and "whatever fits the panel" answers
 * neither. See ExportSize.tsx.
 */
export function DiagramView({
  diagram,
  onRestyle,
}: {
  diagram: DiagramUpdate;
  /** Rewrites this figure's own style in the panel's list, so the thumbnail
   *  in the thread redraws in the same look. */
  onRestyle?: (style: DiagramStyleName) => void;
}) {
  const [said, say] = useSaid();
  const [exportSize, setExportSize] = useExportSize(diagram.prisma ? "prisma" : "diagram");
  const [preferred, setPreferred] = useDiagramStyle();
  /* A PRISMA figure's look is the official template, so it has no style. */
  const style: DiagramStyleName = diagram.prisma ? "standard" : diagram.style ?? preferred;
  /* Undefined for the standard look, which on screen follows the app's CSS. */
  const screenTheme = style === "standard" ? undefined : themeForStyle(style);

  const drawn = useMemo(
    () => drawDiagram(diagram, style),
    [diagram.source, diagram.prisma, style],
  );

  const restyle = (v: DiagramStyleName): void => {
    setPreferred(v);
    onRestyle?.(v);
  };

  /** "Standard" writes no physical size at all -- the file's pixel size IS
   *  its size, exactly as before this existed. A page size scales the
   *  diagram's own geometry (never redrawn, unlike a chart's) to fit inside
   *  the page's text block, via `fitWithin`, and upscales a small diagram to
   *  fill the page rather than leaving it stranded in a corner. */
  const exportPhysical = (layout: Layout): { widthIn: number; heightIn: number } | undefined => {
    const box = pageBoxForExport(exportSize);
    if (!box) return undefined;
    const scale = fitWithin(layout.width, layout.height, box);
    return { widthIn: (layout.width * scale) / PX_PER_IN, heightIn: (layout.height * scale) / PX_PER_IN };
  };

  /* Rasterised from the exported SVG rather than from what is on screen: the
     two must be the same picture, and the on-screen one carries the app's
     theme. */
  const toPng = async (): Promise<string | undefined> => {
    if (!("layout" in drawn)) return undefined;
    const { layout } = drawn;
    const physical = exportPhysical(layout);
    const svg = toSvg(layout, themeForStyle(style), physical);
    /* Two-times scale at the natural size, because a figure lands in a
       document at print resolution and a 1x PNG looks soft next to the
       text; 300dpi at a page size, since that size is meant to print. */
    const scale = physical ? PNG_SCALE_PAGE : PNG_SCALE_STANDARD;
    return svgToPng(svg, layout.width * scale, layout.height * scale);
  };

  const saveSvg = async (): Promise<void> => {
    if (!("layout" in drawn)) return;
    const physical = exportPhysical(drawn.layout);
    const res = await window.myra.diagramSave(diagram.title, "svg", toSvg(drawn.layout, themeForStyle(style), physical));
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
      <div className={screenTheme ? "dg-canvas paper" : "dg-canvas"}>
        <DiagramSvg
          layout={layout}
          theme={screenTheme}
          edgeLabels
          width={layout.width}
          height={layout.height}
          label={diagram.title}
          className="dg-svg"
        />
      </div>

      <div className="dg-acts">
        {diagram.prisma ? null : <DiagramStyleSelect value={style} onChange={restyle} />}
        <ExportSizeSelect
          value={exportSize}
          onChange={(v: ExportSize) => setExportSize(v)}
          standardLabel="Natural size"
        />
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
