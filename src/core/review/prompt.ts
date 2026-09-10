/**
 * What the peer reviewer asks the model, and how the request is divided up.
 *
 * The shape comes from the reviewer's own two prompts -- one for experimental
 * work, one for systematic reviews -- and the first thing to notice about them
 * is that they are about eighty per cent the same text. Both ask for three
 * reviews from three personas of 1,000-2,000 words each; both impose the same
 * review structure, the same evaluation criteria, the same six-part format, the
 * same tone rules and the same five scores out of five. What differs is WHO the
 * three reviewers are, and in particular what the methodologist looks for: a
 * statistician on an experiment, a PRISMA 2020 checklist on a systematic
 * review.
 *
 * So the shared eighty per cent is one editable block, and each study design
 * carries its own panel of reviewers. That is the factoring, and it is why
 * adding a design later means writing three personas rather than another
 * thousand-word prompt with the house rules copied into it and free to drift.
 *
 * **One request per reviewer, not one for the panel.** Three reviews of up to
 * 2,000 words each is six thousand words of output, which on a local model is
 * where quality collapses and where the context ceiling is met from the wrong
 * side. Asking each persona separately keeps every request small -- the reason
 * documents/draft.ts writes a section at a time -- and it is also the more
 * faithful arrangement: three reviewers who have not read each other is what a
 * journal actually sends an editor. The manuscript itself is never divided;
 * each reviewer reads all of it.
 *
 * All of this is EDITABLE, unlike papers/prompt.ts. A reviewer's standards are
 * their own and journals differ; what the defaults carry is a rule about not
 * inventing literature, stated in the text where it can be read rather than
 * hidden where it cannot be removed.
 *
 * Pure: no endpoint, no disk. The preview renders exactly what these functions
 * return, so what the user is shown is what is sent, character for character.
 */

import type { ChatMessage } from "../llm/chat.ts";

/** One persona on the panel. */
export interface Reviewer {
  id: string;
  /** Shown as the heading over this reviewer's report. */
  label: string;
  instructions: string;
}

export interface StudyType {
  /** Stable across edits to the label, because settings store the choice. */
  id: string;
  label: string;
  reviewers: Reviewer[];
}

/* ------------------------------------------------------------------ *
 * The house rules: everything both of the reviewer's prompts share    *
 * ------------------------------------------------------------------ */

export const DEFAULT_REVIEW_PROMPT = `Your task is to provide a thorough, constructive, and objective review of an academic manuscript, in the voice of the reviewer described below. Write it as you would actually submit it to the journal.

Your report should be 1,000-2,000 words.

REVIEW PROCESS
- Read the manuscript completely before making judgments.
- Evaluate the work against the criteria below.
- Provide a detailed, structured review with clear sections.
- End with a clear recommendation.

EVALUATION CRITERIA
- Research question / hypothesis: clarity and significance of the question; relevance to the field; theoretical foundation.
- Methodology: appropriateness of the methods; quality of the research design; data collection and analysis procedures; statistical rigour where applicable.
- Results and discussion: clear presentation of findings; proper interpretation of results; limitations addressed; connection to existing literature.
- Writing and organisation: logical flow and structure; clarity of expression; academic writing standards; proper citations and references.

REVIEW FORMAT — use these headings, in this order:
Summary — 2-3 sentences capturing the main points.
Major Strengths — 3-4 points.
Major Concerns — a prioritised list.
Minor Issues — including technical corrections.
Specific Recommendations for Improvement.
Overall Verdict.
Scores — rate each of Originality, Technical Quality, Methodology, Presentation and Scientific Impact from 1 to 5, where 1 = Poor, 2 = Below Average, 3 = Average, 4 = Good, 5 = Excellent. Give one line of justification for each score.

TONE
- Maintain professional and constructive language.
- Be specific, and give examples from the manuscript.
- Acknowledge positive aspects.
- Frame criticism constructively.
- Avoid dismissive or harsh language. Criticise the work, never the authors.

TWO RULES ABOUT EVIDENCE
- Ground every point in the manuscript. Quote or name the section you are discussing, so the authors can find it. A criticism they cannot locate is one they cannot answer.
- Do not cite outside literature. You have been given the manuscript and nothing else, so any reference you introduce would be invented, and a fabricated citation in a review goes to an editor under the reviewer's name as a reason to reject somebody's work. You may and should comment on the manuscript's OWN references and on whether a relevant body of work appears to be missing — name the topic, never a paper, author or year you have not been shown.`;

/* ------------------------------------------------------------------ *
 * The personas                                                        *
 * ------------------------------------------------------------------ */

const THEORY: Reviewer = {
  id: "theory",
  label: "Reviewer 1 — Theory and contribution",
  instructions: `You are an expert in the theoretical framing of the study and in the manuscript's contribution to theory.

Search for weaknesses in the explanation, logic and coherence of the theory. Ask whether the constructs are defined well enough to be argued about, whether the stated contribution is the one the study can actually support, and whether the argument holds from the opening paragraph through to the claims in the discussion.

Provide extensive comments on how to strengthen the introduction, literature review and discussion sections so that the logic and coherence improve. Be concrete: say which paragraph does not follow from the one before it, which claim outruns its support, and what would fix each.`,
};

const LANGUAGE: Reviewer = {
  id: "language",
  label: "Reviewer 3 — Concepts, flow and language",
  instructions: `You provide extensive constructive feedback on core conceptual, flow and language problems throughout the manuscript.

Work through the manuscript in order. Identify where a concept is introduced inconsistently or used in two senses; where the thread between paragraphs or sections breaks; where a sentence is longer or more abstract than the idea in it requires; and where the academic register slips.

Quote the passages you are discussing and offer a specific rewrite or a specific instruction for each, rather than a general observation about the writing. Cover the whole manuscript rather than the first few pages.`,
};

const PRISMA_CHECKLIST = `Evaluate the methods against the PRISMA 2020 expanded checklist.

Produce a comprehensive evaluation table with these columns: PRISMA item number | Section/Topic | What the item requires | Assessment (Present / Partially present / Absent) | Justification and comments.

Assess all 27 items:
1. Title — identification as a systematic review.
2. Abstract — a structured summary following PRISMA for Abstracts. Check all twelve elements: (1) identifies the report as a systematic review; (2) an explicit statement of the main objective(s) or question(s); (3) the inclusion and exclusion criteria; (4) the information sources and the date each was last searched; (5) the methods used to assess risk of bias; (6) the methods used to present and synthesise results; (7) the total number of included studies and participants, with relevant study characteristics; (8) results for the main outcomes, ideally with the number of studies and participants for each, and where a meta-analysis was done the summary estimate and confidence or credible interval, with the direction of effect where groups are compared; (9) a brief summary of the limitations of the evidence, such as risk of bias, inconsistency and imprecision; (10) a general interpretation of the results and their implications; (11) the primary source of funding; (12) the register name and registration number.
3. Rationale — the rationale in the context of existing knowledge.
4. Objectives — an explicit statement of the objective(s) or question(s) the review addresses.
5. Eligibility criteria — the inclusion and exclusion criteria, and how studies were grouped for the syntheses.
6. Information sources — all databases, registers, websites, organisations and reference lists searched or consulted, and the date each was last searched.
7. Search strategy — the full search strategies for all databases, registers and websites, including any filters and limits.
8. Selection process — how it was decided that a study met the criteria, how many reviewers screened each record and each report, whether they worked independently, and any automation tools used.
9. Data collection process — how data were collected from reports, how many reviewers collected from each, whether they worked independently, any process for obtaining or confirming data from investigators, and any automation tools used.
10a. Data items: outcomes — all outcomes for which data were sought, whether all compatible results in each study were sought, and if not how it was decided which to collect.
10b. Data items: other variables — all other variables sought, and any assumptions made about missing or unclear information.
11. Study risk of bias assessment — the methods used, the tool(s), how many reviewers assessed each study, whether independently, and any automation tools.
12. Effect measures — the effect measure(s) used for each outcome in the synthesis or presentation.
13a. Synthesis: eligibility — how it was decided which studies were eligible for each synthesis.
13b. Synthesis: preparation — any methods used to prepare the data, such as handling missing summary statistics or data conversions.
13c. Synthesis: tabulation and graphics — any methods used to tabulate or visually display the results of individual studies and syntheses.
13d. Synthesis: statistical methods — the methods used to synthesise results and the rationale for them; where a meta-analysis was performed, the model(s), the method(s) for identifying the presence and extent of statistical heterogeneity, and the software used.
13e. Synthesis: heterogeneity — any methods used to explore possible causes of heterogeneity, such as subgroup analysis or meta-regression.
13f. Synthesis: sensitivity analyses — any sensitivity analyses conducted to assess robustness.
14. Reporting bias assessment — any methods used to assess risk of bias due to missing results arising from reporting biases.
15. Certainty assessment — any methods used to assess certainty or confidence in the body of evidence for an outcome.
16a. Study selection: flow — the results of the search and selection process, from records identified to studies included, ideally as a flow diagram.
16b. Study selection: exclusions — studies that might appear to meet the criteria but were excluded, and why.
17. Study characteristics — each included study cited, with its characteristics.
18. Risk of bias in studies — the results of the risk of bias assessment.
19. Results of individual studies — for all outcomes, summary statistics for each group where appropriate, and an effect estimate with its precision, ideally in structured tables or plots.
20a. Results of syntheses — for each synthesis, the characteristics and risk of bias among contributing studies.
20b. Results of syntheses — the results of all statistical syntheses; where a meta-analysis was done, the summary estimate, its precision and measures of statistical heterogeneity, with the direction of effect where groups are compared.
20c. Results of syntheses — the results of all investigations of possible causes of heterogeneity.
20d. Results of syntheses — the results of all sensitivity analyses.
21. Reporting biases — assessments of risk of bias due to missing results, for each synthesis assessed.
22. Certainty of evidence — assessments of certainty or confidence in the body of evidence, for each outcome assessed.
23a. Discussion — a general interpretation of the results in the context of other evidence.
23b. Discussion — limitations of the evidence included in the review.
23c. Discussion — limitations of the review processes used.
23d. Discussion — implications for practice, policy and future research.
24a. Registration — the register name and registration number, or a statement that the review was not registered.
24b. Registration — where the protocol can be accessed, or a statement that no protocol was prepared.
24c. Registration — any amendments to the registration or protocol, described and explained.
25. Support — the sources of financial and non-financial support, and the role of the funders.
26. Competing interests — declared competing interests.
27. Availability of data, code and other materials — which materials are publicly available and where.

After the table, write a prose assessment of the items you marked Absent or Partially present, in priority order: which omissions threaten the validity of the review's conclusions rather than merely its reporting, and what the authors should add.`;

const META_ANALYSIS_EXTRA = `Then, because this manuscript reports a meta-analysis, provide a detailed evaluation of:
- The effect measure selected, and whether the choice is justified and appropriate to the outcomes.
- The meta-analytic model — fixed or random effects — and whether the rationale given matches the assumption the data require.
- Heterogeneity assessment: I-squared, tau-squared, and whether prediction intervals are reported. Say whether pooling is defensible given what is reported.
- Subgroup analyses and meta-regression: whether they were pre-specified, whether there are enough studies per subgroup to support them, and whether they are interpreted as exploratory.
- Sensitivity analyses testing the robustness of the findings.
- Publication bias: the methods used, such as funnel plots and statistical tests, and whether the number of studies makes them informative.
- Handling of dependencies in the data, such as multiple effect sizes drawn from the same sample.`;

export const DEFAULT_STUDY_TYPES: readonly StudyType[] = [
  {
    id: "experimental",
    label: "Experimental",
    reviewers: [
      THEORY,
      {
        id: "methods",
        label: "Reviewer 2 — Methods and statistics",
        instructions: `You are an expert in the methodological approach used in this study.

First identify the key approach — quantitative, qualitative, mixed-methods, systematic review, or meta-analysis — and say so explicitly, because the rest of your review depends on it.

Then search for and identify methodological flaws and shortcomings, with particular attention to statistical rigour and reporting. Cover, where they apply:
- Whether the design supports the causal claims actually made. Quote any claim stronger than the design allows.
- Randomisation and allocation: how it was done, and whether the groups were comparable at baseline.
- Control conditions, manipulation checks, and whether the manipulation did what the authors say it did.
- Statistical power, and whether a null result is evidence of absence or an underpowered study.
- Attrition, exclusions, and whether they differ by condition.
- Whether the analyses reported are the analyses the design implies, whether they were pre-registered, and whether any appear to have been chosen after seeing the data.
- Reporting completeness: exact test statistics, degrees of freedom, effect sizes and their intervals, and assumptions checked.

Provide extensive comments on how to improve the methodological rigour, including analyses the authors could run on data they already have.`,
      },
      LANGUAGE,
    ],
  },
  {
    id: "correlational",
    label: "Correlational",
    reviewers: [
      THEORY,
      {
        id: "methods",
        label: "Reviewer 2 — Methods and statistics",
        instructions: `You are an expert in the methodological approach used in this study, which reports correlational or observational data.

Search for and identify methodological flaws and shortcomings, with particular attention to statistical rigour, reporting, and the gap between what the design can show and what is claimed. Cover, where they apply:
- Causal language applied to non-causal data. Quote every sentence that crosses the line, and propose the wording that would be defensible.
- Confounding: which plausible third variables are unmeasured, and what each does to the interpretation.
- Measurement quality: the reliability and validity of every key construct, not merely that a published scale was used.
- Effect sizes, their intervals, and their practical meaning, rather than significance alone.
- Cross-sectional data used to support claims about change over time.
- Sampling: whether the sample supports claims about the population the conclusions are about, and how it was recruited.
- Missing data, exclusions, and how they were handled.
- Whether the analyses were pre-registered, and whether the number of tests reported warrants correction.

Provide extensive comments on how to improve the methodological rigour, including analyses the authors could run on data they already have.`,
      },
      LANGUAGE,
    ],
  },
  {
    id: "systematic-review",
    label: "Systematic review",
    reviewers: [
      THEORY,
      {
        id: "methods",
        label: "Reviewer 2 — Methods, against PRISMA 2020",
        instructions: PRISMA_CHECKLIST,
      },
      LANGUAGE,
    ],
  },
  {
    id: "meta-analysis",
    label: "Meta-analysis",
    reviewers: [
      THEORY,
      {
        id: "methods",
        label: "Reviewer 2 — Methods, against PRISMA 2020",
        instructions: `${PRISMA_CHECKLIST}\n\n${META_ANALYSIS_EXTRA}`,
      },
      LANGUAGE,
    ],
  },
  {
    id: "position",
    label: "Position paper / editorial",
    reviewers: [
      {
        id: "theory",
        label: "Reviewer 1 — Argument and contribution",
        instructions: `You are an expert in the theoretical territory this piece argues within.

This is an argument rather than a report of data, so review the argument. Set out what is claimed, what is offered in support, and where a step is missing or assumed. Ask whether the position is stated precisely enough to be disagreed with, whether the scope of the conclusions matches the reasoning offered, and whether the piece says something that has not already been said and is clear about what is new.

Provide extensive comments on how to strengthen the framing, the development of the argument and the conclusion so that the logic and coherence improve. Be concrete about which paragraph does not follow from the one before it.

Do not criticise the manuscript for lacking methods, samples or statistics. It is not that kind of paper.`,
      },
      {
        id: "methods",
        label: "Reviewer 2 — Evidence and scholarship",
        instructions: `You examine the evidentiary basis of the argument rather than a research design, because this manuscript reports no study of its own.

Cover:
- Empirical claims made in passing and presented as settled when they are contested, or stated without the qualification the underlying evidence would require. Quote each one.
- Whether the strongest opposing position is engaged with, or only a weak version of it.
- Whether the literature the piece leans on is characterised accurately as described in the manuscript itself, and whether the weight placed on any single source exceeds what one source can carry.
- Whether the piece distinguishes what is known from what is argued, and from what is recommended.
- Where a claim would need evidence that is not offered, say what kind of evidence would settle it.

Do not criticise the manuscript for lacking randomisation, a sample or statistics.`,
      },
      LANGUAGE,
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Building one reviewer's request                                     *
 * ------------------------------------------------------------------ */

/** Everything the model is told for ONE reviewer. Built in the page, sent whole. */
export interface ReviewRequest {
  /** The editable house rules, from settings. */
  prompt: string;
  /** This persona's instructions. */
  reviewerInstructions: string;
  /**
   * Which persona this is, stable across edits to their label.
   *
   * Not sent to the model -- it is how the stored record keeps a report attached
   * to the reviewer that wrote it when the panel is later renamed in settings.
   */
  reviewerId: string;
  /** The heading this report is filed under. */
  reviewerLabel: string;
  /** The design chosen on screen, so the reviewer knows what it is reading. */
  studyLabel: string;
  /** The reviewer's note for this manuscript alone. */
  note: string;
  title: string;
  manuscript: string;
}

function quoted(text: string): string {
  return `"""\n${text}\n"""`;
}

/** The system message: house rules, then this persona, then the note. */
export function buildSystem(request: ReviewRequest): string {
  const parts = [request.prompt.trim() || DEFAULT_REVIEW_PROMPT];

  const persona = request.reviewerInstructions.trim();
  if (persona) parts.push(`YOU ARE THIS REVIEWER:\n${persona}`);

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

/** The user message: what this is, and the manuscript. */
export function buildUser(request: ReviewRequest): string {
  const head: string[] = [];
  const title = request.title.trim();
  if (title) head.push(`Manuscript title: ${title}`);
  const label = request.studyLabel.trim();
  if (label) head.push(`The handling reviewer has classified this as: ${label}`);

  return (
    (head.length ? `${head.join("\n")}\n\n` : "") +
    `The full text of the manuscript follows. It was extracted from the author's file, so ` +
    `headings, tables and figure captions may be imperfectly laid out; read past that rather ` +
    `than reviewing the formatting of this extract.\n\n` +
    `MANUSCRIPT:\n${quoted(request.manuscript.trim())}\n\n` +
    `Write your review.`
  );
}

export function reviewMessages(request: ReviewRequest): ChatMessage[] {
  return [
    { role: "system", content: buildSystem(request) },
    { role: "user", content: buildUser(request) },
  ];
}

export function studyTypeById(
  types: readonly StudyType[],
  id: string,
): StudyType | undefined {
  return types.find((t) => t.id === id);
}

/**
 * One request per reviewer on the panel.
 *
 * Built here rather than in the component so the preview and the send are the
 * same construction -- the paper drafter's `requestFor` earns its place the
 * same way. An unknown study type yields no requests at all rather than one
 * generic review: the panel IS the prompt here, and there is nothing sensible
 * to send without one.
 */
export function requestsFor(opts: {
  prompt: string;
  types: readonly StudyType[];
  studyTypeId: string;
  note: string;
  title: string;
  manuscript: string;
}): ReviewRequest[] {
  const type = studyTypeById(opts.types, opts.studyTypeId);
  if (!type) return [];
  return type.reviewers.map((r) => ({
    prompt: opts.prompt,
    reviewerInstructions: r.instructions,
    reviewerId: r.id,
    reviewerLabel: r.label,
    studyLabel: type.label,
    note: opts.note,
    title: opts.title,
    manuscript: opts.manuscript,
  }));
}

/** The finished panel, as one document. */
export function assembleReview(
  title: string,
  reports: { label: string; text: string }[],
): string {
  return [
    `# Review of “${title.trim() || "untitled manuscript"}”`,
    ``,
    ...reports.flatMap((r) => [`## ${r.label}`, ``, r.text.trim(), ``]),
  ].join("\n");
}
