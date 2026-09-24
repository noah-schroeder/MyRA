/**
 * Drawing a PRISMA 2020 flow diagram, as a tool that asks rather than guesses.
 *
 * A systematic review's flow diagram is a dozen-odd numbers a reviewer already
 * has -- how many records each database returned, how many were screened out
 * and why, how many reached the synthesis -- and getting them wrong is not a
 * cosmetic error: this figure is what an editor and a reader check the review
 * against. So the model is not trusted to fill it in from memory. It may pass
 * counts it read directly in the conversation, but every one of them reaches
 * the user marked as a guess in the same form where the blank ones are asked
 * for, and nothing is drawn until the user has seen and can correct all of
 * them -- the same discipline research/prisma.ts already keeps for a number
 * this app measured itself: a count nobody confirmed is not written down.
 *
 * The dialogs are the research pipeline's own -- a choice question, then an
 * editing step -- because "MyRA is asking me something and will draw a figure
 * once I answer" is one experience, the same reasoning documents.ts's drafting
 * flow and the paper drafter already share this UI for.
 *
 * `safe` rather than `write`: nothing here touches a disk. The figure is held
 * in the conversation and written out only when a person presses Export.
 */

import type { ToolDef, ToolResult } from "../registry.ts";
import { announceDiagram, nextDiagramId } from "./diagram.ts";
import type { Choice } from "../../research/questions.ts";
import {
  allFields, figureFormFields, figureFromFormAnswers, figureIsBlank, parseItems,
  type PrismaCountId, type PrismaFormField, type PrismaItem, type PrismaListId, type PrismaVariantId,
} from "../../prisma/spec.ts";

/**
 * What the app must attach: a way to ask the two questions this tool needs.
 *
 * A smaller surface than `PipelineUi`, deliberately its own rather than a
 * reuse of it: the research pipeline's interface is "just what the pipeline
 * needs", and a figure-drawing tool wants a different pair of things -- one of
 * which, the form, the pipeline has no reason to grow.
 */
export interface PrismaUi {
  choose(choice: Choice): Promise<string | undefined>;
  form(
    title: string,
    message: string | undefined,
    fields: readonly PrismaFormField[],
  ): Promise<Record<string, string> | undefined>;
}

export interface PrismaHost {
  ui: PrismaUi;
}

let host: PrismaHost | undefined;

export function setPrismaHost(installed: PrismaHost | undefined): void {
  host = installed;
}

/**
 * Done already this turn, the same rule and the same reason as deep_research:
 * the model is free to call the tool again after reading its own result, and
 * re-entering it puts a dialog in front of a user who was told the figure was
 * drawn. A cancel at any step still sets this -- it means "not now", not
 * "ask me again a moment later".
 */
let doneThisTurn = false;

/** Called at the start of each turn; a new turn may draw another figure. */
export function beginPrismaTurn(): void {
  doneThisTurn = false;
}

const REVIEW_TYPE_CHOICE: Choice = {
  title: "Is this a new systematic review, or an update of an earlier one?",
  options: ["A new review", "An update of a previous review"],
  required: true,
};

const OTHER_METHODS_CHOICE: Choice = {
  title:
    "Besides databases and registers, did this review search other sources — websites, " +
    "organisations, or citation searching?",
  options: ["No, only databases and registers", "Yes, other methods too"],
  required: true,
};

function toVariant(reviewAnswer: string, otherAnswer: string): PrismaVariantId {
  const updated = reviewAnswer.startsWith("An update");
  const other = otherAnswer.startsWith("Yes");
  return (updated ? (other ? "updated+other" : "updated") : other ? "new+other" : "new") as PrismaVariantId;
}

/** A tool parameter's number, kept only if it is one -- never NaN, never negative. */
function readCounts(raw: unknown): Partial<Record<PrismaCountId, number>> {
  const out: Partial<Record<PrismaCountId, number>> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const f of allFields()) {
    if (f.kind !== "count") continue;
    const v = obj[f.id];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[f.id as PrismaCountId] = Math.round(v);
  }
  return out;
}

/** Each entry is one line, in the same "Label (n = N)" shape the form itself reads back. */
function readItems(raw: unknown): Partial<Record<PrismaListId, PrismaItem[]>> {
  const out: Partial<Record<PrismaListId, PrismaItem[]>> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const f of allFields()) {
    if (f.kind !== "list") continue;
    const v = obj[f.id];
    if (!Array.isArray(v)) continue;
    const items = v
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .flatMap((s) => parseItems(s));
    if (items.length) out[f.id as PrismaListId] = items;
  }
  return out;
}

/** One property per field the spec declares -- so a field added there needs no second edit here. */
function countSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const f of allFields()) {
    if (f.kind !== "count") continue;
    props[f.id] = { type: "number", description: f.hint ? `${f.caption} — ${f.hint}` : f.caption };
  }
  return props;
}

function listSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const f of allFields()) {
    if (f.kind !== "list") continue;
    props[f.id] = {
      type: "array",
      items: { type: "string" },
      description:
        `${f.caption}${f.hint ? ` — ${f.hint}` : ""}. One entry per line, each like ` +
        `"Wrong population (n = 12)" -- the count is optional.`,
    };
  }
  return props;
}

export const createPrismaDiagramTool: ToolDef = {
  name: "create_prisma_diagram",
  description:
    "Draw a PRISMA 2020 flow diagram -- the standard figure a systematic review reports its " +
    "search and screening numbers in. This asks the user directly which template applies (new " +
    "or updated review; other search methods or not) and shows every number in an editable form " +
    "before anything is drawn, so pass `counts`/`items` only for numbers you are confident the " +
    "user actually stated in this conversation -- never estimate one. Leave a field out entirely " +
    "rather than guessing; the user fills in or corrects whatever you did not pass. Call this " +
    "once, when the user wants the figure itself.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short caption for the figure, as it would read in a paper",
      },
      counts: {
        type: "object",
        description: "Numbers you read in the conversation, keyed exactly as named below.",
        properties: countSchema(),
        additionalProperties: false,
      },
      items: {
        type: "object",
        description: "Variable-length lists you read in the conversation, keyed exactly as named below.",
        properties: listSchema(),
        additionalProperties: false,
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    if (!host) {
      throw new Error(
        "PRISMA diagrams are not available: the app has not attached a dialog host. " +
          "This is a wiring fault, not something to work around.",
      );
    }

    if (doneThisTurn) {
      return {
        content:
          "A PRISMA diagram was already handled in this turn -- drawn, or the user chose not to. " +
          "If the user wants another figure, they will ask in a new message.",
      };
    }
    doneThisTurn = true;

    const title = typeof params["title"] === "string" && params["title"].trim()
      ? params["title"].trim()
      : "PRISMA flow diagram";
    const modelCounts = readCounts(params["counts"]);
    const modelItems = readItems(params["items"]);

    const reviewAnswer = await host.ui.choose(REVIEW_TYPE_CHOICE);
    if (reviewAnswer === undefined) {
      return { content: "The user did not say whether this is a new or updated review, so no diagram was drawn." };
    }
    const otherAnswer = await host.ui.choose(OTHER_METHODS_CHOICE);
    if (otherAnswer === undefined) {
      return { content: "The user did not say whether other search methods were used, so no diagram was drawn." };
    }
    const variant = toVariant(reviewAnswer, otherAnswer);

    const fields = figureFormFields(variant, { counts: modelCounts, items: modelItems }, true);
    const answers = await host.ui.form(
      "PRISMA flow diagram — fill in or check every number",
      "A blank field draws no box for it; type 0 to show zero. Anything already filled in was " +
        "read from the conversation and is marked as a guess -- check it before drawing.",
      fields,
    );
    if (answers === undefined) {
      return { content: "The user did not fill in the figure's numbers, so no diagram was drawn." };
    }

    const figure = figureFromFormAnswers(variant, title, answers);
    if (figureIsBlank(figure)) {
      return { content: "Every field was left blank, so there is nothing to draw." };
    }

    const id = nextDiagramId();
    announceDiagram({ id, title, prisma: figure });

    return {
      content:
        `Drew the PRISMA flow diagram "${title}". It is shown to the user beside the conversation, ` +
        "where they can check the numbers, export it as SVG or PNG, or edit the numbers and redraw " +
        "it. Do not restate the figure's numbers in your reply; say what it shows.",
      detail: { id, title },
    };
  },
};

export const PRISMA_TOOL_DEFS: ToolDef[] = [createPrismaDiagramTool];
