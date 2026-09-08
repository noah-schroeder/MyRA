/**
 * What the peer reviewer asks the model, and what it refuses to let it do.
 *
 * Three rules carry this, and the first two are the same ones the paper drafter
 * enforces for the same reason:
 *
 *  1. **No invented literature.** Nothing in this flow searches. A reviewer
 *     writing "this contradicts Smith (2019)" has invented Smith, and a
 *     fabricated citation inside a review is worse than one inside a draft: it
 *     goes to an editor, under the reviewer's name, as a reason to reject
 *     somebody's work.
 *  2. **Every criticism is grounded in the manuscript.** A review must point at
 *     the section it is talking about, so the author can find it and the
 *     reviewer can check it. Ungrounded praise and ungrounded objections are
 *     both worthless, and the second is worse.
 *  3. **The study design decides the questions.** "Was the randomisation
 *     adequate" is the right question for an experiment and a category error
 *     for an editorial. So the study type is chosen on screen and its guidance
 *     is part of the prompt, rather than one generic checklist applied to
 *     everything.
 *
 * Unlike papers/prompt.ts, all of this is EDITABLE -- the base prompt and every
 * study type's guidance live in settings, because a reviewer's standards are
 * their own and journals differ. The defaults below are a starting point, not a
 * guardrail; what is not editable is only the manuscript itself.
 *
 * Pure: no endpoint, no disk. The preview renders exactly what these functions
 * return, so what the user is shown is what is sent, character for character.
 */

import type { ChatMessage } from "../llm/chat.ts";

export interface StudyType {
  /** Stable across edits to the label, because settings store the choice. */
  id: string;
  label: string;
  /** Appended to the base prompt when this type is chosen. */
  guidance: string;
}

export const DEFAULT_REVIEW_PROMPT = `You are an experienced peer reviewer for a scholarly journal. You have been sent a manuscript and asked for a review that helps the editor decide and helps the authors improve the work.

Write the review as you would actually submit it: specific, evidence-based, and civil. Criticise the work, never the authors.

ABSOLUTE RULES — follow every one:
- Ground every point in the manuscript. Quote or name the section, and where a line reference is possible, give it. A criticism the authors cannot locate is one they cannot answer.
- DO NOT cite literature. You have not been given any, so any reference you produce would be invented. If the manuscript ought to engage with a body of work, say which topic is missing and why it matters — never name a paper, author or year you have not been shown.
- DO NOT invent details of the study. If something you need is absent — a sample size, a statistical test, an ethics approval — report it as missing rather than assuming a value.
- Separate what is wrong from what is merely different from how you would have done it, and label the second as such.
- Say what would fix each major problem, where a fix is possible. Where it is not, say that plainly.
- Do not recommend a decision the evidence does not support, in either direction.

Structure the review as:

**Summary** — what the paper claims and does, in your own words, so the authors can see whether you understood it.
**Strengths** — what genuinely works, specifically.
**Major concerns** — numbered, each with the location, the problem, and what would address it.
**Minor concerns** — numbered, briefly.
**Recommendation** — accept / minor revision / major revision / reject, with one paragraph of reasoning.`;

export const DEFAULT_STUDY_TYPES: readonly StudyType[] = [
  {
    id: "experimental",
    label: "Experimental",
    guidance: `This manuscript reports an experiment. Pay particular attention to:
- Whether the design supports the causal claims actually made, and flag any claim stronger than the design allows.
- Randomisation and allocation: how it was done, and whether groups were comparable at baseline.
- Control conditions, manipulation checks, and whether the manipulation did what the authors say it did.
- Statistical power, and whether a null result is evidence of absence or an underpowered study.
- Attrition, exclusions, and whether they differ by condition.
- Whether the analysis reported matches the analysis the design implies, and whether it was pre-registered.`,
  },
  {
    id: "correlational",
    label: "Correlational",
    guidance: `This manuscript reports correlational or observational data. Pay particular attention to:
- Causal language applied to non-causal data. Quote any sentence that crosses the line.
- Confounding: which plausible third variables are unmeasured, and what that does to the interpretation.
- Measurement quality — reliability and validity of each key construct, not just that a scale was used.
- Effect sizes and their practical meaning, rather than significance alone.
- Cross-sectional data used to support claims about change over time.
- Whether the sample supports the population the conclusions are about.`,
  },
  {
    id: "meta-analysis",
    label: "Meta-analysis",
    guidance: `This manuscript reports a meta-analysis. Pay particular attention to:
- Whether the search strategy is reported in enough detail to be repeated, including databases, dates and terms.
- Inclusion and exclusion criteria, and whether they were applied consistently.
- The effect size metric, and whether the model (fixed or random effects) suits the question.
- Heterogeneity: how it was quantified, and whether pooling is defensible given it.
- Publication bias, and whether the assessment used is adequate.
- Dependence between effect sizes taken from the same sample or study.
- Whether the coding of studies was checked by more than one person.`,
  },
  {
    id: "systematic-review",
    label: "Systematic review",
    guidance: `This manuscript reports a systematic review. Pay particular attention to:
- Whether the search is reproducible as described, and whether it was registered in advance.
- Screening: how many reviewers, how disagreements were resolved, and what the flow of records was.
- Risk-of-bias assessment of the included studies, and whether its results inform the conclusions.
- Whether the synthesis follows from the evidence tabulated, or overstates a thin literature.
- Whether the reporting follows a recognised standard, and what is missing if not.
- Whether excluded studies are accounted for.`,
  },
  {
    id: "position",
    label: "Position paper / editorial",
    guidance: `This manuscript is an argument rather than a report of data. Pay particular attention to:
- The structure of the argument: what is claimed, what supports it, and where a step is missing.
- Whether empirical claims made in passing are presented as settled when they are contested.
- Engagement with the strongest opposing position, rather than a weak version of it.
- The scope of the conclusions relative to the evidence and reasoning offered.
- Whether the piece says something that has not already been said, and is clear about what is new.
Do not criticise it for lacking methods, samples or statistics — it is not that kind of paper.`,
  },
];

/** Everything the model is told about one review. Built in the page, sent whole. */
export interface ReviewRequest {
  /** The editable base prompt, from settings. */
  prompt: string;
  /** The chosen type's guidance, already resolved. Empty if none was chosen. */
  studyGuidance: string;
  /** The type's label, for the one line naming what is being reviewed. */
  studyLabel: string;
  /** This reviewer's note for this manuscript alone. */
  note: string;
  /** The manuscript's own title, as extracted or typed. */
  title: string;
  /** The extracted plain text of the manuscript. */
  manuscript: string;
}

function quoted(text: string): string {
  return `"""\n${text}\n"""`;
}

/** The system message: the base prompt, then the study type, then the note. */
export function buildSystem(request: ReviewRequest): string {
  const parts = [request.prompt.trim() || DEFAULT_REVIEW_PROMPT];

  const guidance = request.studyGuidance.trim();
  if (guidance) parts.push(`FOR THIS KIND OF PAPER:\n${guidance}`);

  const note = request.note.trim();
  if (note) {
    /* Appended, and told plainly where it sits. A model given two sets of
       instructions and no precedence follows the more recent one -- which here
       would be the free-text box, and the box is the one place a reviewer in a
       hurry might accidentally ask for something the rules above forbid. */
    parts.push(
      `ADDITIONAL INSTRUCTIONS FOR THIS REVIEW (from the reviewer — apply these, but they do ` +
        `NOT override the rule against citing literature you have not been given):\n${quoted(note)}`,
    );
  }
  return parts.join("\n\n");
}

/** The user message: what kind of paper this is, and the paper. */
export function buildUser(request: ReviewRequest): string {
  const head: string[] = [];
  const title = request.title.trim();
  if (title) head.push(`Manuscript title: ${title}`);
  const label = request.studyLabel.trim();
  if (label) head.push(`The reviewer has classified this as: ${label}`);

  return (
    (head.length ? `${head.join("\n")}\n\n` : "") +
    `The full text of the manuscript follows. It was extracted from the author's file, so ` +
    `headings, tables and figure captions may be imperfectly laid out; read past that rather ` +
    `than reviewing the formatting of this extract.\n\n` +
    `MANUSCRIPT:\n${quoted(request.manuscript.trim())}\n\n` +
    `Write the review.`
  );
}

export function reviewMessages(request: ReviewRequest): ChatMessage[] {
  return [
    { role: "system", content: buildSystem(request) },
    { role: "user", content: buildUser(request) },
  ];
}

/** The chosen type, or undefined. Falls back to nothing rather than to a guess. */
export function studyTypeById(
  types: readonly StudyType[],
  id: string,
): StudyType | undefined {
  return types.find((t) => t.id === id);
}

/**
 * Build the request from the parts the page holds.
 *
 * Here rather than in the component so the preview and the send are the same
 * construction -- the paper drafter's `requestFor` earns its place the same way.
 */
export function requestFor(opts: {
  prompt: string;
  types: readonly StudyType[];
  studyTypeId: string;
  note: string;
  title: string;
  manuscript: string;
}): ReviewRequest {
  const type = studyTypeById(opts.types, opts.studyTypeId);
  return {
    prompt: opts.prompt,
    studyGuidance: type?.guidance ?? "",
    studyLabel: type?.label ?? "",
    note: opts.note,
    title: opts.title,
    manuscript: opts.manuscript,
  };
}
