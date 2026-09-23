/**
 * The tool, whose whole discipline is refusing to trust its own guesses.
 *
 * A model may pass counts it read in the conversation, but every one of them
 * has to survive an editable form before anything is drawn -- the same rule
 * research/prisma.ts already keeps for a number this app measured itself. So
 * most of what is worth testing here is the refusal paths: a cancelled
 * question, a form the user declined, a form submitted empty, and the guard
 * against calling this twice in one turn.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  beginPrismaTurn, createPrismaDiagramTool, setPrismaHost, type PrismaHost,
} from "../src/core/agent/tools/prisma.ts";
import { setDiagramWatcher, resetDiagramIds, type DiagramUpdate } from "../src/core/agent/tools/diagram.ts";
import type { PrismaFormField } from "../src/core/prisma/spec.ts";

const ctx = {} as never;
const run = (params: Record<string, unknown> = {}) => createPrismaDiagramTool.handler(params, ctx);

/** A host that answers every dialog the same way, unless told otherwise. */
function host(opts: {
  review?: string | undefined;
  other?: string | undefined;
  form?: Record<string, string> | undefined;
  seenFields?: PrismaFormField[];
} = {}): PrismaHost {
  const review = "review" in opts ? opts.review : "A new review";
  const other = "other" in opts ? opts.other : "No, only databases and registers";
  const form = "form" in opts ? opts.form : { databases: "10", screened: "5", includedStudies: "1" };
  return {
    ui: {
      choose: async (choice) => (choice.title.startsWith("Is this") ? review : other),
      form: async (_title, _message, fields) => {
        opts.seenFields?.push(...fields);
        return form;
      },
    },
  };
}

test("it is safe, because nothing it does touches a disk", () => {
  assert.equal(createPrismaDiagramTool.risk, "safe");
});

test("a filled form draws the figure and announces it once", async () => {
  resetDiagramIds();
  beginPrismaTurn();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  setPrismaHost(host());
  try {
    const res = await run({ title: "My review" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.title, "My review");
    assert.ok(seen[0]?.prisma, "the artifact carries a placed figure, not Mermaid source");
    assert.equal(seen[0]?.source, undefined);
    assert.match(res.content, /Drew the PRISMA flow diagram/);
  } finally {
    setDiagramWatcher(undefined);
    setPrismaHost(undefined);
  }
});

test("cancelling the review-type question draws nothing", async () => {
  beginPrismaTurn();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  setPrismaHost(host({ review: undefined }));
  try {
    const res = await run();
    assert.equal(seen.length, 0);
    assert.match(res.content, /did not say whether this is a new or updated review/);
  } finally {
    setDiagramWatcher(undefined);
    setPrismaHost(undefined);
  }
});

test("cancelling the other-methods question draws nothing", async () => {
  beginPrismaTurn();
  setPrismaHost(host({ other: undefined }));
  try {
    const res = await run();
    assert.match(res.content, /did not say whether other search methods were used/);
  } finally {
    setPrismaHost(undefined);
  }
});

test("declining the form draws nothing", async () => {
  beginPrismaTurn();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  setPrismaHost(host({ form: undefined }));
  try {
    const res = await run();
    assert.equal(seen.length, 0);
    assert.match(res.content, /did not fill in the figure's numbers/);
  } finally {
    setDiagramWatcher(undefined);
    setPrismaHost(undefined);
  }
});

test("an entirely blank form draws nothing, rather than an empty figure", async () => {
  beginPrismaTurn();
  const seen: DiagramUpdate[] = [];
  setDiagramWatcher((d) => seen.push(d));
  setPrismaHost(host({ form: {} }));
  try {
    const res = await run();
    assert.equal(seen.length, 0);
    assert.match(res.content, /nothing to draw/);
  } finally {
    setDiagramWatcher(undefined);
    setPrismaHost(undefined);
  }
});

test("with no host installed it refuses loudly, because that is a wiring fault", async () => {
  setPrismaHost(undefined);
  await assert.rejects(() => run(), /has not attached a dialog host/);
});

test("a second call in the same turn is refused without asking anything again", async () => {
  beginPrismaTurn();
  let asked = 0;
  setPrismaHost({
    ui: {
      choose: async () => { asked++; return "A new review"; },
      form: async () => ({ databases: "1" }),
    },
  });
  try {
    await run();
    const res = await run();
    assert.equal(asked, 2, "only the first call should have asked anything");
    assert.match(res.content, /already handled in this turn/);
  } finally {
    setPrismaHost(undefined);
  }
});

test("a new turn may draw another figure", async () => {
  beginPrismaTurn();
  setPrismaHost(host());
  try {
    await run();
    beginPrismaTurn();
    const res = await run();
    assert.doesNotMatch(res.content, /already handled in this turn/);
  } finally {
    setPrismaHost(undefined);
  }
});

test("counts the model offers reach the form marked as a guess, keyed by the field id", async () => {
  beginPrismaTurn();
  const seenFields: PrismaFormField[] = [];
  setPrismaHost(host({ seenFields }));
  try {
    await run({ counts: { databases: 1203, screened: -5, notANumber: "x" } });
    const field = seenFields.find((f) => f.key === "databases");
    assert.equal(field?.value, "1,203");
    assert.equal(field?.guessed, true);
    // Negative and non-numeric values are dropped rather than reaching the form.
    assert.equal(seenFields.find((f) => f.key === "screened")?.value, undefined);
  } finally {
    setPrismaHost(undefined);
  }
});

test("a variant answer picks the right template, which the form's own fields prove", async () => {
  const seenFields: PrismaFormField[] = [];
  beginPrismaTurn();
  setPrismaHost(host({
    review: "An update of a previous review",
    other: "Yes, other methods too",
    seenFields,
  }));
  try {
    await run();
    assert.ok(seenFields.some((f) => f.key === "previousStudies"), "updated review asks for the previous column");
    assert.ok(seenFields.some((f) => f.key === "websites"), "+other asks for the other-methods column");
    assert.ok(!seenFields.some((f) => f.key === "includedStudies"), "updated uses newStudies, not includedStudies");
  } finally {
    setPrismaHost(undefined);
  }
});
