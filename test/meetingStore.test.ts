/**
 * A meeting's directory is the record.
 *
 * The page's whole behaviour follows from what these functions report: which of
 * Transcribe / Take notes is offered, whether a failure is shown, and whether
 * the audio can still be used. So the cases that matter are the partial ones --
 * a meeting that was recorded and never transcribed, one transcribed and never
 * written up, one whose audio has been deleted since.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filingRoot, listMeetings, readState, writeState, writeTranscript, NOTES_MD,
} from "../src/core/meetings/store.ts";

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "myra-meetings-"));
}

async function record(dir: string, title: string, startedAt: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meeting.json"), JSON.stringify({
    id: "x", title, startedAt, endedAt: startedAt, seconds: 600, dir,
    tracks: [{ id: "me", label: "Me", path: join(dir, "me.wav"), bytes: 4, seconds: 600 }],
    failed: [],
  }));
  await writeFile(join(dir, "me.wav"), "RIFF");
}

test("a recorded meeting reports every stage it has not reached", async () => {
  const dir = await root();
  try {
    await record(join(dir, "a"), "Standup", "2026-08-26T09:00:00Z");
    const [only] = await listMeetings(dir);
    assert.ok(only);
    assert.equal(only.title, "Standup");
    assert.equal(only.transcribed, false);
    assert.equal(only.noted, false);
    assert.equal(only.hasAudio, true, "the audio is what makes Transcribe offerable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each stage's artifact is what marks it done", async () => {
  const dir = await root();
  const meeting = join(dir, "a");
  try {
    await record(meeting, "Standup", "2026-08-26T09:00:00Z");
    await writeTranscript(meeting, { lines: [], text: "hello" });
    assert.equal((await listMeetings(dir))[0]?.transcribed, true);
    assert.equal((await listMeetings(dir))[0]?.noted, false);

    await writeFile(join(meeting, NOTES_MD), "# Notes");
    assert.equal((await listMeetings(dir))[0]?.noted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleted audio is reported, not treated as a missing meeting", async () => {
  // "Delete the recording once a transcript exists" is a setting people turn
  // on. The meeting must stay in the list afterwards -- the notes are the point
  // -- with Transcribe no longer offered.
  const dir = await root();
  const meeting = join(dir, "a");
  try {
    await record(meeting, "Standup", "2026-08-26T09:00:00Z");
    await rm(join(meeting, "me.wav"));
    const [only] = await listMeetings(dir);
    assert.ok(only, "the meeting is still a meeting");
    assert.equal(only.hasAudio, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory with no meeting.json is skipped rather than guessed at", async () => {
  const dir = await root();
  try {
    await mkdir(join(dir, "not-a-meeting"), { recursive: true });
    await writeFile(join(dir, "not-a-meeting", "stray.wav"), "RIFF");
    assert.deepEqual(await listMeetings(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("meetings are newest first", async () => {
  const dir = await root();
  try {
    await record(join(dir, "a"), "Older", "2026-08-20T09:00:00Z");
    await record(join(dir, "b"), "Newer", "2026-08-26T09:00:00Z");
    assert.deepEqual((await listMeetings(dir)).map((m) => m.title), ["Newer", "Older"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state is merged, so one stage cannot erase another's record", async () => {
  const dir = await root();
  const meeting = join(dir, "a");
  try {
    await record(meeting, "Standup", "2026-08-26T09:00:00Z");
    await writeState(meeting, { instructions: "keep the objections" });
    await writeState(meeting, { transcribedAt: "2026-08-26T10:00:00Z" });
    const state = await readState(meeting);
    assert.equal(state.instructions, "keep the objections", "the per-meeting steer survives");
    assert.equal(state.transcribedAt, "2026-08-26T10:00:00Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing meeting reads as empty state rather than throwing", async () => {
  assert.deepEqual(await readState(join(tmpdir(), "myra-does-not-exist")), {});
});

/*
 * The filing bug this replaces: with no vault configured,
 * `resolve(join("", "MyRA"))` is `<working directory>/MyRA`, so meeting notes
 * were written next to whatever the app was launched from — inside the repo, in
 * development, and somewhere unwritable in a packaged build.
 */
test("with no vault, a meeting is filed in its own folder", () => {
  assert.equal(filingRoot("", "Meetings", "/home/me/meetings/x"), "/home/me/meetings/x");
  assert.equal(filingRoot("   ", "Meetings", "/home/me/meetings/x"), "/home/me/meetings/x");
});

test("with a vault, it is filed in the vault's subfolder", () => {
  assert.equal(filingRoot("/home/me/vault", "Meetings", "/tmp/x"), join("/home/me/vault", "Meetings"));
});
