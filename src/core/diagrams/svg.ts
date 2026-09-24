/**
 * Turning a placed diagram into shapes, and into an SVG file.
 *
 * Two consumers, one set of numbers. The renderer maps `nodePath`/`edgePath`
 * onto React elements; `toSvg` writes the same strings into a standalone file
 * for export. Anything that differed between them would be a diagram that
 * exports differently from how it looked, which is the one thing a figure
 * bound for a paper must not do.
 *
 * Arrowheads are explicit triangles rather than `<marker>` definitions. A
 * marker is referenced by id, ids are document-global, and a thread can hold
 * several diagrams at once -- so two of them would share or clobber one
 * another's arrowhead. A drawn triangle has no id to collide.
 */

import type { NodeShape } from "./mermaid.ts";
import type { Layout, PlacedEdge, PlacedNode } from "./layout.ts";
import { contrastRatio, readableTextOn, toGrey } from "./colors.ts";
import { LOOKS, STYLE_THEMES, type DiagramStyleName, type Look } from "./styles.ts";

/** Every helper below takes an optional look; absent is the standard one, so
 *  a caller that never heard of looks draws exactly what it always drew. */
const STANDARD = LOOKS.standard;

/** Colours, kept here so the exported file does not depend on the app's theme. */
export interface DiagramTheme {
  background: string;
  nodeFill: string;
  /** A phase band or a column heading -- a PRISMA figure's only second fill. */
  tintFill: string;
  nodeStroke: string;
  text: string;
  edge: string;
  edgeLabel: string;
  edgeLabelBg: string;
  /** The drop-shadow under a rounded (non-template) box. A full CSS colour,
   *  alpha included, so it is one attribute rather than a colour plus an
   *  opacity that could drift apart. */
  shadowColor: string;
  /** Indexed by `BoxStyle.category`. Length `CATEGORY_PALETTE_SIZE` --
   *  MyRA's own palette, for a category the source grouped but gave no
   *  colour of its own; a `classDef` fill replaces it via `BoxStyle.fill`. */
  categoryFill: string[];
  /** A stroke per category, in the fill's hue. Absent: every box uses `nodeStroke`. */
  categoryStroke?: string[] | undefined;
  /** Map every colour the source asked for to the grey of the same lightness. */
  greyscale?: boolean | undefined;
}

/**
 * White, dark strokes, black text.
 *
 * The export default regardless of the app's theme: a figure goes into a
 * manuscript, and a diagram exported in dark mode arrives as white text on a
 * transparent background, invisible on the page it was written for.
 */
export const PAPER_THEME: DiagramTheme = {
  background: "#ffffff",
  nodeFill: "#f5f6f8",
  tintFill: "#e9ebef",
  nodeStroke: "#33373f",
  text: "#14161a",
  edge: "#4a4f58",
  edgeLabel: "#33373f",
  edgeLabelBg: "#ffffff",
  shadowColor: "rgba(20, 22, 26, 0.18)",
  /* A 20% mix of the app's own semantic hues into nodeFill, in the same
     blue/green/amber/red order those tokens already appear in styles.css,
     plus purple/teal for the two slots beyond them. Every one clears 12.5:1
     against `text` below -- picked for legibility, not merely checked after
     the fact. */
  categoryFill: ["#cddae7", "#d1ded4", "#e1d9c8", "#e7d3d2", "#d9d5e6", "#ccdede"],
};

/**
 * The export palette for a look: `PAPER_THEME` for the standard one, which on
 * screen follows the app's CSS instead, and each named look's own otherwise.
 */
export function themeForStyle(style: DiagramStyleName | undefined): DiagramTheme {
  return !style || style === "standard" ? PAPER_THEME : STYLE_THEMES[style];
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** A template box asking for square corners (PRISMA's `radius: 0`) opts out
 *  of the shadow along with the rounding -- a figure cut from an official
 *  Word template must not gain either -- and a look with no shadows (the
 *  journal's, since print turns one into a grey smear) opts every box out. */
export function hasShadow(n: PlacedNode, look: Look = STANDARD): boolean {
  return look.shadow && (n.box?.radius ?? look.radius) > 0;
}

/** The outline of one node, as an SVG path. */
export function nodePath(n: PlacedNode, look: Look = STANDARD): string {
  const { x, y, w, h } = n;
  /* The PRISMA template's boxes are square-cornered, and a figure with rounded
     corners beside one cut from the official Word template reads as a
     different diagram. Absent means the look's radius, which `layoutDiagram`
     never overrides, so every model-drawn box gets the same corner. */
  const r = n.box?.radius ?? look.radius;
  const shape: NodeShape = n.shape;
  switch (shape) {
    case "diamond":
      return `M ${round(x + w / 2)} ${round(y)} L ${round(x + w)} ${round(y + h / 2)} ` +
             `L ${round(x + w / 2)} ${round(y + h)} L ${round(x)} ${round(y + h / 2)} Z`;
    case "circle": {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rad = Math.min(w, h) / 2;
      return `M ${round(cx - rad)} ${round(cy)} a ${round(rad)} ${round(rad)} 0 1 0 ${round(rad * 2)} 0 ` +
             `a ${round(rad)} ${round(rad)} 0 1 0 ${round(-rad * 2)} 0 Z`;
    }
    case "stadium": {
      const rad = h / 2;
      return `M ${round(x + rad)} ${round(y)} L ${round(x + w - rad)} ${round(y)} ` +
             `a ${round(rad)} ${round(rad)} 0 0 1 0 ${round(h)} ` +
             `L ${round(x + rad)} ${round(y + h)} a ${round(rad)} ${round(rad)} 0 0 1 0 ${round(-h)} Z`;
    }
    case "hexagon": {
      const cut = Math.min(20, w / 4);
      return `M ${round(x + cut)} ${round(y)} L ${round(x + w - cut)} ${round(y)} ` +
             `L ${round(x + w)} ${round(y + h / 2)} L ${round(x + w - cut)} ${round(y + h)} ` +
             `L ${round(x + cut)} ${round(y + h)} L ${round(x)} ${round(y + h / 2)} Z`;
    }
    case "cylinder": {
      const ry = Math.min(10, h / 5);
      return `M ${round(x)} ${round(y + ry)} a ${round(w / 2)} ${round(ry)} 0 0 1 ${round(w)} 0 ` +
             `L ${round(x + w)} ${round(y + h - ry)} a ${round(w / 2)} ${round(ry)} 0 0 1 ${round(-w)} 0 Z`;
    }
    case "flag":
      return `M ${round(x)} ${round(y)} L ${round(x + w - 12)} ${round(y)} ` +
             `L ${round(x + w)} ${round(y + h / 2)} L ${round(x + w - 12)} ${round(y + h)} ` +
             `L ${round(x)} ${round(y + h)} Z`;
    case "round":
    case "subroutine":
    case "rect":
    default:
      // A published PRISMA figure asks for r=0, and a "rounded" corner whose
      // radius is zero should be a straight one -- not a curve command whose
      // two control points happen to coincide.
      if (r <= 0) {
        return `M ${round(x)} ${round(y)} L ${round(x + w)} ${round(y)} ` +
               `L ${round(x + w)} ${round(y + h)} L ${round(x)} ${round(y + h)} Z`;
      }
      return `M ${round(x + r)} ${round(y)} L ${round(x + w - r)} ${round(y)} ` +
             `Q ${round(x + w)} ${round(y)} ${round(x + w)} ${round(y + r)} ` +
             `L ${round(x + w)} ${round(y + h - r)} Q ${round(x + w)} ${round(y + h)} ${round(x + w - r)} ${round(y + h)} ` +
             `L ${round(x + r)} ${round(y + h)} Q ${round(x)} ${round(y + h)} ${round(x)} ${round(y + h - r)} ` +
             `L ${round(x)} ${round(y + r)} Q ${round(x)} ${round(y)} ${round(x + r)} ${round(y)} Z`;
  }
}

/** The inner line a subroutine box carries on each side. */
export function subroutineBars(n: PlacedNode): string | undefined {
  if (n.shape !== "subroutine") return undefined;
  const inset = 8;
  return `M ${round(n.x + inset)} ${round(n.y)} L ${round(n.x + inset)} ${round(n.y + n.h)} ` +
         `M ${round(n.x + n.w - inset)} ${round(n.y)} L ${round(n.x + n.w - inset)} ${round(n.y + n.h)}`;
}

/**
 * The polyline of one edge, without its arrowhead.
 *
 * A look with an elbow radius rounds each interior corner with a quadratic
 * curve, clamped to half the shorter of its two segments so a short jog is
 * softened rather than overshot. The standard look's radius is 0, and its
 * path is the plain M/L polyline it always was.
 */
export function edgePath(e: PlacedEdge, look: Look = STANDARD): string {
  const pts = e.points;
  const r = look.elbowRadius;
  if (r <= 0 || pts.length < 3) {
    return pts.map((p, i) => `${i ? "L" : "M"} ${round(p.x)} ${round(p.y)}`).join(" ");
  }
  const parts = [`M ${round(pts[0]!.x)} ${round(pts[0]!.y)}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const at = pts[i]!;
    const next = pts[i + 1]!;
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y);
    const outLen = Math.hypot(next.x - at.x, next.y - at.y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    if (k <= 0) {
      parts.push(`L ${round(at.x)} ${round(at.y)}`);
      continue;
    }
    const before = { x: at.x - ((at.x - prev.x) / inLen) * k, y: at.y - ((at.y - prev.y) / inLen) * k };
    const after = { x: at.x + ((next.x - at.x) / outLen) * k, y: at.y + ((next.y - at.y) / outLen) * k };
    parts.push(`L ${round(before.x)} ${round(before.y)}`);
    parts.push(`Q ${round(at.x)} ${round(at.y)} ${round(after.x)} ${round(after.y)}`);
  }
  const last = pts[pts.length - 1]!;
  parts.push(`L ${round(last.x)} ${round(last.y)}`);
  return parts.join(" ");
}

/** The arrowhead triangle at the end of an edge, or nothing for a plain link. */
export function arrowHead(e: PlacedEdge, look: Look = STANDARD): string | undefined {
  if (!e.arrow || e.points.length < 2) return undefined;
  const tip = e.points[e.points.length - 1]!;
  const before = e.points[e.points.length - 2]!;
  const dx = tip.x - before.x;
  const dy = tip.y - before.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = look.arrowSize;
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const half = size / 2;
  return `M ${round(tip.x)} ${round(tip.y)} ` +
         `L ${round(back.x - uy * half)} ${round(back.y + ux * half)} ` +
         `L ${round(back.x + uy * half)} ${round(back.y - ux * half)} Z`;
}

/** The dash pattern for an edge style, or nothing for a solid one. */
export function dashFor(style: PlacedEdge["style"]): string | undefined {
  return style === "dotted" ? "5 4" : undefined;
}

export function strokeFor(style: PlacedEdge["style"], width?: number, look: Look = STANDARD): number {
  return width ?? (style === "thick" ? look.edgeWidth * 2 : look.edgeWidth);
}

/**
 * Where an edge's label and the backdrop behind it go, for a look.
 *
 * Shared by the exporter and the renderer so the two cannot disagree about a
 * label's box; the standard look's numbers are the ones this file always
 * wrote -- an 18px backdrop, text 4px below centre, one point smaller.
 */
export function edgeLabelBox(
  e: PlacedEdge,
  look: Look = STANDARD,
): { x: number; y: number; w: number; h: number; textY: number; fontSize: number } | undefined {
  if (!e.label || !e.labelAt) return undefined;
  const w = e.label.length * look.fontSize * 0.55 + 8;
  const h = look.fontSize + 5;
  return {
    x: e.labelAt.x - w / 2,
    y: e.labelAt.y - h / 2,
    w,
    h,
    textY: e.labelAt.y + Math.round((look.fontSize - 1) / 3),
    fontSize: look.fontSize - 1,
  };
}

/** The colours and stroke one box is drawn with, under a theme. */
export interface NodeColors {
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
}

/**
 * One box's colours, resolved once for the exporter and for the renderer's
 * named looks alike: the source's own colour first, then its category, then a
 * tint, then the default -- and, under a greyscale theme, every chosen colour
 * turned into the grey of the same lightness, with text re-picked if the grey
 * would leave it unreadable.
 */
export function nodeColors(n: PlacedNode, theme: DiagramTheme, look: Look = STANDARD): NodeColors {
  const b = n.box;
  const category = b?.category;
  let fill =
    b?.fill ??
    (category !== undefined
      ? theme.categoryFill[category] ?? theme.nodeFill
      : b?.tint ? theme.tintFill : theme.nodeFill);
  let stroke = b?.stroke ?? (category !== undefined ? theme.categoryStroke?.[category] : undefined) ?? theme.nodeStroke;
  let text = b?.text ?? theme.text;
  if (theme.greyscale) {
    fill = toGrey(fill);
    stroke = toGrey(stroke);
    text = toGrey(text);
    if (contrastRatio(text, fill) < 4.5) text = readableTextOn(fill);
  }
  return { fill, stroke, strokeWidth: b?.strokeWidth ?? look.nodeStrokeWidth, text };
}

/** One edge's line, arrowhead and label colours, and its width. */
export function edgeColors(
  e: PlacedEdge,
  theme: DiagramTheme,
  look: Look = STANDARD,
): { stroke: string; width: number; label: string } {
  const stroke = e.paint?.stroke ?? theme.edge;
  const label = e.paint?.text ?? theme.edgeLabel;
  return {
    stroke: theme.greyscale ? toGrey(stroke) : stroke,
    width: strokeFor(e.style, e.paint?.strokeWidth, look),
    label: theme.greyscale ? toGrey(label) : label,
  };
}

/**
 * The colours a box's own source asked for, as an inline style for the
 * renderer -- which otherwise colours from CSS classes so a figure follows the
 * app's theme. An inline style beats a class, which is exactly the precedence
 * wanted: the theme is the default, and a colour the user asked for is not.
 * Nothing for a box that named none, so its element is what it always was.
 */
export function boxPaintStyle(n: PlacedNode): { fill?: string; stroke?: string; strokeWidth?: number } | undefined {
  const b = n.box;
  if (!b || (b.fill === undefined && b.stroke === undefined && b.strokeWidth === undefined)) return undefined;
  return {
    ...(b.fill ? { fill: b.fill } : {}),
    ...(b.stroke ? { stroke: b.stroke } : {}),
    ...(b.strokeWidth !== undefined ? { strokeWidth: b.strokeWidth } : {}),
  };
}

/** The y offset of line `i` of a label centred in a box of `count` lines. */
export function lineY(node: PlacedNode, i: number, count: number, look: Look = STANDARD): number {
  const lh = look.lineHeight;
  const block = count * lh;
  return node.y + node.h / 2 - block / 2 + lh * i + lh * 0.72;
}

/** Where a node's lines start, and the anchor that goes with it. */
export function textAnchorAt(n: PlacedNode): { x: number; anchor: "middle" | "start" } {
  const inset = n.box?.inset;
  /* A PRISMA box holds a list -- three exclusion reasons, four databases -- and
     a centred list has no left edge to read down. Absent means centred, which
     is every shape `layoutDiagram` ever places. */
  return inset === undefined
    ? { x: n.x + n.w / 2, anchor: "middle" }
    : { x: n.x + inset, anchor: "start" };
}

/** The quarter turn a phase band's text takes, or nothing for ordinary text. */
export function textTurn(n: PlacedNode): string | undefined {
  const turn = n.box?.turn;
  if (turn === undefined) return undefined;
  /* The text turns, not the box: the band is already the tall narrow shape it
     should be, and turning the path would lay it flat across the figure. */
  return `rotate(${turn} ${round(n.x + n.w / 2)} ${round(n.y + n.h / 2)})`;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
};

/**
 * XML-escape, applied to every label without exception.
 *
 * A diagram's text is model output, and a model quotes the open web. This is
 * the same promise `Markdown.tsx` makes in React and it has to be kept again
 * here, because an exported file is built by string concatenation where React
 * would have escaped for free.
 */
export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** A standalone SVG file, ready to drop into a manuscript.
 *
 * `physical`, when given, writes the outer `width`/`height` in inches while
 * the `viewBox` stays in layout pixels, so a page-sized export inserts at
 * that physical size with no transform of its own. Omitted, the output is
 * exactly what it always was -- which is what pins this function's output in
 * `test/diagramSvg.test.ts`. */
export function toSvg(
  layout: Layout,
  theme: DiagramTheme = PAPER_THEME,
  physical?: { widthIn: number; heightIn: number },
): string {
  const look = layout.look ?? STANDARD;
  const parts: string[] = [];
  const outerW = physical ? `${physical.widthIn}in` : `${layout.width}`;
  const outerH = physical ? `${physical.heightIn}in` : `${layout.height}`;
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerW}" height="${outerH}" ` +
    `viewBox="0 0 ${layout.width} ${layout.height}" font-family="${look.fontFamily}" ` +
    `font-size="${look.fontSize}"${look.fontWeight !== 400 ? ` font-weight="${look.fontWeight}"` : ""}>`,
  );
  parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="${theme.background}"/>`);
  /* A literal id is safe here and only here: this string is one standalone
     file per export, never two documents sharing a DOM the way several
     diagrams can inside one conversation (see the arrowhead comment above on
     why an id-referencing marker is avoided on screen). */
  if (look.shadow) {
    parts.push(
      `<defs><filter id="dg-shadow" x="-30%" y="-30%" width="160%" height="160%">` +
      `<feDropShadow dx="0" dy="${look.shadowDy}" stdDeviation="${look.shadowBlur}" flood-color="${theme.shadowColor}"/>` +
      "</filter></defs>",
    );
  }

  /* Every colour below that did not come from `theme` came through
     colors.ts's `parseColor`, which only ever returns `#rrggbb` -- so nothing
     a model wrote reaches an attribute here as anything but six hex digits. */
  for (const e of layout.edges) {
    const dash = dashFor(e.style);
    const colors = edgeColors(e, theme, look);
    parts.push(
      `<path d="${edgePath(e, look)}" fill="none" stroke="${colors.stroke}" ` +
      `stroke-width="${colors.width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
    );
    const head = arrowHead(e, look);
    if (head) parts.push(`<path d="${head}" fill="${colors.stroke}"/>`);
    const label = edgeLabelBox(e, look);
    if (label && e.label && e.labelAt) {
      parts.push(
        `<rect x="${round(label.x)}" y="${round(label.y)}" width="${round(label.w)}" ` +
        `height="${label.h}" fill="${theme.edgeLabelBg}" rx="3"/>`,
      );
      parts.push(
        `<text x="${round(e.labelAt.x)}" y="${round(label.textY)}" text-anchor="middle" ` +
        `fill="${colors.label}" font-size="${label.fontSize}">${xmlEscape(e.label)}</text>`,
      );
    }
  }

  for (const n of layout.nodes) {
    const { fill, stroke, strokeWidth, text } = nodeColors(n, theme, look);
    const filter = hasShadow(n, look) ? ` filter="url(#dg-shadow)"` : "";
    parts.push(
      `<path d="${nodePath(n, look)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${filter}/>`,
    );
    const bars = subroutineBars(n);
    if (bars) parts.push(`<path d="${bars}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none"/>`);
    const turn = textTurn(n);
    const { x, anchor } = textAnchorAt(n);
    if (turn) parts.push(`<g transform="${turn}">`);
    n.lines.forEach((line, i) => {
      parts.push(
        `<text x="${round(x)}" y="${round(lineY(n, i, n.lines.length, look))}" ` +
        `text-anchor="${anchor}" fill="${text}">${xmlEscape(line)}</text>`,
      );
    });
    if (turn) parts.push("</g>");
  }

  parts.push("</svg>");
  return parts.join("\n");
}
