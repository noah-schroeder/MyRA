/**
 * A project's notes over time: where each one came from, and what happens when
 * the researcher changes their mind.
 *
 * Two promises are pinned here. A closed note is never deleted -- it leaves the
 * prompt and stays in the history, because how a decision changed is what a
 * methods section gets asked about. And an automatic write still never changes
 * what a person wrote or approved: it may close another automatic note, but a
 * person's note only ever receives a suggestion the project page asks about.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  acceptSuggestion, addAuto, addItems, dismissSuggestion, isActive, newMemory, parseMemory,
  pendingSuggestions, renderDecisionLog, renderMemory, renderMemoryMarkdown, reopen, resolve, supersede,
  type MemoryItem, type ProjectMemory,
} from "../src/core/projects/memory.ts";
import {
  buildUpdatePrompt, groundProposals, notePass, parseProposals, toAutoItems,
} from "../src/core/projects/memoryUpdate.ts";
import { resumeDigest } from "../src/core/projects/resume.ts";
import type { ChatMessage } from "../src/core/llm/chat.ts";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const T0 = new Date("2026-09-01T10:00:00Z");
const T1 = new Date("2026-09-10T10:00:00Z");

function withNote(slot: MemoryItem["slot"], text: string, source: "you" | "setup" | "auto"): ProjectMemory {
  if (source === "auto") return addAuto(newMemory(), [{ slot, text }], "s0", T0);
  return addItems(newMemory(), [{ slot, text }], source, T0);
}

const byText = (memory: ProjectMemory, text: string): MemoryItem => {
  const found = memory.items.find((it) => it.text === text);
  assert.ok(found, `no note "${text}"`);
  return found;
};

describe("reading history back off disk", () => {
  it("keeps provenance, status and links, and drops what is malformed", () => {
    const memory = parseMemory({
      items: [
        {
          id: "a", slot: "decisions", text: "Use surveys.", source: "auto", at: "2026-09-01T00:00:00Z",
          from: "s1", quote: "let's use surveys", msg: 3, status: "superseded", closedAt: "2026-09-02T00:00:00Z", by: "b",
        },
        { id: "b", slot: "decisions", text: "Use interviews.", source: "you", at: "2026-09-02T00:00:00Z", supersedes: "a" },
        { id: "c", slot: "literature", text: "Bandura 1977.", source: "you", at: "x", msg: -1, status: "gone", suggests: { replaces: "" } },
      ],
    });
    assert.equal(memory.items.length, 3);
    const [a, b, c] = memory.items as [MemoryItem, MemoryItem, MemoryItem];
    assert.equal(a.quote, "let's use surveys");
    assert.equal(a.msg, 3);
    assert.equal(a.status, "superseded");
    assert.equal(a.by, "b");
    assert.equal(b.supersedes, "a");
    assert.equal(c.slot, "literature");
    assert.equal(c.msg, undefined, "a negative message index is not trusted");
    assert.equal(c.status, undefined, "an unknown status reads as current, not as closed");
    assert.equal(c.suggests, undefined);
  });

  it("an old file with none of the new fields reads exactly as before", () => {
    const raw = { items: [{ id: "a", slot: "aims", text: "Understand X.", source: "you", at: "2026-01-01T00:00:00Z" }] };
    assert.deepEqual(parseMemory(raw).items, raw.items);
  });
});

describe("replacing a note by hand", () => {
  it("closes the old note and adds the new one as the person's own, linked both ways", () => {
    const start = withNote("decisions", "Use surveys.", "setup");
    const old = start.items[0]!;
    const next = supersede(start, old.id, "Use interviews.", T1);
    const closed = byText(next, "Use surveys.");
    const current = byText(next, "Use interviews.");
    assert.equal(closed.status, "superseded");
    assert.equal(closed.by, current.id);
    assert.equal(closed.closedAt, T1.toISOString());
    assert.equal(current.supersedes, closed.id);
    assert.equal(current.source, "you");
    assert.equal(current.slot, "decisions");
  });

  it("the closed note leaves the prompt and the notes export, and stays in storage", () => {
    const start = withNote("decisions", "Use surveys.", "you");
    const next = supersede(start, start.items[0]!.id, "Use interviews.");
    assert.doesNotMatch(renderMemory(next).text, /surveys/);
    assert.match(renderMemory(next).text, /interviews/);
    assert.doesNotMatch(renderMemoryMarkdown(next), /surveys/);
    assert.equal(next.items.length, 2);
  });

  it("does nothing for a note already closed, or with blank text", () => {
    const start = withNote("decisions", "Use surveys.", "you");
    const once = supersede(start, start.items[0]!.id, "Use interviews.");
    assert.equal(supersede(once, start.items[0]!.id, "Use focus groups."), once);
    assert.equal(supersede(start, start.items[0]!.id, "   "), start);
  });

  it("reopen puts it back and clears the links on both sides", () => {
    const start = withNote("decisions", "Use surveys.", "you");
    const next = supersede(start, start.items[0]!.id, "Use interviews.");
    const back = reopen(next, start.items[0]!.id);
    assert.ok(isActive(byText(back, "Use surveys.")));
    assert.equal(byText(back, "Use surveys.").by, undefined);
    assert.equal(byText(back, "Use interviews.").supersedes, undefined);
  });
});

describe("answering an open question", () => {
  it("with a new decision in the person's words", () => {
    const start = withNote("open", "Which sampling frame?", "you");
    const next = resolve(start, start.items[0]!.id, { text: "Sample from the national register." }, T1);
    const open = byText(next, "Which sampling frame?");
    const answer = byText(next, "Sample from the national register.");
    assert.equal(open.status, "resolved");
    assert.equal(open.by, answer.id);
    assert.equal(answer.slot, "decisions");
    assert.equal(answer.resolves, open.id);
  });

  it("by a note that already exists, or by nothing in particular", () => {
    let memory = withNote("open", "Which sampling frame?", "you");
    memory = addItems(memory, [{ slot: "decisions", text: "Use the register." }], "you");
    const byExisting = resolve(memory, memory.items[0]!.id, { id: memory.items[1]!.id });
    assert.equal(byText(byExisting, "Which sampling frame?").by, memory.items[1]!.id);
    const plain = resolve(memory, memory.items[0]!.id, undefined);
    assert.equal(byText(plain, "Which sampling frame?").status, "resolved");
    assert.equal(byText(plain, "Which sampling frame?").by, undefined);
  });
});

describe("an automatic note that replaces another", () => {
  it("closes an automatic note on the spot -- nobody wrote that one", () => {
    const start = withNote("decisions", "Use surveys.", "auto");
    const next = addAuto(start, [{ slot: "decisions", text: "Use interviews.", replaces: start.items[0]!.id }], "s1", T1);
    assert.equal(byText(next, "Use surveys.").status, "superseded");
    assert.equal(byText(next, "Use interviews.").supersedes, start.items[0]!.id);
    assert.equal(pendingSuggestions(next).length, 0);
  });

  it("saves under the given source, defaulting to auto", () => {
    const auto = addAuto(newMemory(), [{ slot: "aims", text: "Understand adoption." }], "s1", T0);
    assert.equal(byText(auto, "Understand adoption.").source, "auto");

    const reviewed = addAuto(newMemory(), [{ slot: "aims", text: "Understand adoption." }], "s1", T0, "you");
    assert.equal(byText(reviewed, "Understand adoption.").source, "you");
  });

  it("never touches a note a person wrote or approved -- it only suggests", () => {
    for (const source of ["you", "setup"] as const) {
      const start = withNote("decisions", "Use surveys.", source);
      const next = addAuto(start, [{ slot: "decisions", text: "Use interviews.", replaces: start.items[0]!.id }], "s1");
      assert.deepEqual(byText(next, "Use surveys."), start.items[0], `a ${source} note must be byte-for-byte untouched`);
      assert.deepEqual(byText(next, "Use interviews.").suggests, { replaces: start.items[0]!.id });
      const pending = pendingSuggestions(next);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.target.text, "Use surveys.");
    }
  });

  it("accepting applies it; dismissing keeps both and ends the question", () => {
    const start = withNote("decisions", "Use surveys.", "you");
    const next = addAuto(start, [{ slot: "decisions", text: "Use interviews.", replaces: start.items[0]!.id }], "s1");
    const newer = byText(next, "Use interviews.");

    const accepted = acceptSuggestion(next, newer.id);
    assert.equal(byText(accepted, "Use surveys.").status, "superseded");
    assert.equal(byText(accepted, "Use interviews.").suggests, undefined);
    assert.equal(byText(accepted, "Use interviews.").supersedes, start.items[0]!.id);

    const dismissed = dismissSuggestion(next, newer.id);
    assert.ok(isActive(byText(dismissed, "Use surveys.")));
    assert.equal(byText(dismissed, "Use interviews.").suggests, undefined);
    assert.equal(pendingSuggestions(dismissed).length, 0);
  });

  it("a claim on a note in another slot, or one already closed, is ignored", () => {
    const start = withNote("aims", "Understand adoption.", "auto");
    const next = addAuto(start, [{ slot: "decisions", text: "Use interviews.", replaces: start.items[0]!.id }], "s1");
    assert.ok(isActive(byText(next, "Understand adoption.")));
    assert.equal(byText(next, "Use interviews.").suggests, undefined);
  });

  it("answers an automatic open question, and only suggests answering a person's", () => {
    const auto = withNote("open", "Which frame?", "auto");
    const a = addAuto(auto, [{ slot: "decisions", text: "The register.", resolves: auto.items[0]!.id }], "s1");
    assert.equal(byText(a, "Which frame?").status, "resolved");

    const mine = withNote("open", "Which frame?", "you");
    const b = addAuto(mine, [{ slot: "decisions", text: "The register.", resolves: mine.items[0]!.id }], "s1");
    assert.ok(isActive(byText(b, "Which frame?")));
    assert.deepEqual(byText(b, "The register.").suggests, { resolves: mine.items[0]!.id });
  });

  it("a reverted decision is not a duplicate of the note it replaced", () => {
    let memory = withNote("decisions", "Use surveys.", "auto");
    memory = addAuto(memory, [{ slot: "decisions", text: "Use interviews.", replaces: memory.items[0]!.id }], "s1");
    const interviews = byText(memory, "Use interviews.");
    memory = addAuto(memory, [{ slot: "decisions", text: "Use surveys.", replaces: interviews.id }], "s1");
    assert.equal(memory.items.filter((it) => it.text === "Use surveys.").length, 2);
    assert.equal(memory.items.filter((it) => isActive(it)).map((it) => it.text).join(), "Use surveys.");
  });

  it("closing an auto-sourced replaces target does not erase a pending resolves suggestion on the same item", () => {
    let memory = withNote("decisions", "Use surveys.", "auto");
    memory = addItems(memory, [{ slot: "open", text: "Which register?" }], "you");
    const survey = byText(memory, "Use surveys.");
    const question = byText(memory, "Which register?");

    /* One proposal claims both: it replaces the auto-sourced decision (closed
       on the spot) and resolves the person's open question (only suggested).
       The replaces side must not wipe the resolves side off the same item. */
    memory = addAuto(
      memory,
      [{ slot: "decisions", text: "Use interviews.", replaces: survey.id, resolves: question.id }],
      "s1",
    );

    assert.equal(byText(memory, "Use surveys.").status, "superseded", "the auto note closes on the spot");
    assert.ok(isActive(byText(memory, "Which register?")), "the person's open question is only suggested");

    const interviews = byText(memory, "Use interviews.");
    assert.equal(interviews.supersedes, survey.id);
    assert.deepEqual(interviews.suggests, { resolves: question.id }, "the resolves suggestion must survive");

    const pending = pendingSuggestions(memory);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "resolves");
    assert.equal(pending[0]!.target.text, "Which register?");
  });
});

describe("grounding keeps its evidence", () => {
  it("returns the quote and the message it was found in", () => {
    const messages = [user("hello"), assistant("hi"), user("We will use grounded theory for the analysis.")];
    const [item] = groundProposals(
      [{ slot: "methods", text: "Grounded theory.", quote: "We will use grounded theory", confirmation: "" }],
      messages,
    );
    assert.equal(item!.msg, 2);
    assert.equal(item!.quote, "We will use grounded theory");
  });

  it("a reconstructed quote is replaced by the line actually found", () => {
    const line = "Great, we are going to use grounded theory for the whole analysis, I think.";
    const [item] = groundProposals(
      [{ slot: "methods", text: "Grounded theory.", quote: "we will use grounded theory for the whole analysis", confirmation: "" }],
      [user(line)],
    );
    assert.equal(item!.quote, line);
  });

  it("a confirmed proposal points at the assistant message that made it", () => {
    const messages = [user("Which theory?"), assistant("I suggest using UTAUT for this."), user("yes, go with that")];
    const [item] = groundProposals(
      [{ slot: "theory", text: "UTAUT.", quote: "I suggest using UTAUT for this.", confirmation: "yes, go with that" }],
      messages,
    );
    assert.equal(item!.msg, 1);
  });
});

describe("the pass that notices a change of mind", () => {
  it("numbers the current notes, and turns a number back into the right id", () => {
    let memory = withNote("aims", "Understand adoption.", "you");
    memory = addItems(memory, [{ slot: "decisions", text: "Use surveys." }], "you");
    memory = supersede(memory, memory.items[1]!.id, "Use a mixed design.");
    const prompt = buildUpdatePrompt(memory, [user("hi")], 0);
    assert.match(prompt, /#1 \(Aims\) Understand adoption\./);
    assert.match(prompt, /#2 \(Decisions\) Use a mixed design\./);
    assert.doesNotMatch(prompt, /Use surveys/, "a closed note is not offered to be replaced again");
    const [auto] = toAutoItems(memory, [{ slot: "decisions", text: "x", quote: "q", msg: 0, replaces: 2 }]);
    assert.equal(auto!.replaces, byText(memory, "Use a mixed design.").id);
    const [none] = toAutoItems(memory, [{ slot: "decisions", text: "x", quote: "q", msg: 0, replaces: 9 }]);
    assert.equal(none!.replaces, undefined, "a number that names no note is dropped, never guessed");
  });

  it("reads note numbers forgivingly: 0 is none, '#2' is 2", () => {
    const parsed = parseProposals(
      JSON.stringify({
        proposals: [
          { slot: "decisions", text: "a", quote: "a", replaces: 0, resolves: 0 },
          { slot: "decisions", text: "b", quote: "b", replaces: "#2" },
        ],
      }),
    );
    assert.equal(parsed![0]!.replaces, undefined);
    assert.equal(parsed![0]!.resolves, undefined);
    assert.equal(parsed![1]!.replaces, 2);
  });

  it("end to end: 'actually, interviews' closes the automatic survey note and says so", async () => {
    let memory = withNote("decisions", "The project will use surveys.", "auto");
    memory = { ...memory, seen: { s1: 1 } };
    const messages = [user("let's use surveys"), assistant("OK."), user("actually, let's do interviews instead")];
    const pass = await notePass(memory, messages, "s1", async () =>
      JSON.stringify({
        proposals: [{ slot: "decisions", text: "The project will use interviews.", quote: "let's do interviews instead", replaces: 1 }],
      }),
    );
    assert.ok(pass);
    assert.equal(pass.added.length, 1);
    assert.equal(pass.added[0]!.quote, "let's do interviews instead");
    assert.equal(pass.added[0]!.msg, 2);
    assert.equal(pass.closed.length, 1);
    assert.equal(pass.closed[0]!.text, "The project will use surveys.");
    assert.doesNotMatch(renderMemory(pass.memory).text, /surveys/);
  });

  it("the reviewed button closes what the unattended pass would, saved as the person's own", () => {
    /* "Update project notes from this chat" grounds the same way notePass
       does, but folds the result in with addAuto(..., "you") instead of
       addItems -- addItems has no replaces/resolves field at all, so the old
       code silently left the superseded note standing. */
    let memory = withNote("decisions", "The project will use surveys.", "auto");
    const messages = [user("let's use surveys"), assistant("OK."), user("actually, let's do interviews instead")];
    const grounded = groundProposals(
      [{ slot: "decisions", text: "The project will use interviews.", quote: "let's do interviews instead", confirmation: "", replaces: 1 }],
      messages,
    );
    memory = addAuto(memory, toAutoItems(memory, grounded), "s1", T1, "you");

    assert.equal(byText(memory, "The project will use surveys.").status, "superseded");
    const interviews = byText(memory, "The project will use interviews.");
    assert.equal(interviews.source, "you");
    assert.equal(interviews.supersedes, memory.items[0]!.id);
  });
});

describe("the decision log", () => {
  it("is empty for a project with no notes", () => {
    assert.equal(renderDecisionLog(newMemory(), () => undefined), "");
  });

  it("lists every note oldest first, closed ones included, with where each came from", () => {
    let memory = addItems(newMemory(), [{ slot: "decisions", text: "Use surveys.", quote: "surveys it is", from: "s1" }], "you", T0);
    memory = supersede(memory, memory.items[0]!.id, "Use interviews.", T1);
    const log = renderDecisionLog(memory, (it) => (it.from === "s1" ? "in “Kickoff chat”" : undefined));
    assert.ok(log.indexOf("Use surveys.") < log.indexOf("Use interviews."));
    assert.match(log, /Use surveys\. \*\(replaced\)\*/);
    assert.match(log, /added by you, in “Kickoff chat”/);
    assert.match(log, /rests on: “surveys it is”/);
    assert.match(log, /replaced by “Use interviews\.” on 10 September 2026/);
    assert.match(log, /replaced: “Use surveys\.”/);
  });
});

describe("where you left off", () => {
  const rows = [
    { kind: "chat" as const, ref: "c1", title: "Old chat", at: "2026-09-01T09:00:00Z" },
    { kind: "run" as const, ref: "r1", title: "Lit sweep", at: "2026-09-12T09:00:00Z" },
  ];

  it("counts only what arrived after the last visit, and still lists open questions", () => {
    let memory = addItems(newMemory(), [{ slot: "open", text: "Which frame?" }], "you", T0);
    memory = addItems(memory, [{ slot: "aims", text: "Understand adoption." }], "you", T1);
    const digest = resumeDigest(memory, rows, "2026-09-05T00:00:00Z");
    assert.deepEqual(digest.newNotes.map((n) => n.text), ["Understand adoption."]);
    assert.deepEqual(digest.newWork.map((r) => r.title), ["Lit sweep"]);
    assert.deepEqual(digest.openQuestions.map((n) => n.text), ["Which frame?"]);
    assert.equal(digest.empty, false);
  });

  it("the first visit claims nothing is new -- there is no 'since' to be new after", () => {
    const memory = addItems(newMemory(), [{ slot: "aims", text: "Understand adoption." }], "you", T1);
    const digest = resumeDigest(memory, rows, undefined);
    assert.equal(digest.newNotes.length, 0);
    assert.equal(digest.newWork.length, 0);
    assert.equal(digest.empty, true);
  });

  it("counts suggestions waiting on a person", () => {
    const start = withNote("decisions", "Use surveys.", "you");
    const memory = addAuto(start, [{ slot: "decisions", text: "Use interviews.", replaces: start.items[0]!.id }], "s1");
    assert.equal(resumeDigest(memory, [], undefined).waiting, 1);
  });
});
