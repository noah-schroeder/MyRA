/**
 * What the paper drafter asks the model, and what it refuses to let it do.
 *
 * Ported in substance from Braindump5000's `build_messages`, which was tuned
 * against real use before it got here. Two things about it are not decoration
 * and must not be softened:
 *
 *  1. **The writing sample is the point.** The system prompt's first job is to
 *     make the model read a few paragraphs of the author's own prose and write
 *     like the same person. Everything else in the request -- the outline, the
 *     preceding section, the notes -- is context for that.
 *  2. **Citations are forbidden outright, and unconditionally.** Nothing in
 *     this flow searches, so every reference a model produces here is invented
 *     by construction. The original tool had a "power-user mode" that replaced
 *     this whole prompt, guardrails included; it is deliberately not carried
 *     over. MyRA's research pipeline refuses to return a draft citing a source
 *     that does not exist, documents/draft.ts tells its section writer the same
 *     thing, and a paper drafter that could be talked out of the rule would be
 *     the one place in the app where a fabricated authority is allowed.
 *
 * The author's own instructions -- for the paper, and for one section -- are
 * appended to this, never substituted for it, and each says so in its own text
 * so the model is not left to work out which of two orders wins.
 *
 * Pure: no endpoint, no disk. The preview dialog renders exactly what these
 * functions return, so what the user is shown is what is sent, character for
 * character.
 */

import type { ChatMessage } from "../llm/chat.ts";
import type { Paper } from "./paper.ts";

/** Said in place of a sample, so the model is never handed an empty quote. */
export const NO_SAMPLE =
  "(No writing sample provided — use a clear, formal academic voice.)";

export const SYSTEM_PROMPT_TEMPLATE = `You are a drafting assistant that helps an academic turn raw, unstructured thoughts into polished first-draft academic prose.

You will be given a WRITING SAMPLE authored by this researcher. Study its voice: sentence rhythm, vocabulary, level of formality, hedging, paragraph structure, and how ideas connect. Everything you write must sound like the same author wrote it.

ABSOLUTE RULES — follow every one:
- Write in an academic register appropriate for a scholarly paper.
- This is a DRAFTING tool. Turn the author's raw notes into flowing prose.
- DO NOT include any citations, references, in-text cites, footnotes, or bibliography. No "(Author, Year)", no "[1]", no "et al.", no reference lists.
- DO NOT insert citation placeholders of any kind — no "[CITE]", "[ref]", "(citation needed)", "XX", or similar. Citations are handled later by a different process.
- DO NOT invent specific sources, studies, authors, statistics, dataset names, or quotations that the author did not supply. If the notes claim a fact, state it as the author framed it, without attributing it to a fabricated source.
- Write ONLY the requested section. Do not write other sections.
- Output ONLY the section's prose. No section heading, no preamble, no meta-commentary, no "Here is the draft", no explanation of your choices.
- Match the length to the substance of the notes — expand rough thoughts into complete academic paragraphs, but do not pad with empty filler.

WRITING SAMPLE (match this author's voice):
"""
{writing_sample}
"""`;

export interface DraftRequest {
  mode: "draft" | "refine";
  writingSample: string;
  /** Guidance for the whole paper. Empty in single-section mode. */
  instructions: string;
  paperTitle: string;
  /** Every heading, in order, so a section knows what it is not writing. */
  outline: string[];
  sectionName: string;
  notes: string;
  /** Guidance for this section alone. */
  guidance: string;
  /** The finished text of the section before this one, for the seam. */
  precedingDraft: string;
  /** What is on the page now. Refine rewrites this. */
  currentDraft: string;
  /** The one-line revision instruction. Refine only. */
  instruction: string;
}

function quoted(text: string): string {
  return `"""\n${text}\n"""`;
}

/** The system message: the template, plus the author's paper-wide guidance. */
export function buildSystem(request: DraftRequest): string {
  const sample = request.writingSample.trim() || NO_SAMPLE;
  const system = SYSTEM_PROMPT_TEMPLATE.replace("{writing_sample}", sample);
  const instructions = request.instructions.trim();
  if (!instructions) return system;
  /* Appended, and told plainly that it does not outrank what is above it.
     A model given two sets of instructions and no precedence picks one, and
     the one it picks is the more recent -- which here would be the one that
     can be talked into citing. */
  return (
    `${system}\n\n` +
    `ADDITIONAL INSTRUCTIONS FOR THIS PAPER (from the author — apply these throughout, ` +
    `but they do NOT override the no-citations / drafting-only rules above):\n` +
    quoted(instructions)
  );
}

/** The user message: the context, the material, and what to do with it. */
export function buildUser(request: DraftRequest): string {
  const context: string[] = [];
  const title = request.paperTitle.trim();
  if (title) context.push(`Paper title: ${title}`);
  /* Only when there is more than one: an outline of a single heading tells the
     model nothing it is not already being told, and reads as a paper with one
     section rather than as a section on its own. */
  const outline = request.outline.map((h) => h.trim()).filter(Boolean);
  if (outline.length > 1) {
    context.push(`Full section outline (for context only): ${outline.join(" → ")}`);
  }
  const preceding = request.precedingDraft.trim();
  if (preceding) {
    context.push(
      `The immediately preceding section has already been drafted. For continuity and flow, ` +
        `here is its text (do NOT rewrite or repeat it — just make your section follow naturally):\n` +
        quoted(preceding),
    );
  }
  const head = context.length ? `${context.join("\n\n")}\n\n` : "";

  const guidance = request.guidance.trim();
  const guidanceBlock = guidance
    ? `Additional instructions for THIS section from the author (follow these closely, ` +
      `but they do not override the no-citations / drafting-only rules above):\n` +
      `${quoted(guidance)}\n\n`
    : "";

  const section = request.sectionName.trim() || "this section";

  if (request.mode === "refine") {
    const instruction =
      request.instruction.trim() ||
      "Improve the clarity and flow while keeping the same meaning.";
    return (
      head +
      `Section to revise: ${section}\n\n` +
      `Current draft of this section:\n${quoted(request.currentDraft.trim())}\n\n` +
      guidanceBlock +
      `Revision instruction from the author: ${instruction}\n\n` +
      `Rewrite the section's prose to satisfy the instruction. Output only the revised prose, ` +
      `still with no citations or placeholders of any kind.`
    );
  }

  return (
    head +
    `Section to write: ${section}\n\n` +
    `The author's raw thoughts / notes for this section:\n${quoted(request.notes.trim())}\n\n` +
    guidanceBlock +
    `Turn these raw thoughts into polished academic prose for this section, in the author's voice. ` +
    `Output only the prose, with no citations or placeholders of any kind.`
  );
}

export function buildPaperMessages(request: DraftRequest): ChatMessage[] {
  return [
    { role: "system", content: buildSystem(request) },
    { role: "user", content: buildUser(request) },
  ];
}

/* ------------------------------------------------------------------ *
 * From the record to the request                                      *
 * ------------------------------------------------------------------ */

/**
 * Everything the model is told about one section, gathered from the paper.
 *
 * Built in the renderer and sent to main as-is, which is what makes the preview
 * honest: the dialog renders `buildSystem`/`buildUser` over this same object, so
 * "exactly what will be sent" is not a reconstruction of the request but the
 * request itself. Nothing is sent to show it.
 */
export function requestFor(
  paper: Paper,
  sectionId: string,
  opts: { mode: "draft" | "refine"; instruction?: string },
): DraftRequest {
  const index = paper.sections.findIndex((s) => s.id === sectionId);
  const section = paper.sections[index] ?? paper.sections[0];
  if (!section) throw new Error("that paper has no sections");
  const previous = index > 0 ? paper.sections[index - 1] : undefined;
  return {
    mode: opts.mode,
    writingSample: paper.writingSample,
    /* Whole-paper guidance only exists in whole-paper mode. A single section
       has one prompt box, and carrying a stale paper-wide one into it would be
       instructions the page does not show. */
    instructions: paper.kind === "paper" ? paper.instructions : "",
    paperTitle: paper.title,
    outline: paper.kind === "paper" ? paper.sections.map((s) => s.name) : [],
    sectionName: paper.kind === "paper" ? section.name : paper.title,
    notes: section.notes,
    guidance: section.guidance,
    precedingDraft: paper.kind === "paper" ? (previous?.draft ?? "") : "",
    currentDraft: section.draft,
    instruction: opts.instruction ?? "",
  };
}
