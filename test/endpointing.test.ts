/**
 * Knowing when the user has stopped talking, in a room that is never silent.
 *
 * Reported: "on my speech to speech functionality, if i'm quiet for 1.5
 * seconds it still thinks i'm talking, its too sensitive". The test was a
 * fixed −48 dBFS, and a room with a fan in it sits above that permanently --
 * so the turn could not end while the user stayed in the room.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  isSpeech, levelFromAmplitude, nextFloor, speechThreshold, SPEECH_LEVEL,
} from "../src/core/audio/endpointing.ts";

/** Feed a steady level in for `seconds`, at the worklet's ~125 readings a second. */
function settle(floor: number, level: number, seconds: number): number {
  for (let i = 0; i < Math.round(seconds * 125); i++) floor = nextFloor(floor, level);
  return floor;
}

describe("the level meter", () => {
  it("maps amplitude the way the bar is drawn", () => {
    /* An amplitude of 0.004 is −47.96 dBFS, which is where the old fixed
       threshold of 0.2 on this scale came from. */
    assert.ok(Math.abs(levelFromAmplitude(0.004) - SPEECH_LEVEL) < 0.005);
    assert.equal(levelFromAmplitude(0), 0);
    assert.equal(levelFromAmplitude(1), 1);
    // Below the window's floor reads as nothing rather than as a negative.
    assert.equal(levelFromAmplitude(0.0001), 0);
  });
});

describe("a quiet room", () => {
  it("behaves exactly as it did before", () => {
    /* The guarantee that makes this safe to ship: learning can only ever raise
       the bar, so nobody's working setup gets twitchier. */
    assert.equal(speechThreshold(0), SPEECH_LEVEL);
    const floor = settle(0, 0.02, 10);
    assert.equal(speechThreshold(floor), SPEECH_LEVEL);
    assert.equal(isSpeech(0.5, floor), true);
    assert.equal(isSpeech(0.1, floor), false);
  });
});

describe("a room with a fan in it", () => {
  /* The reported case. Background sitting at 0.3 -- above the old fixed 0.2 --
     so every sample counted as speech and the turn never ended. */
  const noisy = settle(0, 0.3, 10);

  it("learns the room and puts the bar above it", () => {
    assert.ok(noisy > 0.25, `floor followed the room: ${noisy}`);
    assert.equal(isSpeech(0.3, noisy), false, "the room itself is not speech any more");
    assert.ok(speechThreshold(noisy) > SPEECH_LEVEL);
  });

  it("still hears an ordinary speaking voice over it", () => {
    // Speech sits near −20 dBFS, which this scale puts at about 0.67.
    assert.equal(isSpeech(levelFromAmplitude(0.1), noisy), true);
  });

  it("ends the turn once the talking stops", () => {
    /* The whole point: after the user stops, the level returns to the room's
       own and no longer registers, so the 1.5 s timer can run out. */
    let floor = noisy;
    for (let i = 0; i < 200; i++) floor = nextFloor(floor, 0.7); // talking
    assert.equal(isSpeech(0.3, floor), false);
  });
});

describe("what the floor learns from", () => {
  it("is barely moved by somebody talking", () => {
    /* The floor tracks a minimum, and speech at 8 ms resolution is full of
       gaps -- between words, inside plosives. Each gap returns the level to
       the room, where the fast fall pulls the floor back. A talker therefore
       cannot walk the bar up under their own sentence, which would end the
       turn mid-word. */
    const room = settle(0, 0.05, 4);
    let floor = room;
    for (let burst = 0; burst < 40; burst++) {
      for (let i = 0; i < 25; i++) floor = nextFloor(floor, 0.7); // a word
      for (let i = 0; i < 8; i++) floor = nextFloor(floor, 0.05); // the gap after it
    }
    assert.ok(Math.abs(floor - room) < 0.05, `stayed near the room: ${floor} vs ${room}`);
    assert.equal(isSpeech(0.7, floor), true, "and still hears the voice");
  });

  it("learns a room that is already above the old fixed threshold", () => {
    /* The first attempt at this failed here, and failed silently: it refused
       to learn from anything loud enough to be speech, so a room above the bar
       made every sample look like speech, nothing was learned, and the
       reported bug survived its own fix. */
    const floor = settle(0, 0.3, 10);
    assert.ok(floor > 0.2, `learned the room: ${floor}`);
    assert.equal(isSpeech(0.3, floor), false);
  });

  it("follows a room that goes quiet faster than one that gets loud", () => {
    const noisy = settle(0, 0.3, 10);
    // The fan switches off: believed quickly.
    assert.ok(settle(noisy, 0.02, 2) < 0.05, "came down within a couple of seconds");
    // The fan switches on: taken slowly, because a rising level is usually the
    // person rather than the room.
    assert.ok(settle(0.02, 0.3, 0.5) < 0.1, "did not jump");
  });

  it("stops raising the bar before speech would be unhearable", () => {
    /* Without the cap this fails the other way: a loud enough room lifts the
       threshold over an ordinary voice and the turn never ends again. */
    const roaring = settle(0, 0.9, 60);
    assert.ok(speechThreshold(roaring) < levelFromAmplitude(0.1),
      "an ordinary speaking voice still counts as speech");
  });
});
