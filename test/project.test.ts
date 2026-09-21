/**
 * A project's membership, which is where the whole feature can go wrong.
 *
 * Two properties carry it. Membership is **exclusive** -- a thing is in one
 * project -- which makes moving something an edit to two records, and makes
 * "delete this project and everything in it" a question with an answer. And a
 * member is a **pair**, not a bare id: the five stores mint their ids
 * independently and four of them start with the same date stamp, so comparing
 * on the ref alone would let a paper be removed because a meeting shared its
 * name.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  addMembers, assertProjectId, byNewest, countsOf, hasMember, kindLabel, newProject, ownerOf,
  parseProject, perProjectLimit, projectId, pruneMembers, railRows, removeMembers, sameMember,
  summaryOf,
  type Member, type Project,
} from "../src/core/projects/project.ts";

const chat = (ref: string): Member => ({ kind: "chat", ref });
const paper = (ref: string): Member => ({ kind: "paper", ref });

function project(name: string, members: Member[] = []): Project {
  return { ...newProject({ name, now: new Date(2026, 0, 1) }), members };
}

describe("a project id", () => {
  it("is legible and dated by the clock a file manager prints", () => {
    assert.equal(
      projectId("NSF concept note", new Date(2026, 8, 3, 9, 5), "ab12"),
      "20260903-0905-nsf-concept-note-ab12",
    );
  });

  it("refuses anything that is not one", () => {
    for (const bad of ["../secrets", "a/b", ".", "..", "", "with space"]) {
      assert.throws(() => assertProjectId(bad), /no project named/, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(assertProjectId("20260903-0905-a_b.c"), "20260903-0905-a_b.c");
  });
});

describe("a member is a pair", () => {
  it("is not equal to another kind that happens to share an id", () => {
    /* The real hazard: four of the five stores stamp an id with the date, so
       the same string is a plausible id in more than one of them. */
    assert.equal(sameMember(chat("20260903-1405"), paper("20260903-1405")), false);
    assert.equal(sameMember(chat("a"), chat("a")), true);
  });

  it("is removed by the pair, so a twin of another kind survives", () => {
    const p = project("x", [chat("same"), paper("same")]);
    const after = removeMembers(p, [chat("same")]);
    assert.deepEqual(after.members, [paper("same")]);
  });
});

describe("adding is a move", () => {
  it("takes the member out of whichever project had it", () => {
    const a = { ...project("A", [chat("c1"), chat("c2")]), id: "a" };
    const b = { ...project("B"), id: "b" };

    const [nextA, nextB] = addMembers([a, b], "b", [chat("c1")]);
    assert.deepEqual(nextA?.members, [chat("c2")]);
    assert.deepEqual(nextB?.members, [chat("c1")]);
    // And exactly one project claims it afterwards.
    assert.equal(ownerOf([nextA!, nextB!], chat("c1"))?.id, "b");
  });

  it("does not add the same thing twice", () => {
    const a = { ...project("A", [chat("c1")]), id: "a" };
    const [after] = addMembers([a], "a", [chat("c1"), chat("c1")]);
    assert.deepEqual(after?.members, [chat("c1")]);
  });

  it("leaves untouched projects untouched, object identity included", () => {
    /* Which is what lets the caller write back only what changed, rather than
       rewriting every record on every add. */
    const a = { ...project("A"), id: "a" };
    const b = { ...project("B", [paper("p1")]), id: "b" };
    const [nextA, nextB] = addMembers([a, b], "a", [chat("c1")]);
    assert.notEqual(nextA, a);
    assert.equal(nextB, b);
  });

  it("moves updatedAt only on the records that changed", () => {
    const a = { ...project("A"), id: "a", updatedAt: "2026-01-01T00:00:00.000Z" };
    const b = { ...project("B"), id: "b", updatedAt: "2026-01-01T00:00:00.000Z" };
    const [nextA, nextB] = addMembers([a, b], "a", [chat("c1")], new Date(2026, 5, 5));
    assert.notEqual(nextA?.updatedAt, a.updatedAt);
    assert.equal(nextB?.updatedAt, b.updatedAt);
  });
});

describe("pruning", () => {
  it("drops members whose item has gone", () => {
    const p = project("x", [chat("gone"), chat("here")]);
    const after = pruneMembers(p, (m) => m.ref === "here");
    assert.deepEqual(after.members, [chat("here")]);
  });

  it("does not move updatedAt, because nobody did anything", () => {
    /* Pruning is MyRA noticing, not the user acting. A project that jumped to
       the top of the rail because a chat was deleted elsewhere would be
       reporting an event that did not happen. */
    const p = { ...project("x", [chat("gone")]), updatedAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(pruneMembers(p, () => false).updatedAt, p.updatedAt);
  });

  it("returns the same object when nothing was pruned", () => {
    const p = project("x", [chat("here")]);
    assert.equal(pruneMembers(p, () => true), p);
  });
});

describe("what the confirm dialog prints", () => {
  it("counts each kind", () => {
    const counts = countsOf([chat("a"), chat("b"), paper("c"), { kind: "run", ref: "d" }]);
    assert.equal(counts.chat, 2);
    assert.equal(counts.paper, 1);
    assert.equal(counts.run, 1);
    assert.equal(counts.image, 0);
  });

  it("names them in words that pluralise", () => {
    assert.equal(kindLabel("run", 1), "research run");
    assert.equal(kindLabel("run", 3), "research runs");
    assert.equal(kindLabel("chat", 1), "conversation");
  });
});

describe("reading a record back", () => {
  it("rebuilds what was written", () => {
    const p = project("x", [chat("c1"), paper("p1")]);
    assert.deepEqual(parseProject(JSON.parse(JSON.stringify(p)), p.id), p);
  });

  it("drops members of a kind this build does not know", () => {
    const back = parseProject({ name: "x", members: [{ kind: "spreadsheet", ref: "a" }, chat("c1")] }, "id");
    assert.deepEqual(back?.members, [chat("c1")]);
  });

  it("deduplicates, so a bad write cannot double a count", () => {
    const back = parseProject({ name: "x", members: [chat("c1"), chat("c1")] }, "id");
    assert.equal(back?.members.length, 1);
  });

  it("skips a file that is not a record at all", () => {
    for (const junk of [undefined, null, 7, "text", []]) assert.equal(parseProject(junk, "id"), undefined);
  });
});

describe("the rail's order", () => {
  it("is most recently worked in first", () => {
    const older = { ...summaryOf(project("a")), updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...summaryOf(project("b")), updatedAt: "2026-09-01T00:00:00.000Z" };
    assert.deepEqual([older, newer].sort(byNewest).map((p) => p.name), ["b", "a"]);
  });

  it("counts what is in each", () => {
    assert.equal(summaryOf(project("a", [chat("c"), paper("p")])).items, 2);
  });
});

describe("what the rail shows", () => {
  const row = (project: string, ref: string) => ({ project, ref });

  it("shows a conversation that is in no project, which is most of them", () => {
    /* The ordinary way to use the app: no project open, just chatting. That
       conversation is in this list whether or not a project exists at all. */
    const rows = [row("", "just-chatting"), row("p1", "filed")];
    assert.deepEqual(railRows(rows).map((r) => r.ref), ["just-chatting"]);
    assert.deepEqual(railRows([row("", "a"), row("", "b")]).map((r) => r.ref), ["a", "b"]);
  });

  it("shows one project's work when a project is named, and only that one's", () => {
    const rows = [row("", "loose"), row("p1", "mine"), row("p2", "theirs")];
    assert.deepEqual(railRows(rows, "p1").map((r) => r.ref), ["mine"]);
  });

  it("puts every row in exactly one of the two groups", () => {
    /* The property the delete button rests on: nothing is in both, so the
       broom under the loose list cannot reach filed work. */
    const rows = [row("", "loose"), row("p1", "filed")];
    for (const r of rows) {
      const inLoose = railRows(rows).includes(r);
      const inProject = r.project ? railRows(rows, r.project).includes(r) : false;
      assert.equal(inLoose !== inProject, true, `${r.ref} is in both groups or neither`);
    }
  });
});

describe("the rail's limit", () => {
  const row = (project: string, ref: string) => ({ project, ref });

  it("is counted per project, so filed work cannot crowd out loose work", () => {
    /* The rail draws one group at a time -- what is in no project, or one
       project's own. A limit across the whole list would let three items
       filed this morning push out every loose conversation in a list that was
       never going to show them. */
    const rows = [row("p1", "a"), row("p1", "b"), row("p1", "c"), row("", "loose")];
    assert.deepEqual(perProjectLimit(rows, 2).map((r) => r.ref), ["a", "b", "loose"]);
  });

  it("keeps the order it was given, which is the order it was sorted in", () => {
    const rows = [row("", "newest"), row("p1", "filed"), row("", "older")];
    assert.deepEqual(perProjectLimit(rows, 5).map((r) => r.ref), ["newest", "filed", "older"]);
  });
});

describe("hasMember", () => {
  it("answers on the pair", () => {
    const p = project("x", [chat("a")]);
    assert.equal(hasMember(p, chat("a")), true);
    assert.equal(hasMember(p, paper("a")), false);
  });
});
