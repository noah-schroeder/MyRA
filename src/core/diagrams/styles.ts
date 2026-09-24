/**
 * The looks a diagram can be drawn in: presets, not a theme editor.
 *
 * A figure bound for a poster wants bold type, generous padding and heavy
 * arrows; one bound for a journal wants thin lines, a font the typesetter has,
 * and no drop shadows; one bound for a black-and-white page wants no colour at
 * all. Those are three coherent sets of decisions, and a researcher should get
 * one by picking a word, not by tuning a dozen sliders into something that is
 * none of them. So each look is a fixed, finished preset, and "standard" is
 * exactly what MyRA drew before looks existed -- `test/diagramSvg.test.ts`'s
 * byte-identity test pins that.
 *
 * A look has two halves. The geometry (`Look`) changes how big boxes are and
 * how far apart, so it goes into `layoutDiagram`; the colours (`DiagramTheme`)
 * only paint what was placed. Standard keeps its old split -- the app's CSS on
 * screen, `PAPER_THEME` on export -- while every named look is drawn on screen
 * in the very colours it exports in, because a poster figure previewed in dark
 * mode would be a preview of something else.
 *
 * PRISMA figures never take a look: their appearance is the official template.
 *
 * Type-only imports, so this sits under layout.ts and svg.ts with no cycle.
 */

import type { DiagramTheme } from "./svg.ts";

export type DiagramStyleName = "standard" | "journal" | "poster" | "monochrome";

export const DIAGRAM_STYLES: readonly DiagramStyleName[] = ["standard", "journal", "poster", "monochrome"];

export const STYLE_LABELS: Record<DiagramStyleName, string> = {
  standard: "Standard",
  journal: "Journal",
  poster: "Poster",
  monochrome: "Monochrome",
};

/** A stored preference or a model's argument, validated rather than trusted. */
export function parseDiagramStyle(v: unknown): DiagramStyleName | undefined {
  return typeof v === "string" && (DIAGRAM_STYLES as readonly string[]).includes(v)
    ? (v as DiagramStyleName)
    : undefined;
}

/** Geometry and type: everything about a look that changes where things go. */
export interface Look {
  name: DiagramStyleName;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontFamily: string;
  /** Fraction of the font size one character is assumed to occupy -- wider for bold. */
  charW: number;
  padX: number;
  padY: number;
  minW: number;
  minH: number;
  rankGap: number;
  siblingGap: number;
  margin: number;
  /** Corner radius of an ordinary box. */
  radius: number;
  nodeStrokeWidth: number;
  edgeWidth: number;
  arrowSize: number;
  /** Radius an edge's elbows are rounded to. 0 is a sharp corner. */
  elbowRadius: number;
  shadow: boolean;
  shadowBlur: number;
  shadowDy: number;
}

const STANDARD: Look = {
  name: "standard",
  fontSize: 13,
  lineHeight: 17,
  fontWeight: 400,
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  charW: 0.58,
  padX: 16,
  padY: 12,
  minW: 96,
  minH: 40,
  rankGap: 56,
  siblingGap: 28,
  margin: 20,
  radius: 10,
  nodeStrokeWidth: 1.5,
  edgeWidth: 1.5,
  arrowSize: 8,
  elbowRadius: 0,
  shadow: true,
  shadowBlur: 3,
  shadowDy: 2,
};

/**
 * Helvetica or Arial, because that is what most journals' figure guidelines
 * name and what a typesetter's machine will have; thin rules and square-ish
 * corners, and no shadow -- print reproduces one as a grey smear.
 */
const JOURNAL: Look = {
  name: "journal",
  fontSize: 12,
  lineHeight: 16,
  fontWeight: 400,
  fontFamily: "Helvetica, Arial, sans-serif",
  charW: 0.56,
  padX: 14,
  padY: 9,
  minW: 88,
  minH: 34,
  rankGap: 46,
  siblingGap: 24,
  margin: 16,
  radius: 3,
  nodeStrokeWidth: 1,
  edgeWidth: 1,
  arrowSize: 7,
  elbowRadius: 0,
  shadow: false,
  shadowBlur: 0,
  shadowDy: 0,
};

/**
 * Read from across a room: semibold, roomy, rounded, with arrows heavy enough
 * to follow at a glance and elbows rounded so the flow reads as one line.
 */
const POSTER: Look = {
  name: "poster",
  fontSize: 16,
  lineHeight: 21,
  fontWeight: 600,
  fontFamily: "Inter, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  charW: 0.62,
  padX: 22,
  padY: 16,
  minW: 130,
  minH: 52,
  rankGap: 70,
  siblingGap: 40,
  margin: 28,
  radius: 16,
  nodeStrokeWidth: 2,
  edgeWidth: 2.5,
  arrowSize: 12,
  elbowRadius: 12,
  shadow: true,
  shadowBlur: 5,
  shadowDy: 3,
};

export const LOOKS: Record<DiagramStyleName, Look> = {
  standard: STANDARD,
  journal: JOURNAL,
  poster: POSTER,
  /* The journal's geometry; only the colours differ. */
  monochrome: { ...JOURNAL, name: "monochrome" },
};

/**
 * The palettes of the three named looks. Every category fill clears 7:1
 * against its own `text`, which `test/diagramStyles.test.ts` checks rather
 * than trusts.
 */
export const STYLE_THEMES: Record<Exclude<DiagramStyleName, "standard">, DiagramTheme> = {
  /* Light tints of the Okabe-Ito palette, the usual colour-blind-safe set,
     in its own order -- blue, orange, bluish green, vermillion, reddish
     purple, sky blue -- under black rules and near-black text. */
  journal: {
    background: "#ffffff",
    nodeFill: "#ffffff",
    tintFill: "#eeeeee",
    nodeStroke: "#222222",
    text: "#111111",
    edge: "#333333",
    edgeLabel: "#222222",
    edgeLabelBg: "#ffffff",
    shadowColor: "rgba(0, 0, 0, 0)",
    categoryFill: ["#cce3f0", "#fae6bf", "#c2e8dc", "#f5d4bf", "#f2dde9", "#d5ecfa"],
  },
  /* Soft fills, each with a stronger stroke in the same hue, so a category is
     told apart by its outline as much as by its fill -- which survives a
     projector that washes pastels out. */
  poster: {
    background: "#ffffff",
    nodeFill: "#f3f6fb",
    tintFill: "#e6ecf5",
    nodeStroke: "#3b5b85",
    text: "#10233d",
    edge: "#4b6a8f",
    edgeLabel: "#2a4466",
    edgeLabelBg: "#ffffff",
    shadowColor: "rgba(16, 35, 61, 0.16)",
    categoryFill: ["#dbe8fb", "#d8f0e3", "#fdebd0", "#fadcdc", "#e8e0f7", "#d4eef0"],
    categoryStroke: ["#2f6fc4", "#2e8b57", "#c98a16", "#c0504d", "#7b5bb6", "#2a8c94"],
  },
  /* Six steps of grey, and every colour the source asked for mapped to the
     grey of the same lightness -- so "the red box" is still the darker one. */
  monochrome: {
    background: "#ffffff",
    nodeFill: "#ffffff",
    tintFill: "#ececec",
    nodeStroke: "#000000",
    text: "#000000",
    edge: "#222222",
    edgeLabel: "#000000",
    edgeLabelBg: "#ffffff",
    shadowColor: "rgba(0, 0, 0, 0)",
    categoryFill: ["#f0f0f0", "#dcdcdc", "#c8c8c8", "#b4b4b4", "#e6e6e6", "#d2d2d2"],
    greyscale: true,
  },
};
