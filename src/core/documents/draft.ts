/**
 * The draft flow: outline, approve, then write one section at a time.
 *
 * The orchestration is code, not the model's discretion. That is the whole
 * design. A tool that merely *invites* a model to plan first is a suggestion a
 * 2.6B is free to decline, and it declines by writing the whole document in one
 * call -- which is the failure this exists to prevent. Here the stages happen
 * because the function calls them in order; the model only fills them in.
 *
 * Three properties fall out of the split, none of which is extra work:
 *
 *   - Each section is a small, focused request, which is where the quality win
 *     comes from on a local model.
 *   - The context stays bounded no matter how long the document gets: a section
 *     sees the outline and the tail of what came before, never the whole draft.
 *   - The file is saved after every section, so a run that dies at section
 *     eight leaves seven sections on disk rather than nothing.
 */

import { parseJsonReply, runSubagent } from "../llm/chat.ts";
import {
  MAX_SECTION_WORDS, parseOutline, renderOutline, totalWords,
  type DraftSection, type Outline,
} from "./outline.ts";
import { slugName } from "./formats.ts";

/** Just the dialog surface this needs, so it can run headless in tests. */
export interface DraftUi {
  editor(title: string, prefill?: string): Promise<string | undefined>;
}

export interface DraftOptions {
  /** What the user asked for, in their words. */
  request: string;
  /** Model id, or "" to use whatever the endpoint resolver returns. */
  model: string;
  /** Target format for the finished file. The outline carries it, so the user
      can change it in the dialog; this is only the starting value. */
  format?: string;
  ui: DraftUi;
  /**
   * Persist the draft as it stands.
   *
   * Injected rather than imported so this module holds no opinion about where
   * documents live or how they are converted -- the jail and the format
   * conversion belong to the tool that calls this, which is the only place they
   * can be enforced consistently.
   */
  save: (markdown: string, opts: { final: boolean; outline: Outline }) => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

export interface DraftResult {
  path: string;
  outline: Outline;
  markdown: string;
  words: number;
  /**
   * Citation-shaped text the model produced anyway, by section heading.
   *
   * Reported rather than repaired. The document is already on disk by the time
   * this is known -- it is written a section at a time on purpose -- and
   * silently stripping a marker would leave the sentence it supported reading
   * as though it were the writer's own established fact, which is the more
   * dangerous of the two states. Empty on a clean draft.
   */
  invented: { heading: string; found: string[] }[];
}

export class DraftCancelled extends Error {
  override readonly name = "DraftCancelled";
}

/** Words of the previous section carried into the next, for continuity. */
const TAIL_WORDS = 60;

function tail(text: string, words = TAIL_WORDS): string {
  const parts = text.trim().split(/\s+/);
  return parts.length <= words ? text.trim() : `…${parts.slice(-words).join(" ")}`;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/* ------------------------------------------------------------------ *
 * Stage 1: propose an outline                                         *
 * ------------------------------------------------------------------ */

export function buildOutlinePrompt(request: string): string {
  return [
    `The user asked for this document:`,
    request,
    ``,
    `Plan it. You are writing a table of contents, not the document.`,
    ``,
    `  - Break it into sections that each make one point. A section is a unit of`,
    `    writing, not a chapter: between 150 and ${MAX_SECTION_WORDS} words.`,
    /*
     * Laboured, because the model labours over it. Watching the planner stream,
     * a 2.6B spent most of its reasoning on exactly this question -- "the brief
     * is just a summary, but the actual content must be present somewhere...
     * I think we need to embed the full report text within the sections" --
     * and a brief holding the whole section defeats the split that follows.
     */
    `  - A brief is ONE sentence naming what belongs in the section. It is an`,
    `    instruction to whoever writes that section, not the section itself.`,
    `    Do not write any of the document here: each section is written`,
    `    afterwards, on its own, from its brief.`,
    `  - Between them the sections must cover everything that was asked for,`,
    `    once each. Overlapping briefs produce a document that repeats itself.`,
    `  - Say who the document is for, if the request implies it.`,
    ``,
    `Reply with JSON only, in exactly this shape:`,
    `{"title": "...", "audience": "...", "sections": [`,
    `  {"heading": "...", "brief": "...", "words": 300}`,
    `]}`,
  ].join("\n");
}

interface RawOutline {
  title?: unknown;
  audience?: unknown;
  sections?: unknown;
}

/**
 * Turn the model's JSON into an Outline, filling in what it left out.
 *
 * Lenient, unlike parseOutline. This runs before the user has seen anything, so
 * a missing field should become a default they can correct in the dialog --
 * failing the whole flow because a model omitted "audience" would replace a
 * fixable outline with an error message.
 */
export interface Proposal {
  outline: Outline;
  /**
   * True when the model gave nothing usable and this is a placeholder.
   *
   * Surfaced rather than swallowed. The fallback is the right behaviour -- a
   * one-section outline can be edited into shape and an exception cannot -- but
   * shown without comment it is indistinguishable from a model that considered
   * the request and decided one section was enough. The user would approve it,
   * and get what they were shown.
   */
  fellBack: boolean;
}

export function outlineFromReply(reply: RawOutline, request: string, format = "md"): Proposal {
  const rawSections = Array.isArray(reply.sections) ? reply.sections : [];
  const sections: DraftSection[] = rawSections
    .map((s): DraftSection | undefined => {
      if (!s || typeof s !== "object") return undefined;
      const row = s as Record<string, unknown>;
      const heading = String(row["heading"] ?? "").trim();
      if (!heading) return undefined;
      const words = Number(row["words"]);
      return {
        heading,
        brief: String(row["brief"] ?? "").trim(),
        words: Number.isFinite(words) && words >= 1
          ? Math.min(Math.floor(words), MAX_SECTION_WORDS)
          : 300,
      };
    })
    .filter((s): s is DraftSection => s !== undefined);

  const title = String(reply.title ?? "").trim() || request.slice(0, 80).trim() || "Draft";
  return {
    fellBack: sections.length === 0,
    outline: {
      title,
      audience: String(reply.audience ?? "").trim(),
      filename: slugName(title, format),
      format,
      // A model that returned no usable sections still gets an outline, because
      // an outline with one section is something the user can edit into shape
      // and an error is not.
      sections: sections.length ? sections : [{ heading: title, brief: request, words: 400 }],
    },
  };
}

export async function proposeOutline(opts: {
  request: string;
  model: string;
  format?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string, kind: "text" | "thinking") => void;
}): Promise<Proposal> {
  const result = await runSubagent({
    model: opts.model,
    prompt: buildOutlinePrompt(opts.request),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
  });
  const raw = parseJsonReply<RawOutline>(result.text, "outline");
  return outlineFromReply(raw ?? {}, opts.request, opts.format ?? "md");
}

/** Said in the dialog when the plan on screen is not the model's. */
export const FELL_BACK_NOTICE =
  "The model did not return a usable plan, so this is a placeholder built from your " +
  "request — not its proposal. Write the sections you want before saving.";

/* ------------------------------------------------------------------ *
 * Stage 3: write one section                                          *
 * ------------------------------------------------------------------ */

/**
 * The prompt for a single section.
 *
 * The full heading list goes in every time, which looks wasteful and is not: it
 * is what stops a section from re-introducing the topic, restating the previous
 * one, or concluding in the middle. It is also bounded -- headings, not bodies
 * -- so a twenty-section document costs the same per section as a three-section
 * one. The tail of the previous section handles the join at the seam, which
 * headings alone cannot.
 */
export function buildSectionPrompt(
  outline: Outline,
  index: number,
  previousTail: string,
): string {
  const section = outline.sections[index]!;
  const map = outline.sections
    .map((s, i) => `  ${i + 1}. ${s.heading}${i === index ? "   <- write this one" : ""}`)
    .join("\n");

  return [
    `DOCUMENT: ${outline.title}`,
    ...(outline.audience ? [`WRITTEN FOR: ${outline.audience}`] : []),
    ``,
    `ALL SECTIONS`,
    map,
    ``,
    ...(previousTail
      ? [`THE PREVIOUS SECTION ENDED`, previousTail, ``]
      : [`This is the first section.`, ``]),
    `WRITE SECTION ${index + 1}: ${section.heading}`,
    ...(section.brief ? [section.brief] : []),
    ``,
    `  - About ${section.words} words.`,
    `  - Prose. Do not repeat the heading as a title; it is added for you.`,
    `  - Cover only this section. The others are being written separately, so`,
    `    do not introduce them, summarise them, or conclude the document unless`,
    `    this is the last section.`,
    `  - No preamble about what you are about to write. Start with the content.`,
    /*
     * Said here because it reaches nowhere else.
     *
     * Karen's system prompt forbids unsourced markers, but runSubagent sends
     * only the system string it is given and this stage gives none -- so the
     * section writer inherits no citation discipline whatever. Measured, on the
     * first real draft: asked for an academic tone, a 2.6B produced
     * "Melby-Lervaag and colleagues (2016)" and "Jaeggi et al. (2010)" with
     * page-accurate confidence and nothing behind either. Nothing in this flow
     * searches, so every citation it writes is invented by construction.
     */
    `  - You have no sources. Nothing here searched the literature, so do not`,
    `    cite: no author-year references, no [1] markers, no invented studies,`,
    `    no made-up statistics. Where a claim would need a source, write the`,
    `    claim and say plainly that it needs one.`,
    ``,
    `Reply with the section text and nothing else.`,
  ].join("\n");
}

/**
 * Strip what a model adds around a section it was asked to write bare.
 *
 * The heading is the common one: told not to repeat it, a model repeats it
 * roughly half the time, and the assembled document then carries every heading
 * twice. Matched against the actual heading rather than "any leading #" so a
 * section that legitimately opens with a sub-heading keeps it.
 */
export function cleanSection(text: string, heading: string): string {
  let out = text.trim();
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(new RegExp(`^#{1,6}\\s*${escaped}\\s*\\n+`, "i"), "");
  out = out.replace(new RegExp(`^${escaped}\\s*\\n+`, "i"), "");
  return out.trim();
}

/**
 * Citation-shaped text, which in this flow is always fabricated.
 *
 * Checked, not merely forbidden. The prompt tells the section writer it has no
 * sources; that is an instruction a small model may ignore, and instructing
 * where you can enforce is the mistake the research pipeline already learned
 * not to make -- synthesize.ts refuses outright to return a draft citing a
 * source that does not exist. The same reasoning applies here and is simpler,
 * because there is no source list to check against: nothing in this flow
 * searches, so EVERY citation is dangling.
 *
 * Deliberately conservative. A bare year in parentheses is a date, not a
 * citation, and flagging "the trials ran until (2019)" would train the user to
 * ignore the warning. These four shapes are what a model actually produces when
 * it invents an authority -- including the two it produced on the first real
 * run of this flow.
 */
const CITATION_SHAPES: RegExp[] = [
  /\[\d+(?:\s*[,;–-]\s*\d+)*\]/g,
  /\b[A-Z][A-Za-z'’\u00C0-\u024F-]+\s+(?:et al\.|and colleagues)\s*\(?\s*\d{4}[a-z]?\s*\)?/g,
  /\([A-Z][A-Za-z'’\u00C0-\u024F-]+(?:\s+(?:et al\.|&\s+[A-Z][A-Za-z'’\u00C0-\u024F-]+))?,?\s+\d{4}[a-z]?\)/g,
  /\bdoi:\s*10\.\S+/gi,
];

export function citationsIn(text: string): string[] {
  const found = new Set<string>();
  for (const shape of CITATION_SHAPES) {
    for (const m of text.matchAll(shape)) found.add(m[0].trim());
  }
  return [...found];
}

export function assemble(outline: Outline, bodies: string[]): string {
  return [
    `# ${outline.title}`,
    ``,
    ...outline.sections.flatMap((s, i) => {
      const body = bodies[i];
      return [
        `## ${s.heading}`,
        ``,
        // A section not yet written is marked, not omitted: a partial save that
        // silently skipped it would read as a finished document with a gap.
        body === undefined ? `*(not yet written)*` : body,
        ``,
      ];
    }),
  ].join("\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------------ *
 * The flow                                                            *
 * ------------------------------------------------------------------ */

export async function runDraft(opts: DraftOptions): Promise<DraftResult> {
  const say = (note: string): void => opts.onProgress?.(note);
  const stop = (): void => {
    if (opts.signal?.aborted) throw new DraftCancelled("draft cancelled");
  };

  /*
   * Show the tail of what the model is producing, throttled.
   *
   * Not decoration. Without an onDelta the request is not streamed at all, so
   * the whole stage is one silent wait -- measured at over three minutes on a
   * 2.6B before the outline dialog appeared, with nothing on screen but
   * "planning the document…" and no way to tell a slow model from a hung one.
   * Streaming also makes the idle timeout mean what it says: silence, rather
   * than total duration.
   *
   * The same helper as the research pipeline's, for the same reason and with
   * the same 500ms floor.
   */
  const stream = (label: string) => {
    let buffer = "";
    let last = 0;
    return (delta: string, kind: "text" | "thinking"): void => {
      buffer += delta;
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      say(`${label}${kind === "thinking" ? " (thinking)" : ""}: …${buffer.replace(/\s+/g, " ").trim().slice(-220)}`);
    };
  };

  stop();
  say("planning the document…");
  const { outline: proposed, fellBack } = await proposeOutline({
    request: opts.request,
    model: opts.model,
    onDelta: stream("planning"),
    ...(opts.format ? { format: opts.format } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (fellBack) say("the model returned no usable plan — showing a placeholder to edit");

  stop();
  const edited = await opts.ui.editor(
    "Draft plan — edit anything, then save",
    renderOutline(proposed, fellBack ? FELL_BACK_NOTICE : undefined),
  );
  // Undefined is the dialog's "no". Nothing has been written at this point,
  // which is the entire reason the dialog comes before the writing.
  if (edited === undefined) throw new DraftCancelled("outline not approved");

  /* Allowed to throw. An OutlineError says exactly what is wrong with the text
     the user just edited -- "words must be a positive number", the section it
     is in -- and that reaches them through the tool's error, which is more
     use than anything this function could do with it. */
  const outline = parseOutline(edited, proposed);

  const bodies: string[] = [];
  const invented: { heading: string; found: string[] }[] = [];
  for (const [i, section] of outline.sections.entries()) {
    stop();
    say(`writing ${i + 1} of ${outline.sections.length}: ${section.heading}…`);

    const result = await runSubagent({
      model: opts.model,
      prompt: buildSectionPrompt(outline, i, bodies.length ? tail(bodies[bodies.length - 1]!) : ""),
      onDelta: stream(`${section.heading}`),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const body = cleanSection(result.text, section.heading);
    bodies.push(body);

    /* Said the moment it happens, not only in the summary. A citation invented
       in section two is easiest to deal with while the user is still watching
       the thing run. */
    const cited = citationsIn(body);
    if (cited.length) {
      invented.push({ heading: section.heading, found: cited });
      say(`${section.heading}: invented ${cited.length} citation(s) — ${cited.slice(0, 3).join(", ")}`);
    }

    /* Saved every time, not only at the end. A local model writing twelve
       sections is several minutes of work, and the failure modes -- an
       overflowing context, a crash, the user closing the app -- all leave
       everything written so far on disk this way. The final save is separate
       because it is the one that converts to the requested format. */
    await opts.save(assemble(outline, bodies), { final: false, outline });
  }

  stop();
  const markdown = assemble(outline, bodies);
  const path = await opts.save(markdown, { final: true, outline });
  const words = countWords(markdown);
  say(
    `wrote ${outline.sections.length} sections, ${words.toLocaleString()} words` +
      (invented.length ? ` — ${invented.length} section(s) contain invented citations` : ""),
  );

  return { path, outline, markdown, words, invented };
}

export { totalWords };
