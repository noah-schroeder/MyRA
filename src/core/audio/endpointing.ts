/**
 * Deciding when somebody has stopped talking.
 *
 * Twice wrong before this, both times for the same reason: the decision was
 * made on ONE reading at a time. Measured on the machine that reported it,
 * through its own microphone -- three seconds of an empty room, then a
 * sentence read aloud, then the room again:
 *
 *              p10     median   p90     max
 *     room     0.04    0.12     0.21    0.36
 *     speech   0.13    0.32     0.49    0.86
 *
 * The distributions overlap. Ambient noise is not a level, it is a level with
 * spikes, and this room crosses any threshold low enough to catch the quiet
 * parts of speech. With a fixed −48 dBFS bar (0.2 here), 38 of 576 silent
 * readings counted as speech; at ~125 readings a second, a rule that restarts
 * the end-of-turn timer on any single reading above the bar is a timer that
 * never expires. Hence "it never autodetects me stopping talking" -- the turn
 * could only be ended by hand.
 *
 * The bar was never the problem and moving it cannot fix it: raise it above
 * the room's spikes and it sits above the quiet parts of speech, which cuts
 * people off mid-sentence instead. What separates them is not level but
 * PERSISTENCE. Speech holds a level for hundreds of milliseconds; a spike does
 * not. So the decision is made on a smoothed level, with two thresholds -- one
 * to start hearing speech and a lower one to keep hearing it -- which is what
 * stops the gap between two words ending a sentence.
 *
 * Every constant is a time, not a per-reading rate. The readings arrive at
 * ~125 a second from the audio worklet but reach this through React state,
 * which coalesces them into far fewer; the previous rates were tuned for the
 * first number and ran six to ten times too slow at the second. Replaying the
 * captured trace at 125, 60 and 20 readings a second now ends the turn within
 * 100 ms of the same moment.
 */

/**
 * A level meter reading, 0..1, from a raw amplitude.
 *
 * Speech sits near −20 dBFS, so a linear bar reads as broken -- hence the dB
 * mapping over a 60 dB window. Shared rather than copied: dictation's meter and
 * the hands-free threshold have to be on the same scale, and when they were
 * two separate copies one comparison was made against the wrong one.
 */
export function levelFromAmplitude(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, amplitude));
  return db <= -60 ? 0 : Math.min(1, (db + 60) / 60);
}

/**
 * The lowest level that may ever count as speech, on that scale.
 *
 * 20·log10(0.004) is −48 dBFS, which the mapping above puts at 0.2. It was the
 * whole test once; it is now a floor under an adaptive threshold, so a silent
 * room is no twitchier than it used to be.
 */
export const SPEECH_LEVEL = 0.2;

/* Smoothing. 180 ms is long enough to swallow a noise spike and short enough
   that the end of a sentence is not missed by a syllable. */
const TAU_LEVEL_MS = 180;

/*
 * How the room's own level is learned, as time constants.
 *
 * Down fast and up slow, because that asymmetry is what separates a room from
 * a person: room noise is continuous, so even a slow rise reaches it, while
 * speech is full of gaps -- between words, inside plosives -- and every gap
 * lets the fast fall pull the estimate back down to the room.
 *
 * TAU_UP_FAR is the one that matters most. While the level looks like speech
 * the room estimate barely moves at all, or a long sentence would raise the
 * bar until its own tail counted as silence.
 */
const TAU_DOWN_MS = 400;
const TAU_UP_MS = 4_000;
const TAU_UP_FAR_MS = 60_000;

/**
 * When "speech" has gone on too long to be speech.
 *
 * Sustained noise and a sustained voice are the same thing to a level meter --
 * telling them apart needs the spectrum, which this does not have. So there is
 * a backstop instead: nobody talks for twenty seconds without a pause that
 * drops below the lower threshold, so anything that does is the room, and the
 * estimate starts learning from it at the ordinary rate.
 *
 * This is what makes the failure self-correcting rather than permanent. The
 * reported bug was a turn that could only be ended by hand; with this, the
 * worst a room can do is delay the end of one turn.
 */
const STUCK_MS = 20_000;

/*
 * The first moments of a turn, when nothing is known about the room yet.
 *
 * Until the room has been measured there is no way to say what is loud, so
 * nothing counts as speech and the estimate is allowed to converge quickly.
 * Without this a noisy room reads as speech from the first reading -- the
 * estimate starts at zero and takes seconds to catch up, and the whole turn is
 * decided before it does.
 */
const SETTLE_MS = 700;
/** For a few seconds after that, still learning faster than the steady rate. */
const SETTLING_UP_MS = 800;
const SETTLED_AFTER_MS = 3_000;

/**
 * How long a sound must go on before it counts as somebody speaking.
 *
 * A door, a chair, a cough and a keyboard all clear the threshold for a
 * moment. Without this they start a turn, and the turn then ends a second and
 * a half later and sends a recording of a room to the transcriber. Two hundred
 * milliseconds is under one syllable, so nothing a person says is lost.
 */
const MIN_SPEECH_MS = 200;

/** How far above the room a smoothed level must rise to become speech. */
const ENTER_MARGIN = 0.14;
/** And how far it must fall to stop being speech. Lower, so words may have gaps. */
const EXIT_MARGIN = 0.05;
/** The same hysteresis applied to the fixed minimum, for a silent room. */
const ENTER_EXIT_GAP = 0.07;

/**
 * How loud a room may be assumed to be.
 *
 * Generous. The old cap of 0.35 was itself a way to fail: a room above it
 * pinned the threshold below its own noise, so everything was speech forever.
 * A cap is still wanted -- an estimate that followed a level all the way up
 * would eventually stop hearing anyone -- but it belongs above any room a
 * person would try to work in rather than in the middle of them.
 */
const FLOOR_MAX = 0.8;

/** Everything the decision needs, carried between readings. */
export interface TurnState {
  /** Smoothed level. */
  level: number;
  /** What the room alone seems to be. */
  floor: number;
  /** Whether speech is being heard right now. */
  talking: boolean;
  /** When the current run of speech began, for the minimum above. */
  talkingSince: number;
  /** Whether speech has been heard at all this turn. */
  heard: boolean;
  /** When speech was last heard, on the caller's clock. */
  lastHeard: number;
  /** When this turn began, so settling can be measured. */
  startedAt: number;
  /** The previous reading's timestamp. */
  at: number;
}

export function startTurn(now: number): TurnState {
  return {
    level: 0, floor: 0, talking: false, talkingSince: 0, heard: false, lastHeard: 0,
    startedAt: now, at: now,
  };
}

/** How much of the way to a new value one step of `tau` moves. */
function approach(tau: number, dt: number): number {
  return 1 - Math.exp(-dt / tau);
}

export function enterLevel(floor: number): number {
  return Math.max(SPEECH_LEVEL, floor + ENTER_MARGIN);
}

export function exitLevel(floor: number): number {
  return Math.max(SPEECH_LEVEL - ENTER_EXIT_GAP, floor + EXIT_MARGIN);
}

/**
 * One reading. Pure: returns the next state rather than mutating.
 *
 * `now` is passed in rather than read, both so this can be tested against a
 * recording and because the readings do not arrive on a regular clock -- the
 * interval between them is what makes the constants above mean anything.
 */
export function observe(state: TurnState, level: number, now: number): TurnState {
  const dt = Math.max(1, now - state.at);
  const age = now - state.startedAt;
  const smoothed = state.level + (level - state.level) * approach(TAU_LEVEL_MS, dt);

  if (age < SETTLE_MS) {
    /* Learning the room, and deaf while it does. Fast in both directions: the
       point is to arrive at the room's real level before judging anything. */
    return {
      ...state,
      level: smoothed,
      floor: state.floor + (smoothed - state.floor) * approach(TAU_DOWN_MS, dt),
      at: now,
    };
  }

  const enter = enterLevel(state.floor);
  const talking = state.talking ? smoothed > exitLevel(state.floor) : smoothed > enter;
  const talkingSince = talking ? (state.talking ? state.talkingSince : now) : 0;
  /* Long enough to be a person, rather than a door closing. `lastHeard` still
     moves on any talking reading -- once a turn is under way, the gap that
     ends it is measured from the last sound, not from the last sound that
     lasted long enough. */
  const sustained = talking && now - talkingSince >= MIN_SPEECH_MS;

  /* Every reading teaches, and one that looks like speech teaches almost
     nothing. Gating this on "not speech" was the first fix attempted and it
     cannot work: in a room already above the bar every reading looks like
     speech, so nothing is ever learned and the bug survives its own repair. */
  const up = age < SETTLED_AFTER_MS ? SETTLING_UP_MS : TAU_UP_MS;
  const stuck = talking && now - talkingSince > STUCK_MS;
  const tau = smoothed < state.floor
    ? TAU_DOWN_MS
    : smoothed > enter && !stuck
      ? TAU_UP_FAR_MS
      : up;
  const floor = Math.min(FLOOR_MAX, Math.max(0, state.floor + (smoothed - state.floor) * approach(tau, dt)));

  return {
    level: smoothed,
    floor,
    talking,
    talkingSince,
    heard: state.heard || sustained,
    lastHeard: talking ? now : state.lastHeard,
    startedAt: state.startedAt,
    at: now,
  };
}

/**
 * Whether the turn is over: something was said, and the silence since has run.
 *
 * Both halves are load-bearing. Without the first, a turn ends before anybody
 * speaks; without the second, it ends between two words.
 */
export function turnEnded(state: TurnState, now: number, quietMs: number): boolean {
  return state.heard && !state.talking && now - state.lastHeard >= quietMs;
}
