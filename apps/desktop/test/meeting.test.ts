import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  audioBytes, deleteAudio, localDay, meetingId, MeetingError, MeetingRecorder, slugify, unknownSources,
} from "../src/main/meeting.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "karen-meetings-"));
}

function skipUnlessPipewire(): string | false {
  return spawnSync("pw-record", ["--help"], { stdio: "ignore" }).status === 0
    ? false
    : "pw-record is not available here";
}

test("a meeting id sorts chronologically and is safe as a directory name", () => {
  // Built from local calendar fields, so this is stated in local time: a
  // meeting must be filed under the day the person actually had it.
  const id = meetingId(new Date(2026, 7, 21, 14, 5, 33));
  assert.equal(id, "2026-08-21T14-05-33");
  // Colons are legal on Linux but ruin the path on every other system a vault
  // might sync to, and these directories are meant to be opened by hand.
  assert.ok(!id.includes(":"));
  assert.ok(meetingId(new Date(2026, 0, 2, 0, 0, 0)) < meetingId(new Date(2026, 0, 2, 0, 0, 1)));
});

test("an evening meeting is filed under today, not tomorrow", () => {
  // The bug this replaced: dates came from toISOString, so for anyone west of
  // Greenwich a 6pm meeting was filed under the next day — and looked for,
  // fruitlessly, under the day it happened.
  const evening = new Date(2026, 7, 21, 18, 30, 0);
  assert.equal(meetingId(evening).slice(0, 10), "2026-08-21");
  assert.equal(localDay(evening.toISOString()), "2026-08-21");
});

test("titles typed by a person survive being turned into a path", () => {
  assert.equal(slugify("Q3 Planning / Roadmap"), "q3-planning-roadmap");
  assert.equal(slugify("  Standup: 1:1 with Dana  "), "standup-1-1-with-dana");
  assert.equal(slugify("Café résumé"), "cafe-resume");
  assert.equal(slugify("🚀 launch 🚀"), "launch");
  // A title that is nothing but punctuation must not produce a path of dashes.
  assert.equal(slugify("///"), "");
  assert.equal(slugify(""), "");
  // Long titles are cut without leaving a trailing dash.
  const long = slugify("a".repeat(40) + " " + "b".repeat(40));
  assert.ok(long.length <= 60, `slug was ${long.length} long`);
  assert.ok(!long.endsWith("-"));
});

test("a system-audio track names an output device, and that counts as existing", async () => {
  // The bug this replaced: validation listed capture devices only, so the
  // system-audio track — which targets a sink, because pw-record records that
  // sink's monitor — was rejected for naming a device that plainly exists.
  const devices = async () => [
    { id: 56, name: "alsa_input.analog-stereo", description: "Mic" },
    { id: 55, name: "alsa_output.analog-stereo", description: "Speakers" },
  ];
  assert.deepEqual(await unknownSources([{ id: "them", label: "Everyone else", source: 55 }], devices), []);
});

test("a device that does not exist is caught before recording, not after", async () => {
  // pw-record does NOT fail on an unknown --target: it records the default
  // device instead. Without this check a stale sink-monitor id would capture
  // the microphone twice and the second voice would be an echo of the first.
  const sources = async () => [{ id: 56, name: "alsa_input.pci-0000_00_1b.0.analog-stereo", description: "Mic" }];
  assert.deepEqual(await unknownSources([{ id: "them", label: "Everyone else", source: 99 }], sources), ["Everyone else"]);
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: 56 }], sources), []);
  // By node name as well as by id.
  assert.deepEqual(
    await unknownSources([{ id: "me", label: "Me", source: "alsa_input.pci-0000_00_1b.0.analog-stereo" }], sources),
    [],
  );
  // The default device is always acceptable: there is nothing to check.
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me" }], sources), []);
});

test("an unverifiable device does not block a meeting", async () => {
  // A meeting missed cannot be recovered; a meeting recorded from the wrong
  // device usually can. So when the devices cannot be listed at all, record.
  const broken = async () => { throw new Error("pw-dump is not installed"); };
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: 7 }], broken), []);
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: 7 }], async () => []), []);
});

test("a meeting needs tracks, and they must be distinct", async () => {
  const root = scratch();
  try {
    const meeting = new MeetingRecorder({ root, listSources: async () => [] });
    await assert.rejects(() => meeting.start("Empty", []), MeetingError);
    await assert.rejects(
      () => meeting.start("Twice", [
        { id: "me", label: "Me" },
        { id: "me", label: "Me again" },
      ]),
      /duplicate track id/,
    );
    // Nothing was left on disk by either refusal.
    assert.deepEqual(readdirSync(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two tracks are recorded, kept, and described", { skip: skipUnlessPipewire() }, async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    const id = await meeting.start("Q3 Planning", [
      { id: "me", label: "Me" },
      { id: "them", label: "Everyone else" },
    ]);
    assert.ok(meeting.recording);
    assert.match(id, /^\d{4}-\d{2}-\d{2}T/);

    await new Promise((done) => setTimeout(done, 700));
    const record = await meeting.stop();

    assert.equal(meeting.recording, false, "the recorder must be reusable afterwards");
    assert.equal(record.tracks.length, 2, `failed tracks: ${JSON.stringify(record.failed)}`);
    assert.ok(record.seconds > 0.5 && record.seconds < 10, `seconds was ${record.seconds}`);
    assert.deepEqual(record.tracks.map((t) => t.id).sort(), ["me", "them"]);

    // The audio outlives the recording -- unlike dictation, which deletes it.
    const files = readdirSync(record.dir).sort();
    assert.deepEqual(files, ["me.wav", "meeting.json", "them.wav"]);
    for (const track of record.tracks) assert.ok(track.bytes > 64, `${track.id} was empty`);

    // The manifest is on disk before anything is transcribed, so an interrupted
    // meeting can still be found and picked up by hand.
    const manifest = JSON.parse(readFileSync(join(record.dir, "meeting.json"), "utf8"));
    assert.equal(manifest.title, "Q3 Planning");
    assert.equal(manifest.tracks.length, 2);
    assert.ok(record.dir.endsWith("-q3-planning"), `directory was ${record.dir}`);
  } finally {
    await meeting.discard().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting the audio keeps the work", { skip: skipUnlessPipewire() }, async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    await meeting.start("Retro", [{ id: "me", label: "Me" }]);
    await new Promise((done) => setTimeout(done, 500));
    const record = await meeting.stop();

    assert.ok((await audioBytes(record.dir)) > 64);
    assert.equal(await deleteAudio(record.dir), 1);
    assert.equal(await audioBytes(record.dir), 0);
    // The transcript and notes are the point of having had the meeting.
    assert.deepEqual(readdirSync(record.dir), ["meeting.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discarding a meeting leaves nothing behind", { skip: skipUnlessPipewire() }, async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    await meeting.start("Mistake", [{ id: "me", label: "Me" }]);
    await new Promise((done) => setTimeout(done, 300));
    await meeting.discard();
    assert.equal(meeting.recording, false);
    assert.deepEqual(readdirSync(root), [], "a discarded meeting must not linger on disk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two meetings cannot run at once", { skip: skipUnlessPipewire() }, async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    await meeting.start("First", [{ id: "me", label: "Me" }]);
    await assert.rejects(() => meeting.start("Second", [{ id: "me", label: "Me" }]), /already being recorded/);
  } finally {
    await meeting.discard().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the recordings folder follows the setting, not the value at startup", async () => {
  // The bug this replaced: the root was captured when the app started, so the
  // Settings field for it appeared to work and changed nothing until restart.
  const first = scratch();
  const second = scratch();
  let root = first;
  const meeting = new MeetingRecorder({ root: () => root, listSources: async () => [] });
  try {
    root = second;
    await meeting.start("Moved", [{ id: "me", label: "Me" }]).catch(() => {});
    if (meeting.recording) {
      assert.ok(meeting.dir?.startsWith(second), `recorded into ${meeting.dir}`);
      assert.deepEqual(readdirSync(first), [], "nothing should land in the old folder");
    }
  } finally {
    await meeting.discard().catch(() => {});
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
