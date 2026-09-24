/**
 * Placing a PRISMA 2020 figure, directly into `Layout` coordinates.
 *
 * `layoutDiagram` cannot draw this: a published PRISMA figure needs pinned
 * columns, a side box hung at its parent's own vertical level, phase bands down
 * the left edge, and left-aligned lists inside a box, none of which the general
 * layered placer has any way to express. So this builds a `Layout` by hand --
 * but it is still a `Layout`, which is what lets `toSvg`, `DiagramView.tsx`,
 * Save SVG/PNG and Copy figure all work on a PRISMA figure with no changes of
 * their own. One geometry, two consumers, same rule this app already keeps for
 * a model-drawn diagram.
 *
 * Every box the same width, because a published PRISMA has equal-width boxes;
 * fitting each to its text would give a ragged right edge no journal figure
 * has. Text is estimated, not measured, the same 0.58em-per-character rule
 * `diagrams/layout.ts` uses -- nothing here has a DOM either.
 */

import { CHAR_W, FONT_SIZE, LINE_HEIGHT, wrapLabel, type Layout, type PlacedEdge, type PlacedNode } from "../diagrams/layout.ts";
import {
  boxesFor, fieldsIn, formatCount, PHASE_LABEL, ROW_ORDER, ROW_PHASE,
  type PrismaBox, type PrismaBoxId, type PrismaFigure, type PrismaPhaseId, type PrismaRowId,
} from "./spec.ts";

const MARGIN = 20; // matches diagrams/layout.ts, so the two kinds of figure sit the same on a page
const BAND_W = 28;
const BAND_GAP = 12; // band to the first column
/* A published PRISMA has equal-width boxes; fitting each to its own text would
   give a ragged right edge no journal figure has. */
const BOX_W = 268;
const SIDE_GAP = 46; // a column to its own exclusion column
const BLOCK_GAP = 58; // one column block to the next
const PAD_X = 12;
const PAD_Y = 10;
const MIN_H = 44;
const ROW_GAP = 36; // room for an arrow and its head
/** Characters per line at BOX_W. The same 0.58em-per-character estimate. */
const WRAP = Math.floor((BOX_W - PAD_X * 2) / (FONT_SIZE * CHAR_W));
/** A title rarely needs to wrap: the widest of the four is 60 characters, and
    it spans a column plus its side column, comfortably wider than BOX_W. */
const TITLE_WRAP = 70;

const COLUMN_ORDER = ["band", "previous", "main", "mainSide", "other", "otherSide"] as const;
const GAP_BEFORE: Record<Exclude<(typeof COLUMN_ORDER)[number], "band">, number> = {
  previous: BLOCK_GAP,
  main: BLOCK_GAP,
  mainSide: SIDE_GAP,
  other: BLOCK_GAP,
  otherSide: SIDE_GAP,
};

const count = (v: number): string => formatCount(v);
const heightOf = (lines: number): number => Math.max(MIN_H, lines * LINE_HEIGHT + PAD_Y * 2);

interface Built {
  box: PrismaBox;
  lines: string[];
  w: number;
  h: number;
}

/**
 * The lines of one box, in the template's own wording. Empty means the box is
 * not drawn -- a caption alone, over nothing, is worse than no box at all.
 */
function rowsOf(box: PrismaBox, fig: PrismaFigure): string[] {
  const captioned = box.caption !== undefined;
  const out: string[] = [];
  for (const f of fieldsIn(box.id, fig.variant)) {
    if (f.kind === "list") {
      for (const item of fig.items[f.id as keyof typeof fig.items] ?? []) {
        if (!item.label.trim()) continue; // an empty "add another" slot is not a reason
        out.push(item.n === undefined ? item.label : `${item.label} (n = ${count(item.n)})`);
      }
      continue;
    }
    /* Naming the databases replaces their total: the template's own footnote
       asks for the per-database numbers, and a run that queried named
       databases can offer them instead of a sum. */
    if (f.id === "databases" && (fig.items.databasesNamed ?? []).some((i) => i.label.trim())) continue;
    const v = fig.counts[f.id as keyof typeof fig.counts];
    if (v === undefined) continue; // never a box reading a count it was not given
    if (captioned) out.push(`${f.caption} (n = ${count(v)})`);
    else out.push(f.caption, `(n = ${count(v)})`);
  }
  if (!out.length) return []; // a caption alone, over nothing, is worse than no box at all
  // The box's own heading is a line of the box, not decoration around it --
  // "Records removed before screening:" reads above the list it introduces.
  return captioned ? [box.caption!, ...out] : out;
}

function buildBoxes(fig: PrismaFigure): Built[] {
  const out: Built[] = [];
  for (const box of boxesFor(fig.variant)) {
    if (box.kind === "band") continue; // synthesised after row placement, from the phases present
    if (box.kind === "title") {
      const lines = wrapLabel(box.caption ?? "", TITLE_WRAP);
      out.push({ box, lines, w: BOX_W, h: heightOf(lines.length) });
      continue;
    }
    const raw = rowsOf(box, fig);
    if (!raw.length) continue;
    const lines = raw.flatMap((l) => wrapLabel(l, WRAP));
    out.push({ box, lines, w: BOX_W, h: heightOf(lines.length) });
  }
  /* A heading over nothing is not drawn: a title is real only when its own
     column carries at least one content box. */
  const contentColumns = new Set(out.filter((b) => b.box.kind !== "title").map((b) => b.box.column));
  return out.filter((b) => b.box.kind !== "title" || contentColumns.has(b.box.column));
}

function columnPositions(built: readonly Built[]): Map<string, { x: number; w: number }> {
  const present = new Set(built.map((b) => b.box.column));
  const pos = new Map<string, { x: number; w: number }>();
  let x = MARGIN;
  let sawBand = false;
  let first = true;
  for (const col of COLUMN_ORDER) {
    if (col !== "band" && !present.has(col)) continue;
    const w = col === "band" ? BAND_W : BOX_W;
    // Band is always first when present, so this branch order never actually
    // reaches GAP_BEFORE for "band" -- but the check keeps that a fact the
    // types can see, not one only true by the shape of COLUMN_ORDER.
    const gap = first ? 0 : col === "band" ? BAND_GAP : sawBand ? BAND_GAP : GAP_BEFORE[col];
    x += gap;
    pos.set(col, { x, w });
    x += w;
    sawBand = col === "band";
    first = false;
  }
  return pos;
}

function rowHeights(built: readonly Built[]): Map<PrismaRowId, number> {
  const h = new Map<PrismaRowId, number>();
  for (const b of built) {
    if (!b.box.row) continue;
    h.set(b.box.row, Math.max(h.get(b.box.row) ?? 0, b.h));
  }
  return h;
}

/** The rows of one phase that are actually present, top to bottom. */
function rowsInPhase(phase: PrismaPhaseId, rowH: Map<PrismaRowId, number>): PrismaRowId[] {
  return ROW_ORDER.filter((r) => ROW_PHASE[r] === phase && rowH.has(r));
}

/**
 * Grow a phase's first row when its own band-label would otherwise run out
 * through the band's own ends -- "Identification" turned on its side is
 * ~106px long, and a one-row phase can come out shorter than that.
 */
function growForBands(rowH: Map<PrismaRowId, number>): void {
  for (const phase of ["identification", "screening", "included"] as const) {
    const rows = rowsInPhase(phase, rowH);
    if (!rows.length) continue;
    const span = rows.reduce((s, r) => s + rowH.get(r)!, 0) + ROW_GAP * (rows.length - 1);
    const needed = Math.round(PHASE_LABEL[phase].length * FONT_SIZE * CHAR_W) + PAD_Y * 2;
    if (span < needed) rowH.set(rows[0]!, rowH.get(rows[0]!)! + (needed - span));
  }
}

function rowPositions(rowH: Map<PrismaRowId, number>): Map<PrismaRowId, number> {
  const y = new Map<PrismaRowId, number>();
  let cursor = MARGIN;
  for (const r of ROW_ORDER) {
    if (!rowH.has(r)) continue;
    y.set(r, cursor);
    cursor += rowH.get(r)! + ROW_GAP;
  }
  return y;
}

function bandSpan(
  phase: PrismaPhaseId,
  rowY: Map<PrismaRowId, number>,
  rowH: Map<PrismaRowId, number>,
): { y: number; h: number } | undefined {
  const rows = ROW_ORDER.filter((r) => ROW_PHASE[r] === phase && rowY.has(r));
  if (!rows.length) return undefined;
  const top = rowY.get(rows[0]!)!;
  const last = rows[rows.length - 1]!;
  return { y: top, h: rowY.get(last)! + rowH.get(last)! - top };
}

/** A straight vertical link from the bottom of one box to the top of the next. */
function verticalEdge(a: PlacedNode, b: PlacedNode): PlacedEdge {
  const cx = a.x + a.w / 2;
  return { from: a.id, to: b.id, style: "solid", arrow: true, points: [{ x: cx, y: a.y + a.h }, { x: cx, y: b.y }] };
}

/** A parent to its side box, horizontal because both share a row's centre line. */
function sideStub(parent: PlacedNode, side: PlacedNode): PlacedEdge {
  const cy = parent.y + parent.h / 2;
  return {
    from: parent.id, to: side.id, style: "solid", arrow: true,
    points: [{ x: parent.x + parent.w, y: cy }, { x: side.x, y: cy }],
  };
}

/** Place a filled-in PRISMA 2020 figure. Coordinates are final, origin top-left. */
export function prismaLayout(figure: PrismaFigure): Layout {
  const built = buildBoxes(figure);
  if (!built.length) return { width: MARGIN * 2, height: MARGIN * 2, nodes: [], edges: [] };

  const columns = columnPositions(built);
  const rowH = rowHeights(built);
  growForBands(rowH);
  const rowY = rowPositions(rowH);

  const nodes: PlacedNode[] = [];
  const byId = new Map<PrismaBoxId | string, PlacedNode>();

  for (const b of built) {
    const col = columns.get(b.box.column)!;
    const row = b.box.row!;
    const top = rowY.get(row)!;
    const h = b.h;
    const y = top + (rowH.get(row)! - h) / 2;
    /* A title spans its own column through the right edge of its side column,
       when that column exists -- the template's heading bar covers both. */
    const sideId = b.box.column === "main" ? "mainSide" : b.box.column === "other" ? "otherSide" : undefined;
    const side = sideId ? columns.get(sideId) : undefined;
    const w = b.box.kind === "title" && side ? side.x + side.w - col.x : b.w;
    const captioned = b.box.caption !== undefined;
    const node: PlacedNode = {
      id: b.box.id, lines: b.lines, shape: "rect", x: col.x, y, w, h,
      box: {
        radius: 0,
        tint: b.box.kind === "title",
        ...(captioned ? { inset: PAD_X } : {}),
      },
    };
    nodes.push(node);
    byId.set(b.box.id, node);
  }

  for (const phase of ["identification", "screening", "included"] as const) {
    const span = bandSpan(phase, rowY, rowH);
    if (!span) continue;
    const col = columns.get("band")!;
    nodes.push({
      id: `band${phase[0]!.toUpperCase()}${phase.slice(1)}`,
      lines: [PHASE_LABEL[phase]], shape: "rect",
      x: col.x, y: span.y, w: col.w, h: span.h,
      box: { radius: 0, tint: true, turn: -90 },
    });
  }

  const edges: PlacedEdge[] = [];

  /* The main chain and the other-methods chain, each linked over its own
     drawn boxes in template order -- so an absent box (no full-text step
     without an embedder, no screening step in the other-methods column) is
     skipped rather than leaving a stranded node or a dangling arrow. */
  for (const columnId of ["main", "other"] as const) {
    const chain = built
      .filter((b) => b.box.column === columnId && (b.box.kind === "box"))
      .sort((a, b) => ROW_ORDER.indexOf(a.box.row!) - ROW_ORDER.indexOf(b.box.row!));
    for (let i = 1; i < chain.length; i++) {
      edges.push(verticalEdge(byId.get(chain[i - 1]!.box.id)!, byId.get(chain[i]!.box.id)!));
    }
  }

  for (const b of built) {
    if (!b.box.parent) continue;
    const parent = byId.get(b.box.parent);
    const side = byId.get(b.box.id);
    if (parent && side) edges.push(sideStub(parent, side));
  }

  /* The other-methods column merges into the same inclusion decision as the
     main column, from the right -- never into the totals box, which is a
     number the reviewer states directly rather than one this figure sums. */
  const otherChain = built.filter((b) => b.box.column === "other" && b.box.kind === "box");
  const included = byId.get("included");
  if (otherChain.length && included) {
    const last = byId.get(otherChain[otherChain.length - 1]!.box.id)!;
    const oc = last.x + last.w / 2;
    const cy = included.y + included.h / 2;
    edges.push({
      from: last.id, to: "included", style: "solid", arrow: true,
      points: [{ x: oc, y: last.y + last.h }, { x: oc, y: cy }, { x: included.x + included.w, y: cy }],
    });
  }

  /* Previous studies run down the left margin into the lowest drawn box of
     the main chain -- "total" when it was given, "included" when it was not. */
  const previous = byId.get("previous");
  const mainChain = built
    .filter((b) => b.box.column === "main" && b.box.kind === "box")
    .sort((a, b) => ROW_ORDER.indexOf(a.box.row!) - ROW_ORDER.indexOf(b.box.row!));
  if (previous && mainChain.length) {
    const target = byId.get(mainChain[mainChain.length - 1]!.box.id)!;
    const pc = previous.x + previous.w / 2;
    const cy = target.y + target.h / 2;
    edges.push({
      from: "previous", to: target.id, style: "solid", arrow: true,
      points: [{ x: pc, y: previous.y + previous.h }, { x: pc, y: cy }, { x: target.x, y: cy }],
    });
  }

  let width = MARGIN;
  let height = MARGIN;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.w + MARGIN);
    height = Math.max(height, n.y + n.h + MARGIN);
  }
  return { width, height, nodes, edges };
}
