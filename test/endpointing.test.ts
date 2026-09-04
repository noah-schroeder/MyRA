/**
 * Knowing when the user has stopped talking, in a room that is never silent.
 *
 * Reported twice. First: "if i'm quiet for 1.5 seconds it still thinks i'm
 * talking, its too sensitive". Then, after an adaptive threshold was added:
 * "it is not auto-detecting when i stop talking... the only way I can talk is
 * if I press stop".
 *
 * Both had the same cause, and it was not where the threshold sat. The
 * decision was made on one reading at a time, and ambient noise is not a level
 * -- it is a level with spikes. Most of these tests therefore run against a
 * real recording rather than a made-up signal: `roomTrace.ts` is that room,
 * through that microphone, with the moment the speech starts and stops
 * recorded alongside so the assertions can be about behaviour rather than
 * about numbers somebody picked.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  enterLevel, exitLevel, levelFromAmplitude, observe, startTurn, turnEnded, SPEECH_LEVEL,
  type TurnState,
} from "../src/core/audio/endpointing.ts";
import { ROOM_TRACE, SPEECH_FROM, SPEECH_TO, type Reading } from "./fixtures/roomTrace.ts";

const QUIET_MS = 1_500;

interface Run {
  /** When speech was first heard, or undefined if it never was. */
  firstHeard?: number;
  /** When the turn was declared over, or undefined if it never was. */
  ended?: number;
  floor: number;
}

function replay(trace: Reading[], quietMs = QUIET_MS): Run {
  let state: TurnState = startTurn(trace[0]![0]);
  const out: Run = { floor: 0 };
  for (const [ms, level] of trace) {
    const before = state.heard;
    state = observe(state, level, ms);
    if (!before && state.heard) out.firstHeard = ms;
    if (out.ended === undefined && turnEnded(state, ms, quietMs)) out.ended = ms;
  }
  out.floor = state.floor;
  return out;
}

/** The room's own readings, repeated, for a turn where nobody says anything. */
function roomOnly(readings: number, gain = 1): Reading[] {
  const quiet = ROOM_TRACE.filter(([ms]) => ms < SPEECH_FROM).map(([, l]) => Math.min(1, l * gain));
  return Array.from({ length: readings }, (_, i): Reading => [i * 24, quiet[i % quiet.length]!, 0]);
}

/** The trace, with the room's own noise appended so the pause after speech is long enough. */
function withTrailingQuiet(gain = 1): Reading[] {
  const scaled = ROOM_TRACE.map(([ms, l, p]): Reading => [ms, Math.min(1, l * gain), p]);
  const last = scaled[scaled.length - 1]![0];
  const quiet = roomOnly(200, gain);
  return scaled.concat(quiet.map(([ms, l], i): Reading => [last + 24 * (i + 1), l, 0]));
}

describe("the level meter", () => {
  it("maps amplitude the way the bar is drawn", () => {
    /* An amplitude of 0.004 is −47.96 dBFS, which is where the fixed
       threshold of 0.2 on this scale came from. */
    assert.ok(Math.abs(levelFromAmplitude(0.004) - SPEECH_LEVEL) < 0.005);
    assert.equal(levelFromAmplitude(0), 0);
    assert.equal(levelFromAmplitude(1), 1);
    assert.equal(levelFromAmplitude(0.0001), 0);
  });
});

describe("the recorded room", () => {
  it("ends the turn after the speech stops", () => {
    const run = replay(withTrailingQuiet());
    assert.ok(run.ended !== undefined, "the turn never ended, which is the reported bug");
    assert.ok(
      run.ended! > SPEECH_TO,
      `ended at ${run.ended} but the speech ran until ${SPEECH_TO}`,
    );
    // Within the pause plus a beat of smoothing, not several seconds later.
    assert.ok(
      run.ended! - SPEECH_TO < QUIET_MS + 1_000,
      `took ${run.ended! - SPEECH_TO}ms after the speech to notice`,
    );
  });

  it("hears the speech, and only once it starts", () => {
    const run = replay(withTrailingQuiet());
    assert.ok(run.firstHeard !== undefined);
    assert.ok(
      run.firstHeard! >= SPEECH_FROM,
      `heard speech at ${run.firstHeard}, before any was played at ${SPEECH_FROM}`,
    );
  });

  it("does not end the turn in the middle of the speech", () => {
    // The other way to fail: a gap between two words read as the end of a
    // sentence. This is what the second, lower threshold is for.
    const run = replay(withTrailingQuiet());
    assert.ok(!(run.ended! > SPEECH_FROM && run.ended! < SPEECH_TO), `ended mid-speech at ${run.ended}`);
  });

  it("never hears speech in a room where nobody speaks", () => {
    // Thirty seconds of the same room. The old code counted 38 of its 576
    // readings as speech, which is what made the turn unendable.
    const run = replay(roomOnly(1_250));
    assert.equal(run.firstHeard, undefined);
    assert.equal(run.ended, undefined);
  });
});

describe("rooms that are not this one", () => {
  it("still ends the turn when the room is twice as loud", () => {
    const run = replay(withTrailingQuiet(2.2));
    assert.ok(run.ended !== undefined && run.ended > SPEECH_TO, `ended at ${run.ended}`);
  });

  it("learns a loud room rather than treating all of it as speech", () => {
    // The failure this replaces, reached from the other side: the old cap of
    // 0.35 put the threshold below a loud room's own noise permanently, so
    // every reading was speech and the turn could never end.
    const quiet = replay(roomOnly(1_250, 2.2));
    assert.ok(quiet.floor > 0.1, `floor stayed at ${quiet.floor} in a loud room`);
  });

  it("recovers from a false start instead of hanging on one", () => {
    /*
     * Said plainly, because it is a limit rather than a success. This signal
     * is the recorded room scaled up, which pushes its noise above the level
     * of real speech -- louder than any microphone with working gain control
     * would deliver -- and at that point noise and a voice are the same thing
     * to a level meter. Telling them apart needs the spectrum, which this does
     * not have.
     *
     * So the guarantee is not "never triggers". It is that a false start ENDS:
     * the turn closes, an empty recording goes to the transcriber, and the
     * loop comes back round. The reported bug was a turn that could only be
     * ended by hand, and that is what must not happen.
     */
    const quiet = replay(roomOnly(1_250, 2.2));
    if (quiet.firstHeard !== undefined) {
      assert.ok(quiet.ended !== undefined, "a false start left the turn open forever");
    }
  });

  it("gives up on a level that has been speech for longer than anyone talks", () => {
    // The backstop. A steady tone above the threshold would otherwise hold
    // `talking` true for good, because the estimate refuses to learn from
    // anything that looks like speech.
    const steady: Reading[] = Array.from({ length: 3_000 }, (_, i) => [i * 24, 0.55, 0]);
    const run = replay(steady);
    assert.ok(run.ended !== undefined, "a continuous tone held the turn open forever");
    assert.ok(run.floor > 0.3, `floor stayed at ${run.floor} against a steady 0.55`);
  });
});

describe("the rate the readings arrive at", () => {
  /*
   * The worklet produces ~125 a second and React coalesces them into far
   * fewer before this sees them. The previous constants were per-reading, so
   * they ran six to ten times too slow against the real feed -- which is the
   * difference between a turn that ends and one that does not.
   */
  const at = (every: number): Run =>
    replay(withTrailingQuiet().filter((_, i) => i % every === 0));

  it("reaches the same answer whether it sees every reading or one in six", () => {
    const full = at(1);
    const sparse = at(6);
    assert.ok(full.ended !== undefined && sparse.ended !== undefined);
    assert.ok(
      Math.abs(full.ended! - sparse.ended!) < 400,
      `full feed ended at ${full.ended}, sparse at ${sparse.ended}`,
    );
  });
});

describe("the two thresholds", () => {
  it("takes more to start hearing speech than to keep hearing it", () => {
    // Without the gap, the pause inside a word ends the turn.
    for (const floor of [0, 0.1, 0.3, 0.5]) {
      assert.ok(enterLevel(floor) > exitLevel(floor), `no hysteresis at floor ${floor}`);
    }
  });

  it("never drops below the level that was the whole test before", () => {
    // A silent room must be no twitchier than it used to be.
    assert.equal(enterLevel(0), SPEECH_LEVEL);
    assert.ok(exitLevel(0) < SPEECH_LEVEL);
  });

  it("rises with the room", () => {
    assert.ok(enterLevel(0.5) > enterLevel(0.1));
  });
});

describe("the turn's own bookkeeping", () => {
  it("does not end a turn in which nothing was ever said", () => {
    // Otherwise hands-free sends an empty recording the moment it starts.
    const state = startTurn(0);
    assert.equal(turnEnded(state, 60_000, QUIET_MS), false);
  });

  it("does not end a turn while speech is still being heard", () => {
    const talking: TurnState = {
      ...startTurn(0), heard: true, talking: true, lastHeard: 0,
    };
    assert.equal(turnEnded(talking, 10_000, QUIET_MS), false);
  });
});
