/**
 * A project's memory: parsing, editing, and what actually reaches a prompt.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  addItems, editItem, fieldsToItems, itemsToFields, markSetupDone, memoryTokens, mergeAuto, newMemory,
  parseMemory, removeItem, renderMemory, renderMemoryMarkdown, setAuto,
  type ProjectMemory,
} from "../src/core/projects/memory.ts";

describe("parsing a memory record", () => {
  it("is forgiving of garbage, the way parseProject is", () => {
    assert.deepEqual(parseMemory(null), newMemory());
    assert.deepEqual(parseMemory("nonsense"), newMemory());
    assert.deepEqual(parseMemory([]), newMemory());
  });

  it("drops an item with an unknown slot rather than trusting it forward", () => {
    const memory = parseMemory({
      items: [
        { id: "a", slot: "questions", text: "Does X predict Y?", source: "you", at: "2026-01-01T00:00:00Z" },
        { id: "b", slot: "made-up-slot", text: "should be dropped", source: "you", at: "2026-01-01T00:00:00Z" },
      ],
    });
    assert.equal(memory.items.length, 1);
    assert.equal(memory.items[0]!.text, "Does X predict Y?");
  });

  it("drops an item with no text", () => {
    const memory = parseMemory({ items: [{ id: "a", slot: "aims", text: "  ", source: "you" }] });
    assert.equal(memory.items.length, 0);
  });

  it("falls back to 'you' for an unknown source rather than trusting it", () => {
    const memory = parseMemory({
      items: [{ id: "a", slot: "aims", text: "x", source: "from-the-moon", at: "2026-01-01T00:00:00Z" }],
    });
    assert.equal(memory.items[0]!.source, "you");
  });

  it("reads setup and auto, with sane defaults", () => {
    assert.equal(parseMemory({}).setup, "done");
    assert.equal(parseMemory({ setup: "pending" }).setup, "pending");
    assert.equal(parseMemory({}).auto, true);
    assert.equal(parseMemory({ auto: false }).auto, false);
  });

  it("keeps only well-formed seen counts", () => {
    const memory = parseMemory({ seen: { a: 5, b: -1, c: "no", d: 3.7 } });
    assert.deepEqual(memory.seen, { a: 5, d: 4 });
  });
});

describe("editing", () => {
  it("adds items under the given source", () => {
    const memory = addItems(newMemory(), [{ slot: "questions", text: "Does X predict Y?" }], "setup");
    assert.equal(memory.items.length, 1);
    assert.equal(memory.items[0]!.source, "setup");
  });

  it("drops a blank item rather than adding an empty note", () => {
    const memory = addItems(newMemory(), [{ slot: "aims", text: "   " }], "you");
    assert.equal(memory.items.length, 0);
  });

  it("turns an auto item into a 'you' item the moment it is edited", () => {
    let memory = mergeAuto(newMemory(), [{ slot: "decisions", text: "Using grounded theory" }], "s1", 4);
    const id = memory.items[0]!.id;
    assert.equal(memory.items[0]!.source, "auto");
    memory = editItem(memory, id, "Using grounded theory, revised");
    assert.equal(memory.items[0]!.source, "you");
    assert.equal(memory.items[0]!.text, "Using grounded theory, revised");
  });

  it("clearing an item's text removes it, the same as removeItem", () => {
    let memory = addItems(newMemory(), [{ slot: "aims", text: "keep me" }], "you");
    const id = memory.items[0]!.id;
    memory = editItem(memory, id, "   ");
    assert.equal(memory.items.length, 0);
  });

  it("removeItem is a no-op on an id that is not there", () => {
    const memory = addItems(newMemory(), [{ slot: "aims", text: "x" }], "you");
    assert.equal(removeItem(memory, "not-an-id"), memory);
  });

  it("setAuto and markSetupDone are no-ops when already in that state", () => {
    const memory = newMemory();
    assert.equal(setAuto(memory, true), memory);
    assert.equal(markSetupDone(memory), memory);
  });
});

describe("mergeAuto", () => {
  it("never touches an item with source 'you' or 'setup'", () => {
    let memory = addItems(newMemory(), [{ slot: "aims", text: "Original aim" }], "you");
    memory = mergeAuto(memory, [{ slot: "aims", text: "Original aim" }], "s1", 3);
    // The duplicate is not added, and the original is untouched.
    assert.equal(memory.items.length, 1);
    assert.equal(memory.items[0]!.source, "you");
  });

  it("dedupes case-insensitively within the same slot", () => {
    let memory = mergeAuto(newMemory(), [{ slot: "decisions", text: "Using grounded theory" }], "s1", 3);
    memory = mergeAuto(memory, [{ slot: "decisions", text: "using GROUNDED theory" }], "s1", 6);
    assert.equal(memory.items.length, 1);
  });

  it("the same text in a different slot is not a duplicate", () => {
    let memory = mergeAuto(newMemory(), [{ slot: "decisions", text: "Interviews" }], "s1", 3);
    memory = mergeAuto(memory, [{ slot: "methods", text: "Interviews" }], "s1", 6);
    assert.equal(memory.items.length, 2);
  });

  it("advances the watermark even when nothing was added", () => {
    const memory = mergeAuto(newMemory(), [], "s1", 9);
    assert.equal(memory.seen["s1"], 9);
  });

  it("tracks the watermark per conversation", () => {
    let memory = mergeAuto(newMemory(), [], "s1", 4);
    memory = mergeAuto(memory, [], "s2", 9);
    assert.deepEqual(memory.seen, { s1: 4, s2: 9 });
  });
});

describe("renderMemory", () => {
  const full: ProjectMemory = addItems(
    newMemory(),
    [
      { slot: "context", text: "Background note." },
      { slot: "questions", text: "Does X predict Y?" },
      { slot: "aims", text: "Understand the mechanism." },
    ],
    "you",
  );

  it("is empty for a fresh project", () => {
    const render = renderMemory(newMemory());
    assert.equal(render.text, "");
    assert.equal(render.tokens, 0);
  });

  it("orders fields by priority, not by insertion order", () => {
    const render = renderMemory(full);
    const qIdx = render.text.indexOf("Research questions:");
    const aIdx = render.text.indexOf("Aims:");
    const cIdx = render.text.indexOf("Context:");
    assert.ok(qIdx >= 0 && aIdx > qIdx && cIdx > aIdx);
  });

  it("renders everything when no window is given", () => {
    const render = renderMemory(full);
    assert.equal(render.omitted.length, 0);
    assert.match(render.text, /Does X predict Y\?/);
    assert.match(render.text, /Background note\./);
    assert.equal(render.warn, false);
    assert.equal(render.share, undefined);
  });

  it("warns past a quarter of the window without omitting anything", () => {
    const tokens = memoryTokens(full);
    const render = renderMemory(full, Math.ceil(tokens / 0.3));
    assert.equal(render.warn, true);
    assert.equal(render.omitted.length, 0);
  });

  it("drops whole fields, poorest first, past half the window", () => {
    const tokens = memoryTokens(full);
    // A window barely bigger than one field's worth of text: only the top
    // priority field (questions) should survive.
    const render = renderMemory(full, Math.ceil(tokens * 0.6));
    assert.ok(render.omitted.includes("context"), "context is dropped before questions");
    assert.ok(!render.omitted.includes("questions"), "questions is never the first thing dropped");
    assert.match(render.text, /Does X predict Y\?/);
  });

  it("always keeps at least one field, even if it alone is over budget", () => {
    const render = renderMemory(full, 1);
    assert.ok(render.text.length > 0);
    assert.match(render.text, /Research questions:/);
  });

  it("never touches storage -- the omission is only in what is rendered", () => {
    const tokens = memoryTokens(full);
    renderMemory(full, Math.ceil(tokens * 0.6));
    assert.equal(full.items.length, 3, "the memory object passed in is untouched");
  });
});

describe("renderMemoryMarkdown, for the project export", () => {
  it("is empty for a project with no notes -- no empty file gets written", () => {
    assert.equal(renderMemoryMarkdown(newMemory()), "");
  });

  it("is markdown headings, uncapped by any window", () => {
    const memory = addItems(newMemory(), [{ slot: "questions", text: "Does X predict Y?" }], "you");
    const text = renderMemoryMarkdown(memory);
    assert.match(text, /^## Research questions/);
    assert.match(text, /- Does X predict Y\?/);
  });
});

describe("candidate items as a review form", () => {
  const items = [
    { slot: "questions" as const, text: "Does X predict Y?" },
    { slot: "aims" as const, text: "Understand the mechanism." },
  ];

  it("makes one field per item, grouped by the field label", () => {
    const fields = itemsToFields(items, true);
    assert.equal(fields.length, 2);
    assert.equal(fields[0]!.group, "Research questions");
    assert.equal(fields[0]!.value, "Does X predict Y?");
    assert.equal(fields[0]!.guessed, true);
  });

  it("round-trips unedited answers back to the same items", () => {
    const fields = itemsToFields(items, true);
    const answers = Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""]));
    assert.deepEqual(fieldsToItems(items, answers), items);
  });

  it("a blanked field drops its item", () => {
    const approved = fieldsToItems(items, { "item-0": "", "item-1": "Understand the mechanism, revised." });
    assert.equal(approved.length, 1);
    assert.equal(approved[0]!.text, "Understand the mechanism, revised.");
  });
});
