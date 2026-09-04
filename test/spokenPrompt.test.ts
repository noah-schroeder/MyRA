/**
 * What the model is told when its answer is going to be heard rather than read.
 *
 * The rule these guard is that hands-free changes what a good answer IS, and
 * that one instruction in it must NOT change: citations survive, because
 * `speakable()` removes the markers from the audio and the transcript on
 * screen keeps them. A prompt that told the model to drop them would break the
 * app's one unbreakable promise on every spoken turn.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { spokenGuidance } from "../src/core/agent/spokenPrompt.ts";
import { speakable } from "../src/core/audio/speakable.ts";

test("nothing at all is added when the answer is only going to be read", () => {
  assert.deepEqual(spokenGuidance(false), []);
});

test("a spoken answer is asked to be short and to lead with the answer", () => {
  const text = spokenGuidance(true).join("\n");
  assert.match(text, /few sentences/i);
  assert.match(text, /lead with the answer/i);
});

test("the shapes that cannot be heard are named", () => {
  // Each of these is silently mangled or announced by speakable() rather than
  // read, so producing one wastes the turn.
  const text = spokenGuidance(true).join("\n").toLowerCase();
  for (const shape of ["headings", "bullet", "tables", "code blocks"]) {
    assert.ok(text.includes(shape), `spoken guidance never mentions ${shape}`);
  }
});

test("citations are kept, and the reason is given", () => {
  const text = spokenGuidance(true).join("\n");
  assert.match(text, /keep your citation markers/i);
  assert.doesNotMatch(text, /(omit|drop|do not (use|write)) (the )?citation/i);
});

test("the promise that rests on is true: speaking removes the markers", () => {
  // If this ever stops holding, the instruction above becomes a lie and the
  // listener hears "bracket three" in the middle of a sentence.
  // And the space the marker left goes with it, so the sentence still reads.
  assert.equal(speakable("Working memory training does not transfer [1]."),
    "Working memory training does not transfer.");
  assert.doesNotMatch(speakable("Two studies agree [2], [5]."), /\[\d/);
});
