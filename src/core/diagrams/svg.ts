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
import { FONT_SIZE, LINE_HEIGHT, type Layout, type PlacedEdge, type PlacedNode } from "./layout.ts";

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
};

const round = (n: number): number => Math.round(n * 100) / 100;

/** The outline of one node, as an SVG path. */
export function nodePath(n: PlacedNode): string {
  const { x, y, w, h } = n;
  /* The PRISMA template's boxes are square-cornered, and a figure with rounded
     corners beside one cut from the official Word template reads as a
     different diagram. Absent means 6, so every model-drawn box is untouched. */
  const r = n.box?.radius ?? 6;
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

/** The polyline of one edge, without its arrowhead. */
export function edgePath(e: PlacedEdge): string {
  return e.points.map((p, i) => `${i ? "L" : "M"} ${round(p.x)} ${round(p.y)}`).join(" ");
}

/** The arrowhead triangle at the end of an edge, or nothing for a plain link. */
export function arrowHead(e: PlacedEdge): string | undefined {
  if (!e.arrow || e.points.length < 2) return undefined;
  const tip = e.points[e.points.length - 1]!;
  const before = e.points[e.points.length - 2]!;
  const dx = tip.x - before.x;
  const dy = tip.y - before.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = 8;
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const half = 4;
  return `M ${round(tip.x)} ${round(tip.y)} ` +
         `L ${round(back.x - uy * half)} ${round(back.y + ux * half)} ` +
         `L ${round(back.x + uy * half)} ${round(back.y - ux * half)} Z`;
}

/** The dash pattern for an edge style, or nothing for a solid one. */
export function dashFor(style: PlacedEdge["style"]): string | undefined {
  return style === "dotted" ? "5 4" : undefined;
}

export function strokeFor(style: PlacedEdge["style"]): number {
  return style === "thick" ? 3 : 1.5;
}

/** The y offset of line `i` of a label centred in a box of `count` lines. */
export function lineY(node: PlacedNode, i: number, count: number): number {
  const block = count * LINE_HEIGHT;
  return node.y + node.h / 2 - block / 2 + LINE_HEIGHT * i + LINE_HEIGHT * 0.72;
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

/** A standalone SVG file, ready to drop into a manuscript. */
export function toSvg(layout: Layout, theme: DiagramTheme = PAPER_THEME): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" ` +
    `viewBox="0 0 ${layout.width} ${layout.height}" font-family="system-ui, -apple-system, ` +
    `'Segoe UI', sans-serif" font-size="${FONT_SIZE}">`,
  );
  parts.push(`<rect width="${layout.width}" height="${layout.height}" fill="${theme.background}"/>`);

  for (const e of layout.edges) {
    const dash = dashFor(e.style);
    parts.push(
      `<path d="${edgePath(e)}" fill="none" stroke="${theme.edge}" ` +
      `stroke-width="${strokeFor(e.style)}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
    );
    const head = arrowHead(e);
    if (head) parts.push(`<path d="${head}" fill="${theme.edge}"/>`);
    if (e.label && e.labelAt) {
      const w = e.label.length * FONT_SIZE * 0.55 + 8;
      parts.push(
        `<rect x="${round(e.labelAt.x - w / 2)}" y="${round(e.labelAt.y - 9)}" width="${round(w)}" ` +
        `height="18" fill="${theme.edgeLabelBg}" rx="3"/>`,
      );
      parts.push(
        `<text x="${round(e.labelAt.x)}" y="${round(e.labelAt.y + 4)}" text-anchor="middle" ` +
        `fill="${theme.edgeLabel}" font-size="${FONT_SIZE - 1}">${xmlEscape(e.label)}</text>`,
      );
    }
  }

  for (const n of layout.nodes) {
    const fill = n.box?.tint ? theme.tintFill : theme.nodeFill;
    parts.push(`<path d="${nodePath(n)}" fill="${fill}" stroke="${theme.nodeStroke}" stroke-width="1.5"/>`);
    const bars = subroutineBars(n);
    if (bars) parts.push(`<path d="${bars}" stroke="${theme.nodeStroke}" stroke-width="1.5" fill="none"/>`);
    const turn = textTurn(n);
    const { x, anchor } = textAnchorAt(n);
    if (turn) parts.push(`<g transform="${turn}">`);
    n.lines.forEach((line, i) => {
      parts.push(
        `<text x="${round(x)}" y="${round(lineY(n, i, n.lines.length))}" ` +
        `text-anchor="${anchor}" fill="${theme.text}">${xmlEscape(line)}</text>`,
      );
    });
    if (turn) parts.push("</g>");
  }

  parts.push("</svg>");
  return parts.join("\n");
}
