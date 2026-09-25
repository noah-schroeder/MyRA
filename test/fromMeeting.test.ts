/**
 * A meeting's items, offered to its project's notes.
 *
 * The meeting already verified every item against its transcript; what is
 * pinned here is that nothing unverified is offered, actions stay tasks, each
 * candidate carries the meeting and the time the line was found at, and
 * pressing the button twice does not offer the same decision twice.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meetingCandidates } from "../src/core/projects/fromMeeting.ts";
import { addItems, newMemory } from "../src/core/projects/memory.ts";
import { readItems, writeItems } from "../src/core/meetings/store.ts";
import type { VerifiedItem } from "../src/core/meetings/notes.ts";

const item = (over: Partial<VerifiedItem>): VerifiedItem => ({
  project: "General", type: "decision", title: "Use interviews", owner: null, due: null,
  quote: "we'll go with interviews", certain: true, at: "00:12:40", sourcing: "verbatim",
  sourceText: "OK, we'll go with interviews then.", ...over,
});

describe("meeting items as candidate notes", () => {
  it("maps each kind to its field, keeps the found line and its time, and leaves actions to tasks", () => {
    const got = meetingCandidates(
      newMemory(),
      [
        item({}),
        item({ type: "question", title: "Which wards?" }),
        item({ type: "risk", title: "Ethics approval may slip" }),
        item({ type: "update", title: "Pilot finished" }),
        item({ type: "action", title: "Email the ethics board" }),
      ],
      "20260910-1400-supervision",
    );
    assert.deepEqual(got.map((c) => [c.slot, c.text]), [
      ["decisions", "Use interviews"],
      ["open", "Which wards?"],
      ["open", "Risk: Ethics approval may slip"],
      ["context", "Pilot finished"],
    ]);
    assert.equal(got[0]!.quote, "OK, we'll go with interviews then.");
    assert.equal(got[0]!.meeting, "20260910-1400-supervision");
    assert.equal(got[0]!.meetingAt, "00:12:40");
  });

  it("never offers what the transcript did not hold", () => {
    assert.equal(meetingCandidates(newMemory(), [item({ sourcing: "unverified" })], "m").length, 0);
  });

  it("does not offer a decision the notes already hold, or the same one twice", () => {
    const memory = addItems(newMemory(), [{ slot: "decisions", text: "use interviews" }], "you");
    assert.equal(meetingCandidates(memory, [item({})], "m").length, 0);
    assert.equal(meetingCandidates(newMemory(), [item({}), item({ quote: "again" })], "m").length, 1);
  });
});

describe("the items a notes run keeps", () => {
  it("round-trip, and a meeting noted before they were kept reads as none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myra-meeting-"));
    assert.equal(await readItems(dir), undefined);
    await writeItems(dir, [item({}), item({ type: "question", title: "Which wards?" })]);
    assert.deepEqual((await readItems(dir))?.map((i) => i.title), ["Use interviews", "Which wards?"]);
  });
});
