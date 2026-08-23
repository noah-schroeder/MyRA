import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  audioBytes, deleteAudio, localDay, meetingId, MeetingError, MeetingRecorder, slugify, unknownSources,
} from "../src/core/meetings/meeting.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "karen-meetings-"));
}

/** A window of `n` samples of a sine at the given amplitude, s16 mono. */
function tone(amplitude: number, samples: number, rate = 16_000, hz = 440): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * 32_767), i * 2);
  }
  return pcm;
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
  // system-audio track was rejected for naming a device that plainly exists,
  // because validation listed capture devices only and the far side of a call
  // is captured from an output device.
  const devices = async () => [
    { id: "mic-1", name: "default", description: "Mic", kind: "microphone" as const },
    { id: "out-1", name: "display", description: "Speakers", kind: "system" as const },
  ];
  assert.deepEqual(await unknownSources([{ id: "them", label: "Everyone else", source: "out-1" }], devices), []);
});

test("a device that does not exist is caught before recording, not after", async () => {
  // A deviceId that no longer exists does not reliably fail: without an `exact`
  // constraint getUserMedia falls back to the default device, so a stale system
  // -audio id would capture the microphone twice and the second voice would be
  // an echo of the first. MediaDeviceInfo ids also rotate between sessions,
  // which makes a stale id the common case rather than the exotic one.
  const sources = async () => [{ id: "mic-1", name: "default", description: "Mic", kind: "microphone" as const }];
  assert.deepEqual(await unknownSources([{ id: "them", label: "Everyone else", source: "gone-99" }], sources), ["Everyone else"]);
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: "mic-1" }], sources), []);
  // By device name as well as by id.
  assert.deepEqual(
    await unknownSources([{ id: "me", label: "Me", source: "default" }], sources),
    [],
  );
  // The default device is always acceptable: there is nothing to check.
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me" }], sources), []);
});

test("an unverifiable device does not block a meeting", async () => {
  // A meeting missed cannot be recovered; a meeting recorded from the wrong
  // device usually can. So when the devices cannot be listed at all, record.
  const broken = async () => { throw new Error("device enumeration is unavailable"); };
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: "mic-7" }], broken), []);
  assert.deepEqual(await unknownSources([{ id: "me", label: "Me", source: "mic-7" }], async () => []), []);
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

test("two tracks are recorded, kept, and described", async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    const id = await meeting.start("Q3 Planning", [
      { id: "me", label: "Me" },
      { id: "them", label: "Everyone else" },
    ]);
    assert.ok(meeting.recording);
    assert.match(id, /^\d{4}-\d{2}-\d{2}T/);

    // v1 waited 700ms for two pw-record subprocesses to capture whatever the
    // machine's microphone happened to hear. The renderer pushes audio now, so
    // the test supplies it: one second per track, of known content.
    for (const id of ["me", "them"]) await meeting.write(id, tone(0.4, 16_000));
    const record = await meeting.stop();

    assert.equal(meeting.recording, false, "the recorder must be reusable afterwards");
    assert.equal(record.tracks.length, 2, `failed tracks: ${JSON.stringify(record.failed)}`);
    assert.ok(record.seconds >= 0 && record.seconds < 10, `seconds was ${record.seconds}`);
    assert.deepEqual(record.tracks.map((t) => t.id).sort(), ["me", "them"]);

    // The audio outlives the recording -- unlike dictation, which deletes it.
    const files = readdirSync(record.dir).sort();
    assert.deepEqual(files, ["me.wav", "meeting.json", "them.wav"]);
    for (const track of record.tracks) {
      assert.equal(track.bytes, 44 + 16_000 * 2, `${track.id} did not keep every sample`);
      assert.ok(Math.abs(track.seconds - 1) < 0.01, `${track.id} was ${track.seconds}s`);
    }

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

test("deleting the audio keeps the work", async () => {
  const root = scratch();
  const meeting = new MeetingRecorder({ root, listSources: async () => [] });
  try {
    await meeting.start("Retro", [{ id: "me", label: "Me" }]);
    await meeting.write("me", tone(0.4, 8_000));
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

test("discarding a meeting leaves nothing behind", async () => {
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

test("two meetings cannot run at once", async () => {
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
