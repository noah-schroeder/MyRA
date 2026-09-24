/**
 * The PRISMA 2020 flow diagram, as a flat list of boxes and the rows in them.
 *
 * Verbatim from the four official templates at prisma-statement.org/prisma-2020-flow-diagram
 * (Page MJ, et al. BMJ 2021;372:n71), cross-checked against the PRISMA2020 R package's own
 * box table. The wording is the part that matters: a reviewer reads this figure against the
 * template they know, and "Full-text articles assessed for eligibility" -- which is what
 * research/prisma.ts used to emit -- is the 2009 figure's caption, not this one's.
 *
 * ONE list, for the reason databases.ts is one list: the form that asks for the numbers and
 * the layout that draws them both walk it, so a box cannot be asked for and not drawn, or
 * drawn and never asked for.
 *
 * No imports, so the renderer can read it.
 */

export type PrismaVariantId = "new" | "new+other" | "updated" | "updated+other";

export const PRISMA_VARIANTS: readonly PrismaVariantId[] = ["new", "new+other", "updated", "updated+other"];

export const VARIANT_LABEL: Record<PrismaVariantId, string> = {
  "new": "A new systematic review",
  "new+other": "A new systematic review, with other search methods",
  "updated": "An updated systematic review",
  "updated+other": "An updated systematic review, with other search methods",
};

/**
 * Which variants a box or field belongs to. Absent means every variant.
 *
 * An explicit list of exact variants rather than a symbolic tag: "the other
 * column, updated wording" needs the AND of two conditions ("+other" AND
 * "updated"), and a single tag can only ever express one of them. Four
 * variants is few enough that spelling them out is not a burden, and it
 * leaves nothing for a reader to work out by running inVariant in their head.
 */
export type PrismaOnly = readonly PrismaVariantId[];

export type PrismaColumnId = "band" | "previous" | "main" | "mainSide" | "other" | "otherSide";

/** Down the page. A row with nothing drawn in it takes no space at all. */
export type PrismaRowId = "title" | "identified" | "screened" | "sought" | "assessed" | "included" | "total";

export type PrismaPhaseId = "identification" | "screening" | "included";

export const PHASE_LABEL: Record<PrismaPhaseId, string> = {
  identification: "Identification",
  screening: "Screening",
  included: "Included",
};

/** Which phase a row belongs to. Fixed by the template, not by what is filled in. */
export const ROW_PHASE: Record<PrismaRowId, PrismaPhaseId> = {
  title: "identification",
  identified: "identification",
  screened: "screening",
  sought: "screening",
  assessed: "screening",
  included: "included",
  total: "included",
};

/** Top to bottom, as the template reads. */
export const ROW_ORDER: readonly PrismaRowId[] = [
  "title", "identified", "screened", "sought", "assessed", "included", "total",
];

export type PrismaBoxKind =
  | "box"   // a main-column box, in the chain of arrows
  | "side"  // an exclusion box, hung at its parent's own vertical level
  | "title" // a column heading, spanning the column and its side column
  | "band"; // a phase band, turned a quarter turn down the left edge

export interface PrismaBox {
  /** Stable; the layout uses it as the PlacedNode id and in every edge. */
  readonly id: string;
  readonly kind: PrismaBoxKind;
  readonly column: PrismaColumnId;
  /** Absent only for a band, which spans every row of its phase. */
  readonly row?: PrismaRowId;
  readonly phase: PrismaPhaseId;
  /**
   * The line above the rows, verbatim. A captioned box is left-aligned and its
   * rows read "Databases (n = 842)"; an uncaptioned one is centred and breaks
   * before the count, which is what the template does.
   */
  readonly caption?: string;
  /** A side box's stub leaves this box's right edge. */
  readonly parent?: string;
  readonly only?: PrismaOnly;
}

export interface PrismaField {
  /** What the form stores the answer under, and the layout reads it back by. */
  readonly id: string;
  readonly box: string;
  /**
   * The row's words, verbatim. For a `list` field this is the form's label
   * only -- the drawn rows are the items the user typed.
   */
  readonly caption: string;
  readonly kind: "count" | "list";
  readonly only?: PrismaOnly;
  /** One line under the input, saying what the number actually counts. */
  readonly hint?: string;
}

const NEW: PrismaOnly = ["new", "new+other"];
const UPDATED: PrismaOnly = ["updated", "updated+other"];
const OTHER: PrismaOnly = ["new+other", "updated+other"];
const NEW_OTHER: PrismaOnly = ["new+other"];
const UPDATED_OTHER: PrismaOnly = ["updated+other"];

/* ------------------------------------------------------------------ boxes --- */

export const PRISMA_BOXES = [
  { id: "bandIdentification", kind: "band", column: "band", phase: "identification", caption: "Identification" },
  { id: "bandScreening", kind: "band", column: "band", phase: "screening", caption: "Screening" },
  { id: "bandIncluded", kind: "band", column: "band", phase: "included", caption: "Included" },

  { id: "previousTitle", kind: "title", column: "previous", row: "title", phase: "identification",
    caption: "Previous studies", only: UPDATED },
  /* The single word "new" is the whole difference between the new and updated
     headings -- exactly what a figure typed by hand gets wrong. */
  { id: "mainTitle", kind: "title", column: "main", row: "title", phase: "identification",
    caption: "Identification of studies via databases and registers", only: NEW },
  { id: "mainTitleUpdated", kind: "title", column: "main", row: "title", phase: "identification",
    caption: "Identification of new studies via databases and registers", only: UPDATED },
  { id: "otherTitle", kind: "title", column: "other", row: "title", phase: "identification",
    caption: "Identification of studies via other methods", only: NEW_OTHER },
  { id: "otherTitleUpdated", kind: "title", column: "other", row: "title", phase: "identification",
    caption: "Identification of new studies via other methods", only: UPDATED_OTHER },

  { id: "previous", kind: "box", column: "previous", row: "identified", phase: "identification", only: UPDATED },

  /* The template prints "Records identified from*:" and "Records excluded**",
     markers for two footnotes under the figure. The markers are dropped here:
     MyRA names the databases the first footnote asks for, and carries the
     automation row the second is about -- an asterisk with no footnote on the
     page is a dangling reference in a published figure. */
  { id: "identified", kind: "box", column: "main", row: "identified", phase: "identification",
    caption: "Records identified from:" },
  { id: "removed", kind: "side", column: "mainSide", row: "identified", phase: "identification",
    caption: "Records removed before screening:", parent: "identified" },
  { id: "screened", kind: "box", column: "main", row: "screened", phase: "screening" },
  { id: "recordsExcluded", kind: "side", column: "mainSide", row: "screened", phase: "screening",
    parent: "screened" },
  { id: "sought", kind: "box", column: "main", row: "sought", phase: "screening" },
  { id: "notRetrieved", kind: "side", column: "mainSide", row: "sought", phase: "screening", parent: "sought" },
  { id: "assessed", kind: "box", column: "main", row: "assessed", phase: "screening" },
  { id: "reportsExcluded", kind: "side", column: "mainSide", row: "assessed", phase: "screening",
    caption: "Reports excluded:", parent: "assessed" },

  { id: "included", kind: "box", column: "main", row: "included", phase: "included" },
  { id: "total", kind: "box", column: "main", row: "total", phase: "included", only: UPDATED },

  { id: "otherIdentified", kind: "box", column: "other", row: "identified", phase: "identification",
    caption: "Records identified from:", only: OTHER },
  { id: "otherSought", kind: "box", column: "other", row: "sought", phase: "screening", only: OTHER },
  { id: "otherNotRetrieved", kind: "side", column: "otherSide", row: "sought", phase: "screening",
    parent: "otherSought", only: OTHER },
  { id: "otherAssessed", kind: "box", column: "other", row: "assessed", phase: "screening", only: OTHER },
  { id: "otherExcluded", kind: "side", column: "otherSide", row: "assessed", phase: "screening",
    caption: "Reports excluded:", parent: "otherAssessed", only: OTHER },
] as const satisfies readonly PrismaBox[];

/* ----------------------------------------------------------------- fields --- */

export const PRISMA_FIELDS = [
  { id: "previousStudies", box: "previous", kind: "count", only: UPDATED,
    caption: "Studies included in previous version of review" },
  { id: "previousReports", box: "previous", kind: "count", only: UPDATED,
    caption: "Reports of studies included in previous version of review" },

  /* The template's own footnote asks for the per-database numbers "rather
     than the total number across all databases" -- and MyRA queried named
     databases, so it can offer them. Any item typed here replaces the plain
     Databases count below. */
  { id: "databasesNamed", box: "identified", kind: "list", caption: "Databases, named one by one",
    hint: "One database per line, e.g. \"OpenAlex (n = 842)\". Replaces the Databases count below." },
  { id: "databases", box: "identified", kind: "count", caption: "Databases",
    hint: "Records the database searches returned, before de-duplication." },
  { id: "registers", box: "identified", kind: "count", caption: "Registers",
    hint: "Trial registries, if any were searched." },

  { id: "duplicates", box: "removed", kind: "count", caption: "Duplicate records removed" },
  { id: "automation", box: "removed", kind: "count",
    caption: "Records marked as ineligible by automation tools" },
  { id: "removedOther", box: "removed", kind: "count", caption: "Records removed for other reasons" },

  { id: "screened", box: "screened", kind: "count", caption: "Records screened" },
  { id: "recordsExcluded", box: "recordsExcluded", kind: "count", caption: "Records excluded" },
  { id: "sought", box: "sought", kind: "count", caption: "Reports sought for retrieval" },
  { id: "notRetrieved", box: "notRetrieved", kind: "count", caption: "Reports not retrieved" },
  { id: "assessed", box: "assessed", kind: "count", caption: "Reports assessed for eligibility" },
  { id: "reportsExcluded", box: "reportsExcluded", kind: "list", caption: "Reports excluded, by reason",
    hint: "One reason per line, e.g. \"Wrong population (n = 12)\"." },

  { id: "includedStudies", box: "included", kind: "count", only: NEW, caption: "Studies included in review" },
  { id: "includedReports", box: "included", kind: "count", only: NEW, caption: "Reports of included studies" },
  { id: "newStudies", box: "included", kind: "count", only: UPDATED, caption: "New studies included in review" },
  { id: "newReports", box: "included", kind: "count", only: UPDATED, caption: "Reports of new included studies" },
  { id: "totalStudies", box: "total", kind: "count", only: UPDATED, caption: "Total studies included in review" },
  { id: "totalReports", box: "total", kind: "count", only: UPDATED, caption: "Reports of total included studies" },

  { id: "websites", box: "otherIdentified", kind: "count", only: OTHER, caption: "Websites" },
  { id: "organisations", box: "otherIdentified", kind: "count", only: OTHER, caption: "Organisations" },
  { id: "citations", box: "otherIdentified", kind: "count", only: OTHER, caption: "Citation searching" },
  { id: "otherSought", box: "otherSought", kind: "count", only: OTHER, caption: "Reports sought for retrieval" },
  { id: "otherNotRetrieved", box: "otherNotRetrieved", kind: "count", only: OTHER,
    caption: "Reports not retrieved" },
  { id: "otherAssessed", box: "otherAssessed", kind: "count", only: OTHER,
    caption: "Reports assessed for eligibility" },
  { id: "otherExcluded", box: "otherExcluded", kind: "list", only: OTHER, caption: "Reports excluded, by reason",
    hint: "One reason per line, e.g. \"Not a primary source (n = 4)\"." },
] as const satisfies readonly PrismaField[];

export type PrismaBoxId = (typeof PRISMA_BOXES)[number]["id"];
export type PrismaFieldId = (typeof PRISMA_FIELDS)[number]["id"];
export type PrismaCountId = Extract<(typeof PRISMA_FIELDS)[number], { kind: "count" }>["id"];
export type PrismaListId = Extract<(typeof PRISMA_FIELDS)[number], { kind: "list" }>["id"];

/*
 * Two views of the same data. PRISMA_BOXES/PRISMA_FIELDS keep the exact
 * literal shape `as const satisfies` produces, which is what the id-union
 * types above are extracted from -- but that literal union has no `only` key
 * at all on the entries that never declared one, so reading `.only` on it
 * uniformly is a type error even though the interface says the field is
 * merely optional. BOXES/FIELDS widen to the plain interface, which is what
 * every function below actually wants: one shape, an optional field, read
 * the same way on every entry.
 */
const BOXES: readonly PrismaBox[] = PRISMA_BOXES;
const FIELDS: readonly PrismaField[] = PRISMA_FIELDS;

/** One row of a variable-length list: a reason, or a named database. */
export interface PrismaItem {
  /** Blank drops the row -- an empty "add another" slot is not a reason. */
  label: string;
  /** Absent draws the label alone; some reviewers list a reason with no count. */
  n?: number | undefined;
}

export interface PrismaFigure {
  variant: PrismaVariantId;
  title: string;
  /**
   * `undefined` omits the row; `0` draws "(n = 0)".
   *
   * The distinction is the whole rule, and it restates research/prisma.ts's
   * own one: a box reading zero is a claim that a stage ran and found
   * nothing, which is a different statement from a stage that never ran. So a
   * blank input parses to `undefined`, and a typed 0 stays 0.
   */
  counts: Partial<Record<PrismaCountId, number>>;
  items: Partial<Record<PrismaListId, readonly PrismaItem[]>>;
}

export function emptyFigure(variant: PrismaVariantId, title = "PRISMA flow diagram"): PrismaFigure {
  return { variant, title, counts: {}, items: {} };
}

/** "" is an unanswered question; "0" is an answer. */
export function parseCount(typed: string): number | undefined {
  const t = typed.trim().replace(/,/g, "");
  if (!t) return undefined;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/** "1,203", because these numbers are read rather than computed with. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** "Wrong population (n = 12)" per line, back into structured rows. */
export function parseItems(text: string): PrismaItem[] {
  const out: PrismaItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.*?)\s*\(\s*n\s*=\s*([\d,]+)\s*\)\s*$/i.exec(line);
    if (!m) { out.push({ label: line }); continue; }
    const label = m[1]!.trim();
    const n = parseCount(m[2]!);
    out.push(n === undefined ? { label } : { label, n });
  }
  return out;
}

/** The inverse of parseItems, for prefilling a form from an existing figure. */
export function renderItems(items: readonly PrismaItem[] | undefined): string {
  return (items ?? []).map((i) => (i.n === undefined ? i.label : `${i.label} (n = ${formatCount(i.n)})`)).join("\n");
}

export function inVariant(only: PrismaOnly | undefined, v: PrismaVariantId): boolean {
  return !only || only.includes(v);
}

export function boxesFor(v: PrismaVariantId): readonly PrismaBox[] {
  return BOXES.filter((b) => inVariant(b.only, v));
}

export function fieldsFor(v: PrismaVariantId): readonly PrismaField[] {
  return FIELDS.filter((f) => inVariant(f.only, v));
}

/** The rows of one box, in declaration order. The form groups by this; so does the layout. */
export function fieldsIn(box: string, v: PrismaVariantId): readonly PrismaField[] {
  return fieldsFor(v).filter((f) => f.box === box);
}

/** One form section per phase, in the template's own top-to-bottom order. */
export interface PrismaFormSection {
  phase: PrismaPhaseId;
  label: string;
  fields: readonly PrismaField[];
}

/** Every field, regardless of variant -- for building a tool's parameter schema. */
export function allFields(): readonly PrismaField[] {
  return FIELDS;
}

export function formSections(v: PrismaVariantId): PrismaFormSection[] {
  const boxPhase = new Map<string, PrismaPhaseId>(BOXES.map((b) => [b.id, b.phase]));
  const byPhase = new Map<PrismaPhaseId, PrismaField[]>();
  for (const f of fieldsFor(v)) {
    const phase = boxPhase.get(f.box);
    if (!phase) continue;
    const arr = byPhase.get(phase) ?? [];
    arr.push(f);
    byPhase.set(phase, arr);
  }
  return (["identification", "screening", "included"] as const)
    .filter((p) => byPhase.has(p))
    .map((p) => ({ phase: p, label: PHASE_LABEL[p], fields: byPhase.get(p)! }));
}

/* --------------------------------------------------------- the form itself --- */

export interface PrismaFormField {
  key: string;
  label: string;
  hint?: string;
  group: string;
  /** A textarea for a variable-length list, rather than one line per number. */
  kind?: "list";
  value?: string;
  /** Read from the conversation rather than typed here -- not yet confirmed. */
  guessed?: boolean;
}

/**
 * The fields a form needs to fill in one variant of the figure, in the
 * template's own phase order, optionally prefilled.
 *
 * One function serves two callers with different prefill sources and
 * different trust in them: a first draw, where the values (if any) came from
 * a model reading the conversation and are marked as a guess to check; and an
 * edit, where they came from a figure already on screen that the user
 * themselves put there, and nothing is a guess. `guessed` is a single flag
 * for the whole call rather than per-field for exactly that reason -- one
 * figure is never a mix of the two kinds of prefill.
 */
export function figureFormFields(
  variant: PrismaVariantId,
  prefill: Pick<PrismaFigure, "counts" | "items"> = { counts: {}, items: {} },
  guessed = false,
): PrismaFormField[] {
  const out: PrismaFormField[] = [];
  for (const section of formSections(variant)) {
    for (const f of section.fields) {
      const base = { key: f.id, label: f.caption, group: section.label, ...(f.hint ? { hint: f.hint } : {}) };
      if (f.kind === "list") {
        const items = prefill.items[f.id as PrismaListId];
        out.push({ ...base, kind: "list" as const, ...(items?.length ? { value: renderItems(items), guessed } : {}) });
      } else {
        const v = prefill.counts[f.id as PrismaCountId];
        out.push({ ...base, ...(v !== undefined ? { value: formatCount(v), guessed } : {}) });
      }
    }
  }
  return out;
}

/** The inverse: a filled form, read back into a figure. */
export function figureFromFormAnswers(
  variant: PrismaVariantId,
  title: string,
  answers: Record<string, string>,
): PrismaFigure {
  const fig = emptyFigure(variant, title);
  for (const f of fieldsFor(variant)) {
    const raw = answers[f.id];
    if (raw === undefined) continue;
    if (f.kind === "list") {
      const items = parseItems(raw);
      if (items.length) fig.items[f.id as PrismaListId] = items;
    } else {
      const n = parseCount(raw);
      if (n !== undefined) fig.counts[f.id as PrismaCountId] = n;
    }
  }
  return fig;
}

/** Whether a figure has anything at all left to draw. */
export function figureIsBlank(fig: Pick<PrismaFigure, "counts" | "items">): boolean {
  return !Object.keys(fig.counts).length && !Object.keys(fig.items).length;
}
