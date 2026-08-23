import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTracks } from "../src/main/meeting.ts";
import { duration, noteName, renderReport, renderTranscript } from "../src/main/meetingRun.ts";
import type { MeetingRecord } from "../src/main/meeting.ts";
import type { MeetingNotes } from "../src/main/notes.ts";

const sink = { id: 55, name: "alsa_output.analog-stereo", description: "Built-in Audio" };

test("the microphone alone is not enough for a remote meeting", () => {
  // Wearing headphones, a mic-only recording contains the user and nobody else.
  const both = defaultTracks({ systemAudio: true, sink });
  assert.deepEqual(both.map((t) => t.id), ["me", "them"]);
  assert.equal(both[1]!.source, 55);

  // Turned off, or no output device at all: record what there is, do not fail.
  assert.deepEqual(defaultTracks({ systemAudio: false, sink }).map((t) => t.id), ["me"]);
  assert.deepEqual(defaultTracks({ systemAudio: true, sink: undefined }).map((t) => t.id), ["me"]);
});

test("a chosen microphone is used, and the default needs no setting", () => {
  assert.equal(defaultTracks({ source: "42", sink: undefined })[0]!.source, "42");
  assert.equal(defaultTracks({ sink: undefined })[0]!.source, undefined);
});

const record: MeetingRecord = {
  id: "2026-08-21T14-05-33",
  title: "Weekly project sync",
  startedAt: "2026-08-21T14:05:33.000Z",
  endedAt: "2026-08-21T15:02:10.000Z",
  seconds: 3397,
  dir: "/home/u/Documents/karen/meetings/2026-08-21T14-05-33-weekly-project-sync",
  tracks: [],
  failed: [],
};

test("the note is named for the day and the meeting, not for a timestamp", () => {
  assert.equal(noteName(record), "2026-08-21-weekly-project-sync");
  // An untitled meeting still gets a usable name rather than a bare dash.
  assert.equal(noteName({ ...record, dir: "/x/2026-08-21T14-05-33" }), "2026-08-21");
});

test("durations read as durations", () => {
  assert.equal(duration(3397), "57m");
  assert.equal(duration(3600), "1h");
  assert.equal(duration(5400), "1h 30m");
  // A meeting shorter than a minute is not "0m".
  assert.equal(duration(20), "1m");
});

const notes: MeetingNotes = {
  markdown: "## Falcon\n\nPostgres was chosen for the canary rollout.",
  items: [
    { project: "Falcon", type: "decision", title: "Postgres for the canary", owner: null, due: null, quote: "let's go with Postgres", certain: true, at: "00:01:30", sourcing: "verbatim", sourceText: "Then let's go with Postgres for the canary rollout.", speaker: "Me" },
    { project: "Redshift", type: "action", title: "Get the budget approved", owner: "Priya", due: "Wednesday", quote: "I'll have the budget approved by Wednesday.", certain: true, at: null, sourcing: "unverified" },
  ],
  actions: [],
};

test("the report separates what was sourced from what was not", () => {
  const md = renderReport(record, notes, "Meetings/2026-08-21-weekly-project-sync — transcript");

  assert.match(md, /^---\ntitle: "Weekly project sync"/);
  assert.match(md, /duration: 57m/);
  assert.match(md, /Postgres was chosen for the canary rollout/);
  assert.match(md, /\[\[Meetings\/2026-08-21-weekly-project-sync — transcript\|full transcript\]\]/);

  // The honest part: an item whose quote is not in the transcript is shown
  // apart and labelled, never folded in as though it were established.
  assert.match(md, /## Unverified/);
  assert.match(md, /Get the budget approved/);
  const unverifiedAt = md.indexOf("## Unverified");
  assert.ok(md.indexOf("Get the budget approved") > unverifiedAt, "an unverified item must not appear above the warning");
});

test("a report with nothing unverified says nothing about it", () => {
  const clean = { ...notes, items: [notes.items[0]!] };
  assert.ok(!renderReport(record, clean, "t").includes("## Unverified"));
});

test("a title with quotes in it cannot break the front matter", () => {
  // Front matter is parsed by Obsidian; an unescaped quote makes the note
  // unreadable to every tool that reads it.
  const md = renderReport({ ...record, title: 'The "big" sync: part 2' }, notes, "t");
  assert.match(md, /title: "The \\"big\\" sync: part 2"/);
});

test("the transcript file says plainly what it is", () => {
  const md = renderTranscript(record, "[00:00:01] Hello.");
  assert.match(md, /unedited and unattributed/);
  assert.match(md, /```text\n\[00:00:01\] Hello\.\n```/);
});
