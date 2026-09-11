/**
 * What a turn copies.
 *
 * A `.ts` and not part of the component, so it is reachable from the test
 * runner: `node --experimental-strip-types` cannot load `.tsx`, and this is a
 * rule about where the model's reasoning may end up rather than a detail of how
 * a button looks. It is worth a test on its own.
 */

import type { Block } from "../types.ts";

/**
 * The answer, and never the working-out.
 *
 * Reasoning is deliberately not part of what a conversation keeps -- it is not
 * written to the session and not sent back on the next turn -- and a copy
 * button is the one place that guarantee could quietly spring a leak, because
 * copied text goes somewhere MyRA cannot see and is very often a document
 * somebody is about to send to somebody else.
 */
export function answerText(blocks: Block[]): string {
  return blocks
    .filter((b) => b.kind !== "thinking")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
