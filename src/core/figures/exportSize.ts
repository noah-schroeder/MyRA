/**
 * The three sizes a figure can be exported at, and the page geometry behind
 * two of them.
 *
 * A chart and a diagram both draw at a size that fits the artifact panel on
 * screen -- but a figure bound for a manuscript has a different question to
 * answer: a PRISMA figure is conventionally a full portrait page and a
 * flowchart a full landscape one, and "whatever the panel happened to be"
 * answers neither. So export is a separate choice, made once per figure kind
 * and remembered, from exactly these three options.
 *
 * No imports, the same discipline as core/research/databases.ts: this is read
 * by the renderer's export picker and by the two svg.ts writers alike, and a
 * module neither side has to think twice about importing stays that way only
 * by carrying nothing in.
 */

export type ExportSize = "standard" | "portrait" | "landscape";

const EXPORT_SIZES: readonly ExportSize[] = ["standard", "portrait", "landscape"];

/** Validates whatever a stored preference or a stray value turns out to be --
 *  the same reason clampWidth in artifactWidth.ts never trusts localStorage
 *  outright. */
export function parseExportSize(v: unknown): ExportSize | undefined {
  return typeof v === "string" && (EXPORT_SIZES as readonly string[]).includes(v)
    ? (v as ExportSize)
    : undefined;
}

export type Paper = "letter" | "a4";

const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH"]);

/** The two-letter region subtag of a BCP-47 locale string ("en-US" -> "US"),
 *  or nothing for a bare language tag ("en") or a locale this cannot parse.
 *  Matched in uppercase only, since a region subtag is conventionally written
 *  that way and the language subtag that precedes it ("en", "de") is not. */
function regionOf(locale: string): string | undefined {
  return locale.split("-").find((part) => /^[A-Z]{2}$/.test(part));
}

/** Letter in the handful of countries that use it; A4 everywhere else,
 *  including when the locale carries no region at all. */
export function paperForLocale(locale: string | undefined): Paper {
  if (!locale) return "a4";
  const region = regionOf(locale);
  return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
}

export interface PageBox {
  width: number;
  height: number;
  widthIn: number;
  heightIn: number;
}

const PX_PER_IN = 96;
const MARGIN_IN = 1;

/** Sheet size, not the text block -- pageBox below subtracts the margins. */
const SHEET_IN: Record<Paper, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.26772, height: 11.69291 },
};

/**
 * The text block of a page with 1-inch margins on every side -- the box a
 * full-page figure has to fit inside, not the sheet itself. `undefined` for
 * "standard", which has no page to speak of.
 */
export function pageBox(size: ExportSize, paper: Paper): PageBox | undefined {
  if (size === "standard") return undefined;
  const sheet = SHEET_IN[paper];
  const textW = sheet.width - 2 * MARGIN_IN;
  const textH = sheet.height - 2 * MARGIN_IN;
  const [widthIn, heightIn] = size === "landscape" ? [textH, textW] : [textW, textH];
  return {
    widthIn, heightIn,
    width: Math.round(widthIn * PX_PER_IN),
    height: Math.round(heightIn * PX_PER_IN),
  };
}

/** The scale that fits a `w`x`h` box inside `box`, preserving proportions.
 *  Upscaling is allowed on purpose: choosing "landscape page" for a diagram
 *  drawn small means "make it fill the page", not "shrink it if it happens
 *  to be bigger". */
export function fitWithin(w: number, h: number, box: { width: number; height: number }): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(box.width / w, box.height / h);
}

/** Today's on-screen-quality PNG scale, used for "standard". */
export const PNG_SCALE_STANDARD = 2;

/** 300dpi, for a figure exported at a page size that is meant to print. */
export const PNG_SCALE_PAGE = 300 / PX_PER_IN;

export { PX_PER_IN };
