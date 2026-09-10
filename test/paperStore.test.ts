/**
 * The paper record: the id that becomes a path, and the file read back.
 *
 * Two hazards, both of which the rest of the app has already met once.
 *
 * The id comes back from a sandboxed window to be joined onto the papers root
 * and then read, exported and deleted -- the same journey an image id and a run
 * id make, and the reason `assertImageId` and `assertRunId` exist.
 *
 * And the file sits in a folder the user is invited to open, so one of them will
 * eventually be edited by hand, truncated by a full disk, or synced
 * half-written. A list that throws on the fifth of twenty papers is worse than
 * one that skips it, and a paper that comes back missing its sections is worse
 * than one that comes back with a blank one.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assemble, assertPaperId, mergeDrafts, moveSection, newPaper, newSection, paperId, withoutSection,
} from "../src/core/papers/paper.ts";
import { byNewest, idOfFile, parseRecord, summaryOf } from "../src/core/papers/store.ts";

describe("a paper id", () => {
  it("is legible, and dated by the clock the file manager prints", () => {
    const id = paperId("Retrieval practice in physics", new Date(2026, 8, 7, 14, 5));
    assert.equal(id, "20260907-1405-retrieval-practice-in-physics");
  });

  it("survives a title made entirely of punctuation", () => {
    assert.match(paperId("!!! ???", new Date(2026, 0, 1, 9, 0)), /^20260101-0900-paper$/);
  });

  it("refuses anything that is not one", () => {
    for (const bad of ["../secrets", "a/b", ".", "..", "", "with space", "x y"]) {
      assert.throws(() => assertPaperId(bad), /no paper named/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(assertPaperId("20260907-1405-a_b.c-d"), "20260907-1405-a_b.c-d");
  });

  it("recognises its own filenames and nothing else", () => {
    assert.equal(idOfFile("20260907-1405-paper.json"), "20260907-1405-paper");
    assert.equal(idOfFile("notes.txt"), undefined);
    assert.equal(idOfFile("../escape.json"), undefined);
    assert.equal(idOfFile("..json"), undefined);
  });
});

describe("the section list", () => {
  it("starts a whole paper on a conventional outline and a lone one on a single section", () => {
    assert.equal(newPaper({ kind: "paper", title: "x" }).sections.length, 6);
    assert.equal(newPaper({ kind: "section", title: "x" }).sections.length, 1);
  });

  it("gives every section its own id, so two of them cannot share a draft", () => {
    const ids = newPaper({ kind: "paper", title: "x" }).sections.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("moves a section without disturbing the rest", () => {
    const sections = ["a", "b", "c"].map((n) => newSection(n));
    const moved = moveSection(sections, 2, -1);
    assert.deepEqual(moved.map((s) => s.name), ["a", "c", "b"]);
    /* The up arrow on the first row and the down arrow on the last are pressed.
       Nothing happening is the answer; an exception is not. */
    assert.equal(moveSection(sections, 0, -1), sections);
    assert.equal(moveSection(sections, 2, 1), sections);
  });

  it("removes by id rather than by position", () => {
    const sections = ["a", "b", "c"].map((n) => newSection(n));
    const left = withoutSection(sections, sections[1]!.id);
    assert.deepEqual(left.map((s) => s.name), ["a", "c"]);
  });
});

describe("becoming a document", () => {
  it("marks a section nobody has written rather than dropping it", () => {
    const paper = newPaper({ kind: "paper", title: "Spacing" });
    paper.sections[0]!.draft = "The problem is durability.";
    const markdown = assemble(paper);
    assert.match(markdown, /^# Spacing/);
    assert.ok(markdown.includes("## Introduction\n\nThe problem is durability."));
    /* A document that silently omitted the empty sections would read as
       finished, and the gap would be found by whoever it was sent to. */
    assert.ok(markdown.includes("## Methods\n\n*(not yet written)*"));
  });

  it("writes no heading for a paper that is one section", () => {
    const lone = newPaper({ kind: "section", title: "Methods" });
    lone.sections[0]!.draft = "Two conditions, counterbalanced.";
    assert.equal(assemble(lone), "# Methods\n\nTwo conditions, counterbalanced.\n");
  });
});

describe("reading a record back", () => {
  it("rebuilds what was written", () => {
    const paper = newPaper({ kind: "paper", title: "Spacing" });
    paper.writingSample = "sample";
    const back = parseRecord(JSON.parse(JSON.stringify(paper)), paper.id);
    assert.deepEqual(back, paper);
  });

  it("skips a file that is not a record at all", () => {
    for (const junk of [undefined, null, 42, "text", []]) {
      assert.equal(parseRecord(junk, "id"), undefined);
    }
  });

  it("gives a mangled record something the page can draw", () => {
    const back = parseRecord({ title: "Half a paper", sections: [null, 7] }, "id");
    assert.equal(back?.title, "Half a paper");
    // Never zero sections: the page has nothing to show for one, and a title
    // and a writing sample are still worth keeping.
    assert.equal(back?.sections.length, 1);
    assert.equal(back?.kind, "paper");
  });

  it("gives a section that lost its id a new one rather than an index", () => {
    const back = parseRecord({ sections: [{ name: "One" }, { name: "Two" }] }, "id");
    const [a, b] = back!.sections;
    assert.ok(a?.id && b?.id && a.id !== b.id);
  });

  it("summarises what the list shows without reading every draft twice", () => {
    const paper = newPaper({ kind: "paper", title: "Spacing" });
    paper.sections[0]!.draft = "written";
    paper.sections[1]!.draft = "   ";
    const summary = summaryOf(paper);
    assert.equal(summary.sections, 6);
    assert.equal(summary.drafted, 1);
  });

  it("orders the list by what was worked on last", () => {
    const older = {
      ...summaryOf(newPaper({ kind: "paper", title: "a" })),
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newer = {
      ...summaryOf(newPaper({ kind: "paper", title: "b" })),
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    assert.deepEqual([older, newer].sort(byNewest).map((s) => s.title), ["b", "a"]);
  });
});

/*
 * The page and the main process now write the same file: the drafter autosaves
 * on a timer while the author types, and a finished section is committed out
 * there. The save that fires just after a draft lands carries a record whose
 * section is still empty, and it used to erase a minute of prose.
 */
describe("reconciling the page's copy with the file", () => {
  const withDraft = (draft: string, updatedAt: string) => {
    const paper = newPaper({ kind: "section", title: "Methods", now: new Date(0) });
    return {
      ...paper,
      updatedAt,
      sections: paper.sections.map((s) => ({ ...s, draft })),
    };
  };

  it("keeps a draft the page has not seen yet", () => {
    const stored = withDraft("Participants were undergraduates.", "2026-09-09T12:00:01.000Z");
    const stale = { ...withDraft("", "2026-09-09T12:00:00.000Z"), sections: stored.sections.map((s) => ({ ...s, draft: "" })) };
    const merged = mergeDrafts(stored, stale);
    assert.equal(merged.sections[0]?.draft, "Participants were undergraduates.");
  });

  it("never reverts prose the author edited by hand", () => {
    const stored = withDraft("What the model wrote.", "2026-09-09T12:00:01.000Z");
    const edited = { ...withDraft("What the author wrote.", "2026-09-09T12:00:00.000Z"), sections: stored.sections.map((s) => ({ ...s, draft: "What the author wrote." })) };
    assert.equal(mergeDrafts(stored, edited).sections[0]?.draft, "What the author wrote.");
  });

  it("leaves a page that has seen the file entirely alone", () => {
    const stored = withDraft("Old.", "2026-09-09T12:00:00.000Z");
    const current = { ...stored, updatedAt: "2026-09-09T12:00:00.000Z", title: "Renamed", sections: stored.sections.map((s) => ({ ...s, draft: "" })) };
    /* Not stale, so this is somebody clearing a section on purpose. */
    assert.equal(mergeDrafts(stored, current).sections[0]?.draft, "");
    assert.equal(mergeDrafts(stored, current).title, "Renamed");
  });

  it("takes everything from the page when there is no file yet", () => {
    const fresh = withDraft("First words.", "2026-09-09T12:00:00.000Z");
    assert.deepEqual(mergeDrafts(undefined, fresh), fresh);
  });
});
