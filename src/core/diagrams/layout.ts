/**
 * Placing a parsed flowchart, with no DOM to measure against.
 *
 * Pure geometry, for the reason `projects/render.ts` returns `ExportOp`s rather
 * than writing files: the renderer draws this as React elements and the
 * exporter serialises the same numbers to an SVG string, so both are the same
 * diagram by construction rather than by two pieces of code agreeing.
 *
 * Layered, which is what a flowchart is. Ranks come from the longest path to a
 * node, so every edge points down the page; the order inside a rank is settled
 * by one barycentre pass, which is enough for the shapes people actually draw
 * -- a screening funnel with two or three branches off it -- and far short of
 * what a general graph drawer would do.
 *
 * **Text is estimated, not measured.** Nothing here can call `measureText`: it
 * runs in the test suite with no DOM and in the main process with no window. So
 * a character is assumed to be 0.58 of the font size, which is close for the
 * UI stack and wrong for CJK. Boxes are therefore padded rather than fitted,
 * and the label is centred inside whatever the estimate produced -- a box
 * slightly too wide reads as deliberate, where text overflowing its border does
 * not.
 */

import type { Diagram, DiagramEdge, DiagramNode, Direction, NodeShape } from "./mermaid.ts";

export const FONT_SIZE = 13;
export const LINE_HEIGHT = 17;
/** Fraction of the font size one character is assumed to occupy. */
export const CHAR_W = 0.58;
const PAD_X = 16;
const PAD_Y = 12;
const MIN_W = 96;
const MIN_H = 40;
/** Characters before a label wraps. Chosen so a box stays taller than it is wide-ish. */
const WRAP_AT = 26;
const RANK_GAP = 56;
const SIBLING_GAP = 28;
const MARGIN = 20;

/**
 * How a box is drawn, when the default is wrong for it.
 *
 * Only a hand-built figure sets this -- `layoutDiagram` never does, so a
 * model-drawn diagram is the same bytes it was before this existed. Nothing in
 * svg.ts or DiagramView.tsx learns the word "PRISMA"; this is presentational
 * and diagram-agnostic, the same shape `subroutineBars` already has.
 */
export interface BoxStyle {
  /** Corner radius. 0 is a published PRISMA figure's square corner. */
  radius?: number | undefined;
  /** Left-align the lines this far in, instead of centring them on the box. */
  inset?: number | undefined;
  /** Fill from `theme.tintFill`: a phase band or a column heading. */
  tint?: boolean | undefined;
  /** Degrees to turn the text about the box's own centre. -90 for a band. */
  turn?: number | undefined;
}

export interface PlacedNode {
  id: string;
  lines: string[];
  shape: NodeShape;
  x: number;
  y: number;
  w: number;
  h: number;
  box?: BoxStyle | undefined;
}

export interface PlacedEdge {
  from: string;
  to: string;
  label?: string | undefined;
  style: DiagramEdge["style"];
  arrow: boolean;
  /** Orthogonal polyline, already in final coordinates. */
  points: { x: number; y: number }[];
  /** Where the label sits, when there is one. */
  labelAt?: { x: number; y: number } | undefined;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/** Break a label on spaces so no line runs past `WRAP_AT`. */
export function wrapLabel(text: string, at: number = WRAP_AT): string[] {
  /* A literal `<br/>` is Mermaid's own line break and authors use it to control
     the shape of a box, so it wins over the automatic wrap. */
  const forced = text.split(/<br\s*\/?>/i).map((s) => s.trim());
  const out: string[] = [];
  for (const chunk of forced) {
    if (!chunk) continue;
    let line = "";
    for (const word of chunk.split(/\s+/)) {
      if (!line) { line = word; continue; }
      if (line.length + 1 + word.length <= at) { line += ` ${word}`; continue; }
      out.push(line);
      line = word;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [text];
}

function sizeOf(lines: string[], shape: NodeShape): { w: number; h: number } {
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  let w = Math.max(MIN_W, Math.round(longest * FONT_SIZE * CHAR_W) + PAD_X * 2);
  let h = Math.max(MIN_H, lines.length * LINE_HEIGHT + PAD_Y * 2);
  /* A diamond's text sits in the middle half of its bounding box, so a box
     fitted to the text would push the label out through the slanted sides. */
  if (shape === "diamond") { w = Math.round(w * 1.45); h = Math.round(h * 1.5); }
  if (shape === "circle") { const d = Math.max(w, h); w = d; h = d; }
  if (shape === "hexagon") w = Math.round(w * 1.2);
  return { w, h };
}

/**
 * Rank every node by its longest path from a root.
 *
 * Longest rather than shortest so an edge never points sideways within a rank:
 * a node reachable both directly and through three steps belongs below all
 * three. Cycles are broken by refusing to revisit a node already on the current
 * path, which leaves the back edge drawn as an ordinary one rather than
 * hanging the layout.
 */
export function rankNodes(diagram: Diagram): Map<string, number> {
  const out = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of diagram.nodes) { outgoing.set(n.id, []); indegree.set(n.id, 0); }
  for (const e of diagram.edges) {
    if (!outgoing.has(e.from) || !outgoing.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const roots = diagram.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  /* Every node in a cycle has an incoming edge, so a diagram that is nothing
     but a cycle has no root at all. The first node declared stands in, which
     draws something rather than nothing. */
  const starts = roots.length ? roots : diagram.nodes[0] ? [diagram.nodes[0].id] : [];

  const walk = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id)) return;
    if ((out.get(id) ?? -1) >= depth) return;
    out.set(id, depth);
    path.add(id);
    for (const next of outgoing.get(id) ?? []) walk(next, depth + 1, path);
    path.delete(id);
  };
  for (const id of starts) walk(id, 0, new Set());
  // Anything unreachable still has to be drawn; it goes on the top rank.
  for (const n of diagram.nodes) if (!out.has(n.id)) out.set(n.id, 0);
  return out;
}

/** Place a parsed diagram. Coordinates are final, origin top-left. */
export function layoutDiagram(diagram: Diagram): Layout {
  const ranks = rankNodes(diagram);
  const horizontal = diagram.direction === "LR" || diagram.direction === "RL";

  const byRank = new Map<number, DiagramNode[]>();
  for (const n of diagram.nodes) {
    const r = ranks.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }

  const sized = new Map<string, { lines: string[]; w: number; h: number }>();
  for (const n of diagram.nodes) {
    const lines = wrapLabel(n.label);
    sized.set(n.id, { lines, ...sizeOf(lines, n.shape) });
  }

  /* One barycentre pass: a node sits over the average position of the things
     pointing at it. Enough to stop the obvious crossing where two branches of a
     decision are declared in the opposite order to their parents. */
  const incoming = new Map<string, string[]>();
  for (const e of diagram.edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push(e.from);
  }
  const orderIn = new Map<string, number>();
  const rankKeys = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of rankKeys) {
    const row = byRank.get(r)!;
    const declared = new Map(row.map((n, i) => [n.id, i]));
    row.sort((a, b) => {
      const key = (n: DiagramNode): number => {
        const parents = (incoming.get(n.id) ?? []).map((p) => orderIn.get(p)).filter((v): v is number => v !== undefined);
        return parents.length ? parents.reduce((s, v) => s + v, 0) / parents.length : declared.get(n.id)!;
      };
      return key(a) - key(b) || declared.get(a.id)! - declared.get(b.id)!;
    });
    row.forEach((n, i) => orderIn.set(n.id, i));
  }

  /* Rank extents along the flow axis, then each row centred across the widest. */
  const rankSize = new Map<number, number>();
  const rankSpan = new Map<number, number>();
  for (const r of rankKeys) {
    const row = byRank.get(r)!;
    let span = 0;
    let thick = 0;
    for (const n of row) {
      const s = sized.get(n.id)!;
      span += (horizontal ? s.h : s.w) + SIBLING_GAP;
      thick = Math.max(thick, horizontal ? s.w : s.h);
    }
    rankSpan.set(r, Math.max(0, span - SIBLING_GAP));
    rankSize.set(r, thick);
  }
  const widest = Math.max(0, ...rankSpan.values());

  const placed = new Map<string, PlacedNode>();
  let along = MARGIN;
  const reverse = diagram.direction === "BT" || diagram.direction === "RL";
  const orderedRanks = reverse ? [...rankKeys].reverse() : rankKeys;
  for (const r of orderedRanks) {
    const row = byRank.get(r)!;
    let across = MARGIN + (widest - (rankSpan.get(r) ?? 0)) / 2;
    for (const n of row) {
      const s = sized.get(n.id)!;
      const node: PlacedNode = horizontal
        ? { id: n.id, lines: s.lines, shape: n.shape, x: along, y: across, w: s.w, h: s.h }
        : { id: n.id, lines: s.lines, shape: n.shape, x: across, y: along, w: s.w, h: s.h };
      placed.set(n.id, node);
      across += (horizontal ? s.h : s.w) + SIBLING_GAP;
    }
    along += (rankSize.get(r) ?? 0) + RANK_GAP;
  }

  const edges: PlacedEdge[] = [];
  for (const e of diagram.edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) continue;
    const points = route(a, b, horizontal);
    const mid = points[Math.floor(points.length / 2)] ?? points[0]!;
    edges.push({
      from: e.from, to: e.to, style: e.style, arrow: e.arrow, points,
      ...(e.label ? { label: e.label, labelAt: { x: mid.x, y: mid.y } } : {}),
    });
  }

  let width = MARGIN;
  let height = MARGIN;
  for (const n of placed.values()) {
    width = Math.max(width, n.x + n.w + MARGIN);
    height = Math.max(height, n.y + n.h + MARGIN);
  }
  return { width, height, nodes: [...placed.values()], edges };
}

/**
 * An orthogonal path from one box to the next.
 *
 * Elbows rather than straight diagonals because that is what a flowchart looks
 * like, and because a diagonal between two ranks crosses whatever sits between
 * them. Three segments: out of the source, across at the midpoint, into the
 * target.
 */
function route(a: PlacedNode, b: PlacedNode, horizontal: boolean): { x: number; y: number }[] {
  if (horizontal) {
    const forward = b.x >= a.x;
    const x1 = forward ? a.x + a.w : a.x;
    const x2 = forward ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    if (Math.abs(y1 - y2) < 1) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    const mx = (x1 + x2) / 2;
    return [{ x: x1, y: y1 }, { x: mx, y: y1 }, { x: mx, y: y2 }, { x: x2, y: y2 }];
  }
  const forward = b.y >= a.y;
  const y1 = forward ? a.y + a.h : a.y;
  const y2 = forward ? b.y : b.y + b.h;
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  if (Math.abs(x1 - x2) < 1) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  const my = (y1 + y2) / 2;
  return [{ x: x1, y: y1 }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: y2 }];
}
