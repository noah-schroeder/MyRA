/**
 * Knowing when the user has stopped talking, in a room that is never silent.
 *
 * Reported twice. First "if i'm quiet for 1.5 seconds it still thinks i'm
 * talking, its too sensitive". Then, after an adaptive threshold was added,
 * "it is not auto-detecting when i stop talking -- the only way I can talk is
 * if I press stop".
 *
 * Both had one cause and it was never where the threshold sat: the decision
 * was made on ONE reading at a time, and ambient noise is not a level, it is a
 * level with spikes. So these tests run against recordings from the machine
 * that reported it -- its room, and its user speaking -- because a synthetic
 * signal is smooth and hides the whole problem.
 *
 * The margins are narrow because the recordings say they have to be: in 200 ms
 * means the room runs 0.14 to 0.26 and the voice 0.28 with peaks at 0.41.
 * About a tenth of the scale separates a person from their own room.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  enterLevel, exitLevel, levelFromAmplitude, observe, startTurn, turnEnded, SPEECH_LEVEL,
  type TurnState,
} from "../src/core/audio/endpointing.ts";
import { ROOM, VOICE, STEP_MS } from "./fixtures/roomTrace.ts";

const QUIET_MS = 1_500;

interface Run {
  heardAt?: number;
  endedAt?: number;
  /** How many times it stopped hearing speech while the voice was playing. */
  breaks: number;
  base: number;
}

/** Build a timeline out of stretches of recorded audio. */
function timeline(...parts: number[][]): number[] {
  return parts.flat();
}

function replay(
  levels: number[],
  speaks: [number, number] = [-1, -1],
  /** Which readings to keep. Dropping some must not compress the clock. */
  keep = 1,
): Run {
  let state: TurnState = startTurn(0);
  const out: Run = { breaks: 0, base: 0 };
  let wasTalking = false;
  levels.forEach((level, i) => {
    if (i % keep !== 0) return;
    const ms = i * STEP_MS;
    const before = state.heard;
    state = observe(state, level, ms);
    if (!before && state.heard) out.heardAt = ms;
    if (wasTalking && !state.talking && i > speaks[0] && i < speaks[1]) out.breaks += 1;
    wasTalking = state.talking;
    if (out.endedAt === undefined && turnEnded(state, ms, QUIET_MS)) out.endedAt = ms;
  });
  out.base = Math.max(state.floor, state.ambient);
  return out;
}

/** The room, long enough to be sure, with nobody saying anything. */
const roomFor = (seconds: number, gain = 1): number[] =>
  Array.from({ length: Math.round((seconds * 1000) / STEP_MS) },
    (_, i) => Math.min(1, ROOM[i % ROOM.length]! * gain));

describe("the level meter", () => {
  it("maps amplitude the way the bar is drawn", () => {
    /* An amplitude of 0.004 is −47.96 dBFS, which is where the fixed threshold
       of 0.2 on this scale came from. */
    assert.ok(Math.abs(levelFromAmplitude(0.004) - SPEECH_LEVEL) < 0.005);
    assert.equal(levelFromAmplitude(0), 0);
    assert.equal(levelFromAmplitude(1), 1);
    assert.equal(levelFromAmplitude(0.0001), 0);
  });
});

describe("the room this was reported from", () => {
  it("never hears speech when nobody is speaking", () => {
    // The bug, in one assertion. This room sits above the fixed −48 dBFS that
    // used to be the whole test, so every reading counted as speech and the
    // pause that ends a turn could never start.
    const run = replay(roomFor(30));
    assert.equal(run.heardAt, undefined, "heard speech in an empty room");
    assert.equal(run.endedAt, undefined);
  });

  it("learns roughly what the room is, rather than its quietest instant", () => {
    // The floor alone tracks the gaps and reads far too low here, which is why
    // there is a second estimate that keeps learning through apparent speech.
    const run = replay(roomFor(30));
    const mean = ROOM.reduce((a, c) => a + c, 0) / ROOM.length;
    assert.ok(run.base > mean * 0.6, `base ${run.base.toFixed(3)} against a room averaging ${mean.toFixed(3)}`);
  });
});

describe("the user actually talking", () => {
  const speech = timeline(roomFor(3), VOICE, roomFor(5));
  const from = roomFor(3).length;
  const to = from + VOICE.length;

  it("hears them, and not before they start", () => {
    const run = replay(speech, [from, to]);
    assert.ok(run.heardAt !== undefined, "never heard the user speak");
    assert.ok(
      run.heardAt! >= (from - 10) * STEP_MS,
      `heard speech at ${run.heardAt}ms, before they started at ${from * STEP_MS}ms`,
    );
  });

  it("ends the turn after they stop, not while they are still going", () => {
    const run = replay(speech, [from, to]);
    assert.ok(run.endedAt !== undefined, "the turn never ended, which is the reported bug");
    assert.ok(
      run.endedAt! > to * STEP_MS,
      `cut them off ${to * STEP_MS - run.endedAt!}ms early`,
    );
    assert.ok(
      run.endedAt! - to * STEP_MS < QUIET_MS + 1_500,
      `took ${run.endedAt! - to * STEP_MS}ms after they stopped to notice`,
    );
  });

  it("holds through the gaps between their phrases", () => {
    /*
     * What the hangover is for. This recording has 200 to 600 ms gaps in it,
     * and without one each gap ends the turn -- the level between phrases
     * drops into the room's own range, because the two are only a tenth apart.
     */
    const run = replay(speech, [from, to]);
    assert.ok(run.breaks < 6, `stopped hearing them ${run.breaks} times mid-sentence`);
  });
});

describe("rooms other than this one", () => {
  it("still hears a voice in a room twice as loud", () => {
    const louder = timeline(roomFor(3, 2), VOICE.map((l) => Math.min(1, l * 2)), roomFor(5, 2));
    const run = replay(louder);
    assert.ok(run.heardAt !== undefined && run.endedAt !== undefined);
  });

  it("never gets permanently stuck, even where it cannot tell noise from a voice", () => {
    /*
     * The limit, stated rather than wished away. Scaled up like this the room's
     * own peaks reach 0.44 -- the level of the user's actual speech in the
     * recording beside it -- and at that point a voice and a room are the same
     * thing to a level meter. Telling them apart needs the spectrum, which this
     * does not have, so in a room this loud hands-free will trigger on noise.
     *
     * What must still hold is that it never latches. The reported bug was a
     * turn that could only be ended by hand; here speech is entered and
     * released repeatedly, so the app keeps responding rather than freezing
     * with the microphone open.
     */
    let state: TurnState = startTurn(0);
    let releases = 0;
    let wasTalking = false;
    roomFor(60, 2).forEach((level, i) => {
      state = observe(state, level, i * STEP_MS);
      if (wasTalking && !state.talking) releases += 1;
      wasTalking = state.talking;
    });
    assert.ok(releases > 0, "speech was entered and never released — the turn would hang");
  });

  it("learns a loud room rather than calling all of it speech", () => {
    // The old cap of 0.35 put the threshold below a loud room's own noise
    // permanently, which is the failure this replaces reached from the far side.
    assert.ok(replay(roomFor(30, 2)).base > 0.2);
  });
});

describe("the rate the readings arrive at", () => {
  /*
   * The worklet produces ~125 a second and React coalesces them into far
   * fewer. The constants used to be per-reading rates tuned for the first
   * number, so against the real feed they ran six to ten times too slow --
   * the difference between a turn that ends and one that does not.
   */
  it("reaches nearly the same moment on one reading in three", () => {
    // Same audio, same clock, a third of the readings -- which is what React
    // does to the worklet's output before this ever sees it.
    const speech = timeline(roomFor(3), VOICE, roomFor(5));
    const full = replay(speech);
    const sparse = replay(speech, [-1, -1], 3);
    assert.ok(full.endedAt !== undefined && sparse.endedAt !== undefined);
    assert.ok(
      Math.abs(full.endedAt! - sparse.endedAt!) < 500,
      `ended at ${full.endedAt}ms on every reading and ${sparse.endedAt}ms on one in three`,
    );
  });
});

describe("the two thresholds", () => {
  it("takes more to start hearing speech than to keep hearing it", () => {
    for (const floor of [0, 0.1, 0.3, 0.5]) {
      assert.ok(enterLevel(floor) > exitLevel(floor), `no hysteresis at floor ${floor}`);
    }
  });

  it("never asks for less than the level that was the whole test before", () => {
    assert.equal(enterLevel(0), SPEECH_LEVEL);
  });

  it("rises with the room", () => {
    assert.ok(enterLevel(0.5) > enterLevel(0.1));
  });
});

describe("the turn's own bookkeeping", () => {
  it("does not end a turn in which nothing was ever said", () => {
    // Otherwise hands-free sends an empty recording the moment it opens.
    assert.equal(turnEnded(startTurn(0), 60_000, QUIET_MS), false);
  });

  it("does not end a turn while speech is still being heard", () => {
    const talking: TurnState = { ...startTurn(0), heard: true, talking: true, lastHeard: 0 };
    assert.equal(turnEnded(talking, 10_000, QUIET_MS), false);
  });
});
