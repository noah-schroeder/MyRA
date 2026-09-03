/**
 * Prompt scaffolding.
 *
 * One property carries the whole design and is worth pinning down: the preset
 * is style and the user's words are subject, so the words lead and nothing the
 * preset does can strand, duplicate or reorder them. The composition is done at
 * send time from (typed, presetId) rather than by editing the box, and these
 * tests are what says that stays true.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  composeNegative, composePrompt, IMAGE_PRESETS, presetById,
} from "../src/core/images/presets.ts";

const conceptual = presetById("conceptual")!;
const schematic = presetById("schematic")!;

describe("composing the prompt", () => {
  it("puts the user's words first", () => {
    /* A diffusion model weights the front of a prompt most heavily, so the
       subject has to be the part that survives a long scaffold. */
    const out = composePrompt("a mitochondrion", conceptual);
    assert.ok(out.startsWith("a mitochondrion,"), out);
    assert.ok(out.includes(conceptual.scaffold));
  });

  it("is just the words when no preset is on", () => {
    assert.equal(composePrompt("  a mitochondrion  "), "a mitochondrion");
  });

  it("is just the scaffold when nothing was typed", () => {
    assert.equal(composePrompt("   ", conceptual), conceptual.scaffold);
  });

  it("does not double a separator the user already typed", () => {
    assert.equal(composePrompt("a cell, ", conceptual), `a cell, ${conceptual.scaffold}`);
    assert.equal(composePrompt("a cell,", conceptual), `a cell, ${conceptual.scaffold}`);
  });

  it("swapping presets cannot leave the previous one behind", () => {
    /* The reason composition happens here and not in the textarea. Editing the
       box would mean the old scaffold had to be found and removed, and a user
       who touched the text in between would keep both. */
    const first = composePrompt("a cell", conceptual);
    const second = composePrompt("a cell", schematic);
    assert.equal(second.includes(conceptual.scaffold), false);
    assert.ok(second.includes(schematic.scaffold));
    assert.notEqual(first, second);
  });

  it("is stable: composing the same input twice gives the same prompt", () => {
    assert.equal(composePrompt("a cell", conceptual), composePrompt("a cell", conceptual));
  });
});

describe("composing the negative prompt", () => {
  it("keeps what the user typed and adds the preset's", () => {
    const out = composeNegative("green", conceptual);
    assert.ok(out.startsWith("green,"), out);
    assert.ok(out.includes(conceptual.avoid));
  });

  it("is the preset's alone when the box is empty", () => {
    assert.equal(composeNegative("", conceptual), conceptual.avoid);
  });

  it("is empty when there is neither", () => {
    assert.equal(composeNegative("  "), "");
  });
});

describe("the preset table", () => {
  it("has no duplicate ids, because one would shadow the other in the row", () => {
    const ids = IMAGE_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("gives every preset something to say for itself", () => {
    for (const preset of IMAGE_PRESETS) {
      assert.ok(preset.label.length, preset.id);
      assert.ok(preset.hint.length, preset.id);
      assert.ok(preset.scaffold.length, preset.id);
      assert.ok(preset.avoid.length, preset.id);
    }
  });

  it("offers no preset that promises lettering", () => {
    /* The load-bearing omission. These models produce text-shaped marks rather
       than text, so a "flowchart" or "PRISMA" button would be a button that
       silently disappoints -- see LETTERING_WARNING. */
    const labels = IMAGE_PRESETS.map((p) => p.label.toLowerCase()).join(" ");
    assert.equal(/flow ?chart|prisma|labelled|labeled/.test(labels), false);
  });

  it("tells the figure presets to avoid text", () => {
    for (const preset of IMAGE_PRESETS) {
      assert.match(preset.avoid, /text/, preset.id);
    }
  });

  it("returns nothing for an id that is not one", () => {
    assert.equal(presetById(undefined), undefined);
    assert.equal(presetById(""), undefined);
    assert.equal(presetById("no-such-preset"), undefined);
  });
});
