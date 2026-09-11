/**
 * The folder a project becomes.
 *
 * Export is the answer to "can it all be stored together?" — the project itself
 * is an index, and colocation is a thing you ask for rather than live in. That
 * puts real weight on this file: it is the one place where a project turns into
 * something a person keeps, archives, or sends to a co-author, and a name
 * collision here silently loses work.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newProject, type Member, type Project } from "../src/core/projects/project.ts";
import { exportPlan, fileName, renderSession, type ExportItem } from "../src/core/projects/render.ts";

const AT = new Date(2026, 8, 3, 10, 0);

function project(name = "NSF concept note"): Project {
  return { ...newProject({ name, now: AT }), members: [] };
}

function item(kind: Member["kind"], title: string, extra: Partial<ExportItem> = {}): ExportItem {
  return { member: { kind, ref: title }, title, at: AT.toISOString(), ...extra };
}

/** The path each write/copy lands on, which is what collisions show up in. */
const paths = (p: { ops: { path: string }[] }): string[] => p.ops.map((o) => o.path);

describe("names in the folder", () => {
  it("keeps spaces and capitals, and strips what a filesystem objects to", () => {
    assert.equal(fileName("Do concept notes predict funding?"), "Do concept notes predict funding");
    assert.equal(fileName("a/b: c*d"), "a b c d");
    assert.equal(fileName("   "), "untitled");
    // A name that is only dots is a name a file manager cannot show.
    assert.equal(fileName("..."), "untitled");
  });

  it("never collides two things with the same title", () => {
    /* Two papers both called "Draft" is not a corner case, it is Tuesday, and
       overwriting the first with the second would lose work in the one feature
       whose whole purpose is keeping it. */
    const plan = exportPlan(project(), [
      item("paper", "Draft", { text: "one" }),
      item("paper", "Draft", { text: "two" }),
      item("paper", "Draft", { text: "three" }),
    ]);
    assert.deepEqual(
      paths(plan).filter((p) => p.startsWith("papers/")),
      ["papers/Draft.md", "papers/Draft 2.md", "papers/Draft 3.md"],
    );
  });

  it("collides nothing across kinds, because each kind has its own folder", () => {
    const plan = exportPlan(project(), [
      item("paper", "Kickoff", { text: "p" }),
      item("chat", "Kickoff", { text: "c" }),
    ]);
    assert.ok(paths(plan).includes("papers/Kickoff.md"));
    assert.ok(paths(plan).includes("conversations/Kickoff.md"));
  });
});

describe("what gets written", () => {
  it("gives each kind the shape it needs", () => {
    const plan = exportPlan(project(), [
      item("paper", "Aims", { text: "# Aims" }),
      item("run", "Do notes predict funding", { dir: "/runs/r1", note: "41 sources" }),
      item("meeting", "Kickoff", {
        files: [
          { name: "notes.md", from: "/m/1/notes.md" },
          { name: "transcript.md", from: "/m/1/transcript.md" },
        ],
      }),
      item("image", "a rat on a bicycle", {
        files: [{ name: "20260903-a-rat.png", from: "/img/20260903-a-rat.png" }],
        note: "a rat on a bicycle",
      }),
    ]);

    assert.ok(plan.ops.some((o) => o.op === "write" && o.path === "papers/Aims.md"));
    assert.ok(plan.ops.some((o) => o.op === "copyDir" && o.path === "research/Do notes predict funding"));
    assert.ok(plan.ops.some((o) => o.op === "copyFile" && o.path === "meetings/Kickoff/notes.md"));
    // Images stay flat and keep their extension, so the folder shows thumbnails.
    assert.ok(plan.ops.some((o) => o.op === "copyFile" && o.path === "images/a rat on a bicycle.png"));
    assert.ok(plan.ops.some((o) => o.op === "write" && o.path === "images/index.md"));
  });

  it("writes the index last, so a crash leaves no index claiming missing files", () => {
    const plan = exportPlan(project(), [item("paper", "Aims", { text: "x" })]);
    assert.equal(plan.ops[plan.ops.length - 1]?.path, "project.md");
  });

  it("never copies meeting audio, and says so", () => {
    const plan = exportPlan(project(), [
      item("meeting", "Kickoff", { files: [{ name: "notes.md", from: "/m/1/notes.md" }] }),
    ]);
    assert.equal(paths(plan).some((p) => p.endsWith(".wav")), false);
    const index = plan.ops.find((o) => o.path === "project.md");
    assert.ok(index?.op === "write" && /not copied here/.test(index.text));
  });

  it("lists an item it could not resolve rather than dropping it", () => {
    /* A meeting recorded but never transcribed has nothing to copy. A name in
       the index with no link is the truth about it; omitting it would make the
       export disagree with the app. */
    const plan = exportPlan(project(), [item("meeting", "Recorded, never written up")]);
    const index = plan.ops.find((o) => o.path === "project.md");
    assert.ok(index?.op === "write" && /Recorded, never written up — .*nothing written yet/.test(index.text));
  });

  it("says a project is empty rather than writing a bare heading", () => {
    const index = exportPlan(project(), []).ops.find((o) => o.path === "project.md");
    assert.ok(index?.op === "write" && /This project is empty/.test(index.text));
  });

  it("counts what it wrote, so the caller reports the same thing", () => {
    const plan = exportPlan(project(), [
      item("paper", "a", { text: "x" }),
      item("paper", "b", { text: "y" }),
      item("chat", "c", { text: "z" }),
    ]);
    assert.deepEqual(plan.counts, [
      { kind: "paper", count: 2 },
      { kind: "chat", count: 1 },
    ]);
  });
});

describe("a conversation, made readable", () => {
  const messages = [
    { role: "system", content: "You are MyRA. Cite your sources." },
    { role: "user", content: "what did we decide about the budget?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "read_document" } }],
    },
    { role: "tool", content: "…forty thousand words of a fetched page…" },
    { role: "assistant", content: "You settled on two postdocs." },
  ];

  it("keeps the turns and drops MyRA's own instructions", () => {
    const out = renderSession("Budget", messages, AT.toISOString());
    assert.match(out, /^# Budget/);
    assert.match(out, /what did we decide about the budget\?/);
    assert.match(out, /You settled on two postdocs\./);
    // The system prompt is MyRA's, not the user's, and is hundreds of words.
    assert.doesNotMatch(out, /Cite your sources/);
  });

  it("records that a tool ran without inlining what it returned", () => {
    const out = renderSession("Budget", messages);
    assert.match(out, /\*\(used read_document\)\*/);
    // A fetched page is routinely longer than the whole conversation.
    assert.doesNotMatch(out, /forty thousand words/);
  });

  it("carries no reasoning, because a session never held any", () => {
    const out = renderSession("x", [
      { role: "assistant", content: "The answer." },
    ]);
    assert.doesNotMatch(out, /<think/);
    assert.match(out, /The answer\./);
  });

  it("says so rather than printing an empty turn", () => {
    const out = renderSession("x", [{ role: "user", content: "   " }]);
    assert.match(out, /\*\(nothing\)\*/);
  });
});
