/**
 * The copy buttons and the panel's edge.
 *
 * Two small rules with consequences out of proportion to their size: one keeps
 * the model's reasoning out of somebody's paper, the other keeps a width stored
 * on one screen from making the app unusable on another.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { answerText } from "../src/renderer/components/turnText.ts";
import {
  clampWidth, DEFAULT_WIDTH, MAX_FRACTION, MIN_WIDTH,
} from "../src/renderer/components/artifactWidth.ts";

test("copying a turn takes the answer and never the reasoning", () => {
  /* Reasoning is deliberately not written to the session and not sent back on
     the next turn. Copied text goes somewhere MyRA cannot see -- very often a
     document about to be sent to someone else -- so this button is the one
     place that guarantee could spring a leak without anybody noticing. */
  const copied = answerText([
    { kind: "thinking", text: "The user probably means X. I should check Y first." },
    { kind: "text", text: "Working memory training does not transfer." },
    { kind: "thinking", text: "Second thoughts, but I will not say them." },
    { kind: "text", text: "The meta-analytic evidence is consistent on this." },
  ]);
  assert.equal(
    copied,
    "Working memory training does not transfer.\n\nThe meta-analytic evidence is consistent on this.",
  );
  assert.doesNotMatch(copied, /probably means|Second thoughts/);
});

test("a turn that was nothing but reasoning copies nothing", () => {
  // Not the string "undefined", and not the reasoning as a consolation prize.
  assert.equal(answerText([{ kind: "thinking", text: "hmm" }]), "");
  assert.equal(answerText([]), "");
});

test("a stored width cannot outgrow the screen it is restored on", () => {
  /* Dragged wide on a monitor, reopened on a laptop. Without the window in the
     calculation the conversation comes back a few pixels across and the grip
     that caused it is off the right-hand edge -- unreachable, so the control
     cannot undo its own damage. */
  assert.equal(clampWidth(1400, 1280), Math.round(1280 * MAX_FRACTION));
  assert.equal(clampWidth(10, 1280), MIN_WIDTH);
  assert.equal(clampWidth(DEFAULT_WIDTH, 1280), DEFAULT_WIDTH);
  // A window narrower than the minimum still yields the minimum, not a
  // negative or a zero-width panel.
  assert.equal(clampWidth(400, 200), MIN_WIDTH);
  /* Junk out of localStorage must not reach the grid template. NaN there is
     not an error the browser reports; it is a declaration it drops, leaving a
     panel that ignores every drag and says nothing about why. */
  assert.equal(clampWidth(Number.NaN, 1280), DEFAULT_WIDTH);
  /* Infinity gets the same treatment as NaN rather than clamping to the
     maximum. Neither can come out of arithmetic on real coordinates, so both
     mean "this is not a measurement" -- and a stored width that silently
     reopened as wide as the rule allows would look like the app deciding. */
  assert.equal(clampWidth(Number.POSITIVE_INFINITY, 1280), DEFAULT_WIDTH);
  // A genuinely large FINITE number is a measurement, and does clamp.
  assert.equal(clampWidth(1e9, 1280), Math.round(1280 * MAX_FRACTION));
});

test("a fractional drag lands on whole pixels", () => {
  assert.equal(clampWidth(422.6, 1280), 423);
});
