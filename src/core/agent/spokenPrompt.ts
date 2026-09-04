/**
 * What to tell the model when its answer is going to be read aloud.
 *
 * Hands-free changes what a good answer IS, and nothing was telling the model
 * so. The same reply that reads well on screen -- a heading, four bullets, a
 * table, six hundred words -- becomes a minute and a half of speech that
 * cannot be skimmed, paused at a useful place, or gone back to. The listener
 * has no scrollbar.
 *
 * `speakable.ts` already handles the RENDERING: it drops citation markers,
 * strips heading marks, turns a table into "a table of four rows, on screen".
 * What it cannot do is make a long answer short, or move the point to the
 * front. That is a question about what the model writes, so it belongs in the
 * prompt.
 *
 * Deliberately not a setting. It applies exactly when hands-free is on, which
 * is a switch the user has already thrown, and a second control asking whether
 * spoken answers should be suited to being spoken is a question with one
 * sensible answer.
 */

/**
 * The guidance, or nothing at all when the answer is only going to be read.
 *
 * Returned as lines to match how the rest of the prompt is assembled, and
 * empty rather than absent so a caller can splice it unconditionally.
 */
export function spokenGuidance(spoken: boolean): string[] {
  if (!spoken) return [];
  return [
    "This answer will be spoken aloud, not read. Keep it to a few sentences — the",
    "listener cannot skim, scroll back, or skip ahead, so length costs them time they",
    "cannot get back. Lead with the answer itself and put the qualification after it.",
    "",
    "Write it to be heard: no headings, no bullet lists, no tables, no code blocks. Use",
    "ordinary sentences, and say numbers and units the way you would speak them.",
    "",
    /*
     * The citation rule survives, and saying so is the point.
     *
     * `speakable()` removes the markers before the audio is made, because "[3]"
     * spoken aloud is a number with no referent. The transcript on screen keeps
     * them. A model told to drop citations would break the app's one
     * unbreakable promise on every hands-free turn, so it is told the opposite
     * and told why.
     */
    "Keep your citation markers exactly as they are. They are removed before the audio",
    "is made and stay in the transcript on screen, so nothing is lost by writing them.",
    "",
    /* Offering costs a whole exchange when the reply is spoken: the user has to
       say yes, wait, and hear it. Just doing it is nearly always right. */
    "If they ask for something long — a document, a list, a piece of writing — say in one",
    "sentence what you are about to produce, then produce it. Do not offer and wait.",
  ];
}
