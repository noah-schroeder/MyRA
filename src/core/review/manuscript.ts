/**
 * What a manuscript is, before a model sees it.
 *
 * Two questions this answers, both of which have to be answered BEFORE the
 * request goes out. Will it fit? -- because a manuscript is six to twelve
 * thousand words and a model loaded on an 8 GB card commonly holds eight
 * thousand tokens, so the ordinary case is the one that does not fit. And what
 * is it called? -- because "Nguyen-2026-final-FINAL-v3.pdf" is a filename, not
 * a title, and the review's header should say what the paper is.
 *
 * Refusing rather than truncating is the whole point. A silently truncated
 * manuscript produces a review that is confident, well-written, fluent about
 * the introduction, and completely silent on the results -- and nothing on
 * screen would say why. That review would go to an editor.
 */

import { estimateTokens } from "../agent/compact.ts";
import { buildSystem, buildUser, type ReviewRequest } from "./prompt.ts";

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/**
 * How much room one reviewer's report needs.
 *
 * The house rules ask each reviewer for 1,000-2,000 words, and the PRISMA
 * persona additionally produces a 27-row table, so the top of that range is
 * around 3,000 words -- call it 4,000 tokens with the table. Counting only the
 * input is how a request that "fits" gets cut off mid-recommendation, and the
 * one thing worse than a refusal is a review that stops halfway through the
 * major concerns and does not say so.
 */
export const REPLY_TOKENS = 4_000;

export interface Fit {
  fits: boolean;
  /** The whole request: prompt, study guidance, note and manuscript. */
  tokens: number;
  words: number;
  /** The model's window, when it is known. */
  limit?: number | undefined;
}

/**
 * Whether the panel can be sent to a model with this window.
 *
 * Measured against the LARGEST reviewer, not the sum: each persona is a
 * separate request carrying the same manuscript, so what has to fit is one of
 * them, and the biggest is the one that decides. Summing them would refuse
 * manuscripts that would have reviewed perfectly well three times over.
 *
 * An unknown limit is not a refusal. A hosted provider does not report its
 * context length, and refusing on "we could not measure it" would block the
 * models most able to do this -- so the check applies where the number is real,
 * which is the local daemon, where it comes from the loaded model's `ctx_size`.
 */
export function fitsContext(requests: ReviewRequest[], limit: number | undefined): Fit {
  const first = requests[0];
  const words = first ? wordCount(first.manuscript) : 0;
  const tokens = requests.reduce(
    (most, request) =>
      Math.max(
        most,
        estimateTokens([
          { role: "system", content: buildSystem(request) },
          { role: "user", content: buildUser(request) },
        ]),
      ),
    0,
  );
  if (!limit || limit <= 0) return { fits: true, tokens, words };
  return { fits: tokens + REPLY_TOKENS <= limit, tokens, words, limit };
}

/**
 * The refusal, with both numbers and something to do about it.
 *
 * "Too long" on its own is a dead end. Which two numbers, and which of the two
 * available fixes, is the difference between a message and an instruction.
 */
export function tooLongMessage(fit: Fit): string {
  return (
    `This manuscript is about ${fit.words.toLocaleString()} words. Each reviewer reads all of ` +
    `it, so one report needs roughly ${(fit.tokens + REPLY_TOKENS).toLocaleString()} tokens of ` +
    `context including room to write. The model you have loaded holds ` +
    `${(fit.limit ?? 0).toLocaleString()}. ` +
    `Load a model with a longer context from the Models page, raise this model's context length ` +
    `in its load settings if its architecture allows it, or choose a hosted model in the bar above.`
  );
}

/* ------------------------------------------------------------------ *
 * The title                                                           *
 * ------------------------------------------------------------------ */

/** Lines that are page furniture rather than the paper's title. */
const FURNITURE =
  /^(page\s*\d+|\d+|running\s+head|manuscript|draft|confidential|for\s+peer\s+review|submitted|under\s+review|anonymou?s)/i;

/**
 * The manuscript's title, guessed from its own first page.
 *
 * A guess, and shown in an editable box for that reason. Journals put a running
 * head, a submission date and "CONFIDENTIAL — FOR PEER REVIEW" above the title
 * often enough that taking line one would usually be wrong; a real title is a
 * few words long, is not a sentence of prose, and does not end in a full stop.
 */
export function titleOf(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  for (const line of lines.slice(0, 40)) {
    if (line.length < 12 || line.length > 250) continue;
    if (FURNITURE.test(line)) continue;
    // An email address or a DOI on its own is a byline, not a title.
    if (/@|https?:\/\/|^doi:/i.test(line)) continue;
    // Body prose, which starts below the title on a first page with an abstract.
    if (/\.\s*$/.test(line) && wordCount(line) > 12) continue;
    return line.replace(/\s+/g, " ");
  }
  return "";
}

/**
 * A filename made presentable, for when the text yields no title.
 *
 * Never shown as the title itself -- it goes in the same editable box, where it
 * is obviously a filename and obviously changeable.
 */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
