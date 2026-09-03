/**
 * The eleven stages, named for somebody watching them go by.
 *
 * The run's progress was one line of text above the composer, replaced several
 * times a second. It said what was happening and nothing about where that sat
 * in a process that takes minutes -- so a stage that legitimately runs for four
 * minutes was indistinguishable from a hang, and "how far along is it" had no
 * answer at all. Reported as wanting the steps visible in the conversation
 * instead.
 *
 * The order here IS the pipeline's order, and the ids are the strings
 * `checkpoint()` is already called with, so a stage cannot appear in one and
 * not the other without the list below failing its test.
 */

export interface StageInfo {
  id: string;
  /** What it is doing, in the user's terms rather than the pipeline's. */
  label: string;
  /** One line for anybody who wants to know what the step actually means. */
  hint: string;
}

export const RESEARCH_STAGES: readonly StageInfo[] = [
  { id: "scope", label: "Scoping", hint: "Working out what you are actually asking." },
  { id: "plan", label: "Planning", hint: "Drafting the searches, for you to approve." },
  { id: "discover", label: "Searching", hint: "Querying the literature for candidates." },
  { id: "screen", label: "Screening", hint: "Judging which candidates are worth reading." },
  { id: "snowball", label: "Snowballing", hint: "Following citations out from what was kept." },
  { id: "retrieve", label: "Retrieving", hint: "Fetching the full text where it is open." },
  { id: "extract", label: "Extracting", hint: "Pulling out the claims and their evidence." },
  { id: "synthesize", label: "Synthesising", hint: "Writing the report from what was found." },
  { id: "verify", label: "Verifying", hint: "Checking every quote against its source." },
  { id: "review", label: "Reviewing", hint: "Reading the draft back for what it got wrong." },
  { id: "revise", label: "Revising", hint: "Correcting it, and finishing the bibliography." },
];

export const STAGE_IDS: readonly string[] = RESEARCH_STAGES.map((s) => s.id);

/** Where a stage sits in the run, or -1 for a name that is not one. */
export function stageIndex(id: string): number {
  return STAGE_IDS.indexOf(id);
}

export interface StageProgress {
  /** The stage now running. */
  stage: string;
  /** The live detail line, which changes many times within one stage. */
  note?: string | undefined;
}
