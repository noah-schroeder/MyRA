/**
 * The rungs, and nothing that touches a disk.
 *
 * Split out of config.ts because the renderer needs these and config.ts reads
 * research.json -- so importing the ladder there dragged node:fs into the
 * browser bundle. Typecheck was happy; the build was not, which is the useful
 * kind of failure.
 *
 * It also removes a hand-kept copy. The renderer used to redeclare the ladder
 * in its own types, with a comment asking the next person to keep the two in
 * step; a rung added in one and not the other made a control that writes a
 * value the reader coerces away.
 */

export type ResearchMode = "off" | "assistant" | "library" | "web" | "deep";

/**
 * One ladder, not five controls: how far Karen may reach on its own.
 *
 * Each rung is a superset of the one below, which is what lets a single control
 * express the whole question -- and, more usefully, what lets every gate be
 * written as "at least this far" instead of a list of modes that has to be
 * revisited each time a rung appears.
 *
 *   off        nothing at all. No tool is sent in the schema, so the answer is
 *              the model's own and there is nothing for it to call.
 *   assistant  the documents folder. Local, jailed, no network.
 *   library    + the user's own Zotero, over its loopback API. Still no network:
 *              this rung reaches further into THIS MACHINE, not outward.
 *   web        + searching the literature. The first rung that leaves the box.
 *   deep       + the multi-stage pipeline, instead of a single lookup.
 *
 * IN ORDER. `reaches` indexes this array, so the order is the semantics.
 */
export const RESEARCH_MODES: readonly ResearchMode[] = [
  "off", "assistant", "library", "web", "deep",
];

/**
 * Does this mode reach at least as far as that one?
 *
 * The whole reason gates are written this way. `fetch_page` was once gated on
 * `mode !== "off"`, which was correct for exactly as long as there were two
 * modes: adding "assistant" would have handed the web to the one rung that must
 * not have it, and adding "library" would have done it again. A rank comparison
 * cannot develop that bug, because a new rung has to be placed in the ladder
 * before it can be placed anywhere else.
 */
export function reaches(mode: ResearchMode, atLeast: ResearchMode): boolean {
  return RESEARCH_MODES.indexOf(mode) >= RESEARCH_MODES.indexOf(atLeast);
}

/**
 * Is this EXACTLY that rung -- deliberately, not by accident?
 *
 * Almost every gate wants `reaches`. Two do not: the searching rungs are
 * exclusive rather than cumulative, because narrowing the agent to the one
 * search tool that matches is the point of having two of them. "Quick" must not
 * be able to start a ten-minute report, and "Deep" must not be able to quietly
 * do a shallow lookup instead of the one that was asked for.
 *
 * That is a real requirement, and `===` expresses it correctly. It is also
 * indistinguishable, at a glance, from the `===` somebody writes without having
 * thought about rungs at all -- which is the bug this ladder exists to prevent.
 * So the deliberate one says so, and a bare mode literal anywhere else in the
 * codebase is now a thing to look at rather than a thing to read past.
 */
export function exactly(mode: ResearchMode, rung: ResearchMode): boolean {
  return mode === rung;
}

/**
 * Whether this mode may reach the NETWORK.
 *
 * Deliberately not "may search anything": the library rung searches, and it
 * searches loopback. This is the egress question, and it is the one that has to
 * stay exact.
 */
export function searches(mode: ResearchMode): boolean {
  return reaches(mode, "web");
}

/** Whether the user's own Zotero library is readable in this mode. */
export function readsLibrary(mode: ResearchMode): boolean {
  return reaches(mode, "library");
}

/** Whether the local document tools are in the schema. */
export function readsDocuments(mode: ResearchMode): boolean {
  return reaches(mode, "assistant");
}

