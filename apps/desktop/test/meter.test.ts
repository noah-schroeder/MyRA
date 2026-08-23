import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  CLIP_AMPLITUDE, levelOf, meterScale, pcmStart, SILENCE_AMPLITUDE, smooth,
} from "../src/main/meter.ts";

/** A window of `n` samples of a sine at the given amplitude, s16 mono. */
function tone(amplitude: number, samples = 1600, rate = 16_000, hz = 440): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * 32_767), i * 2);
  }
  return pcm;
}

function wav(dataBytes: number, extraChunk = false): Buffer {
  const chunks: Buffer[] = [];
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0);
  riff.write("WAVE", 8);
  chunks.push(riff);

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  chunks.push(fmt);

  if (extraChunk) {
    // An odd-sized chunk, which must be followed by a pad byte.
    const list = Buffer.alloc(8 + 5 + 1);
    list.write("LIST", 0);
    list.writeUInt32LE(5, 4);
    chunks.push(list);
  }

  const data = Buffer.alloc(8);
  data.write("data", 0);
  data.writeUInt32LE(dataBytes, 4);
  chunks.push(data, Buffer.alloc(dataBytes));
  return Buffer.concat(chunks);
}

test("the payload offset is found by walking the chunks, not assumed", () => {
  // pw-record's canonical header.
  assert.equal(pcmStart(wav(100)), 44);
  // Anything else still lands on the audio rather than on chunk bytes, which
  // would be read as a loud noise the microphone never made.
  assert.equal(pcmStart(wav(100, true)), 58);
});

test("a header that is not there yet reports as not ready", () => {
  assert.equal(pcmStart(Buffer.alloc(0)), -1);
  assert.equal(pcmStart(Buffer.alloc(8)), -1);
  assert.equal(pcmStart(Buffer.from("not a wav file at all")), -1);
  // Header present but truncated before the data chunk: still not ready.
  assert.equal(pcmStart(wav(100).subarray(0, 30)), -1);
});

test("levels match the signal", () => {
  const level = levelOf(tone(0.25));
  assert.ok(Math.abs(level.peak - 0.25) < 0.01, `peak was ${level.peak}`);
  // RMS of a sine is its amplitude over root two.
  assert.ok(Math.abs(level.rms - 0.25 / Math.SQRT2) < 0.01, `rms was ${level.rms}`);
});

test("digital silence measures as silence", () => {
  const level = levelOf(Buffer.alloc(3200));
  assert.equal(level.peak, 0);
  assert.equal(level.rms, 0);
  assert.ok(level.peak < SILENCE_AMPLITUDE, "a dead microphone must trip the warning");
});

test("a quiet but working microphone is not called silent", () => {
  // -40 dBFS: audible speech from across a room, well under the warning.
  const level = levelOf(tone(0.01));
  assert.ok(level.peak > SILENCE_AMPLITUDE, "a working microphone must not be reported dead");
});

test("full-scale input registers as clipping", () => {
  assert.ok(levelOf(tone(1.0)).peak >= CLIP_AMPLITUDE);
  assert.ok(levelOf(tone(0.5)).peak < CLIP_AMPLITUDE);
});

test("an odd trailing byte is ignored rather than read as a sample", () => {
  const pcm = tone(0.25);
  const odd = Buffer.concat([pcm, Buffer.from([0x7f])]);
  assert.deepEqual(levelOf(odd), levelOf(pcm));
});

test("an empty window is not a division by zero", () => {
  assert.deepEqual(levelOf(Buffer.alloc(0)), { peak: 0, rms: 0 });
  assert.deepEqual(levelOf(Buffer.alloc(1)), { peak: 0, rms: 0 });
});

test("the scale is decibel, so ordinary speech fills a visible share of the bar", () => {
  // The whole point of the mapping: -20 dBFS is 0.1 linear, which on a linear
  // bar would be a tenth of the width and would look like a broken meter.
  const speech = meterScale(0.1);
  assert.ok(speech > 0.6 && speech < 0.75, `speech drew ${speech}`);
  assert.equal(meterScale(1), 1);
  assert.equal(meterScale(0), 0);
  // Below the floor the bar is empty rather than negative.
  assert.equal(meterScale(0.0001), 0);
  assert.equal(meterScale(-1), 0);
});

test("the scale rises monotonically", () => {
  let previous = -1;
  for (const amplitude of [0, 0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 1]) {
    const value = meterScale(amplitude);
    assert.ok(value >= previous, `${amplitude} went backwards`);
    previous = value;
  }
});

test("ballistics are fast to rise and slow to fall", () => {
  // A rise is shown at once: a late meter is a lying meter.
  assert.equal(smooth(0.1, 0.9), 0.9);
  // A fall decays, so the eye can follow it.
  const fell = smooth(0.9, 0);
  assert.ok(fell > 0 && fell < 0.9, `fell to ${fell}`);
  // And it does reach the bottom rather than hanging just above it.
  let level = 0.9;
  for (let i = 0; i < 40; i++) level = smooth(level, 0);
  assert.ok(level < 0.01, `still at ${level} after four seconds of silence`);
});

/**
 * The tail itself, against a real recorder.
 *
 * The maths above can be right while the plumbing is wrong -- reading the
 * header as audio, or never advancing the offset -- and neither shows up in a
 * pure test. This one records for real. It cannot assert a *level*, because
 * whether this machine's microphone hears anything is not up to the test, but
 * it does assert that readings arrive, stay in range, and advance.
 */
test("levels can be read from a recording as it is being written", { skip: skipUnlessPipewire() }, async () => {
  const { Recorder } = await import("../src/main/audio.ts");
  const recorder = new Recorder();
  await recorder.start({});
  try {
    const readings = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((done) => setTimeout(done, 120));
      const level = await recorder.level();
      if (level) readings.push(level);
    }
    assert.ok(readings.length >= 3, `only ${readings.length} readings in 720 ms`);
    for (const level of readings) {
      assert.ok(level.peak >= 0 && level.peak <= 1, `peak out of range: ${level.peak}`);
      assert.ok(level.rms >= 0 && level.rms <= level.peak + 1e-9, `rms ${level.rms} above peak ${level.peak}`);
    }
  } finally {
    await recorder.cancel();
  }
  // The meter must not outlive the recording; a stale read would report the
  // level of audio that is no longer being captured.
  assert.equal(await recorder.level(), undefined);
});

function skipUnlessPipewire(): string | false {
  const found = spawnSync("pw-record", ["--help"], { stdio: "ignore" }).status === 0;
  return found ? false : "pw-record is not available here";
}

/* ---- what the bar actually draws ---- */

test("the bar spans the full range and nothing beyond it", async () => {
  const { litSegments, SEGMENTS } = await import("../src/renderer/components/meterBars.ts");
  assert.equal(litSegments(0), 0);
  assert.equal(litSegments(1), SEGMENTS);
  assert.equal(litSegments(0.5), SEGMENTS / 2);
  // A level out of range must clamp, not draw a negative or overflowing bar.
  assert.equal(litSegments(-0.5), 0);
  assert.equal(litSegments(2), SEGMENTS);
  assert.equal(litSegments(Number.NaN), 0);
});

test("only the top of the scale is coloured as too loud", async () => {
  const { segmentClass, SEGMENTS } = await import("../src/renderer/components/meterBars.ts");
  const all = SEGMENTS;
  // Someone speaking normally lights two thirds of the bar; none of it should
  // be the colour that means "turn it down".
  const speech = Math.round(0.67 * SEGMENTS);
  for (let i = 0; i < speech; i++) {
    assert.ok(!segmentClass(i, speech).includes("hot"), `segment ${i} was red at ordinary speech`);
  }
  assert.ok(segmentClass(all - 1, all).includes("hot"));
  assert.ok(segmentClass(all - 3, all).includes("warm"));
  assert.ok(!segmentClass(all - 3, all).includes("hot"));
});

test("clipping is shown even when the averaged level did not reach the top", async () => {
  const { segmentClass, SEGMENTS } = await import("../src/renderer/components/meterBars.ts");
  // One sample at full scale between two readings still means distortion.
  const quiet = 2;
  assert.ok(segmentClass(SEGMENTS - 1, quiet, true).includes("clip"));
  assert.ok(!segmentClass(SEGMENTS - 1, quiet, false).includes("clip"));
  // ...and it does not paint the whole bar red.
  assert.ok(!segmentClass(0, quiet, true).includes("clip"));
});
