/**
 * The container the voice model's audio actually needs.
 *
 * Reported twice. First the reply would not play at all; asking for WAV
 * instead of MP3 was the obvious fix and produced the same failure with a
 * better message: "That audio could not be played: the voice model returned
 * audio/wav". The bytes say why -- measured on the local daemon's own
 * `response_format: "wav"`:
 *
 *     fmt  audioFormat: 3   bitsPerSample: 32   sampleRate: 24000
 *     RIFF size: 4294967295      data size: 4294967295
 *
 * Float32 samples, which Chromium's WAV decoder does not take, under the size
 * placeholders a streaming writer never goes back to patch.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_PCM, floatToInt16, isRawPcm, rateFrom, repairWav, wavFromPcm,
} from "../src/core/audio/wav.ts";

const ascii = (b: Uint8Array, at: number, text: string): boolean =>
  String.fromCharCode(...b.subarray(at, at + text.length)) === text;
const u32 = (b: Uint8Array, at: number): number =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const u16 = (b: Uint8Array, at: number): number =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, true);

/** A WAV shaped exactly like the daemon's, with both defects. */
function streamedFloatWav(samples: number[]): Uint8Array {
  const body = new Uint8Array(samples.length * 4);
  const view = new DataView(body.buffer);
  samples.forEach((v, i) => view.setFloat32(i * 4, v, true));
  const out = new Uint8Array(44 + body.length);
  const dv = new DataView(out.buffer);
  const put = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  put(0, "RIFF");
  dv.setUint32(4, 0xffffffff, true); // the placeholder, never patched
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); // IEEE float
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 24_000, true);
  dv.setUint32(28, 96_000, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  put(36, "data");
  dv.setUint32(40, 0xffffffff, true); // and again
  out.set(body, 44);
  return out;
}

describe("a header built from the bytes that are actually there", () => {
  it("writes real sizes, which is the whole point", () => {
    const samples = new Uint8Array(200);
    const wav = wavFromPcm(samples, DEFAULT_PCM);
    assert.equal(wav.length, 244);
    assert.ok(ascii(wav, 0, "RIFF") && ascii(wav, 8, "WAVE"));
    assert.equal(u32(wav, 4), 36 + 200, "RIFF size counts what is here");
    assert.equal(u32(wav, 40), 200, "data size counts what is here");
  });

  it("declares integer PCM, because that is what a browser decodes", () => {
    const wav = wavFromPcm(new Uint8Array(8), { rate: 24_000, channels: 1, bits: 16 });
    assert.equal(u16(wav, 20), 1, "format 1, not 3");
    assert.equal(u16(wav, 34), 16, "16 bits, not 32");
    assert.equal(u32(wav, 24), 24_000);
    assert.equal(u32(wav, 28), 48_000, "byte rate follows the rate and width");
    assert.equal(u16(wav, 32), 2, "block align follows too");
  });
});

describe("converting the samples", () => {
  it("uses the full signed range at both ends", () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    [-1, 0, 1, 0.5].forEach((v, i) => view.setFloat32(i * 4, v, true));
    const out = floatToInt16(bytes);
    const read = new DataView(out.buffer);
    assert.equal(out.length, 8);
    assert.equal(read.getInt16(0, true), -32768);
    assert.equal(read.getInt16(2, true), 0);
    assert.equal(read.getInt16(4, true), 32767);
    assert.equal(read.getInt16(6, true), 16383);
  });

  it("clamps rather than wrapping, so a hot sample is loud and not inverted", () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 4.2, true);
    view.setFloat32(4, -9.9, true);
    const read = new DataView(floatToInt16(bytes).buffer);
    assert.equal(read.getInt16(0, true), 32767);
    assert.equal(read.getInt16(2, true), -32768);
  });
});

describe("repairing what the daemon sends", () => {
  it("fixes both defects of the measured file at once", () => {
    const broken = streamedFloatWav([0, 0.5, -0.5, 1]);
    const fixed = repairWav(broken);
    assert.ok(fixed, "a float32 streamed WAV is repairable");
    assert.equal(u16(fixed, 20), 1, "now integer PCM");
    assert.equal(u16(fixed, 34), 16, "now 16-bit");
    assert.equal(u32(fixed, 40), 8, "four samples, two bytes each");
    assert.equal(u32(fixed, 4), 44, "and a RIFF size that is true");
    assert.equal(u32(fixed, 24), 24_000, "the rate is carried across");
  });

  it("patches a 16-bit file whose sizes were never written", () => {
    /* The other half of the same streaming bug, on a server that at least
       sends integer samples: nothing needs converting, only counting. */
    const good = wavFromPcm(new Uint8Array([1, 2, 3, 4, 5, 6]), DEFAULT_PCM);
    const lying = Uint8Array.from(good);
    new DataView(lying.buffer).setUint32(40, 0xffffffff, true);
    const fixed = repairWav(lying);
    assert.ok(fixed);
    assert.equal(u32(fixed, 40), 6);
  });

  it("leaves an honest file alone rather than rewriting it", () => {
    // A hosted provider's ordinary WAV. Undefined means "use it as it came".
    assert.equal(repairWav(wavFromPcm(new Uint8Array([1, 2, 3, 4]), DEFAULT_PCM)), undefined);
  });

  it("does not touch what is not a WAV", () => {
    assert.equal(repairWav(Uint8Array.from([0x49, 0x44, 0x33, 3])), undefined, "an MP3");
    assert.equal(repairWav(new Uint8Array(3)), undefined, "or nothing much at all");
  });
});

describe("reading the raw-sample headers", () => {
  it("recognises the daemon's own content type", () => {
    // Measured: `audio/l16;rate=24000;endianness=little-endian`.
    assert.equal(isRawPcm("audio/l16;rate=24000;endianness=little-endian"), true);
    assert.equal(rateFrom("audio/l16;rate=24000;endianness=little-endian"), 24_000);
  });

  it("knows a container from raw samples", () => {
    assert.equal(isRawPcm("audio/wav"), false);
    assert.equal(isRawPcm("audio/mpeg"), false);
    assert.equal(isRawPcm(undefined), false);
  });

  it("falls back to the documented rate when none is declared", () => {
    assert.equal(rateFrom("audio/l16"), undefined);
    assert.equal(DEFAULT_PCM.rate, 24_000);
  });
});
