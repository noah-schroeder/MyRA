/**
 * Deciding when somebody has stopped talking.
 *
 * Hands-free ended a turn after 1.5 s below a fixed threshold of −48 dBFS.
 * That number is a reasonable floor for a silent room and wrong for every
 * other one: a fan, a laptop under load, a window onto a street or simply a
 * microphone with its gain up all sit above it permanently. Reported as "if
 * I'm quiet for 1.5 seconds it still thinks I'm talking", which is exactly
 * what a room whose noise never drops below the threshold produces -- the turn
 * can only end when the user leaves.
 *
 * So the threshold follows the room. The quiet level is learned from the
 * samples that are NOT speech, and speech has to stand a fixed margin above
 * it. Two properties matter and are tested:
 *
 *   - a speaker's own voice never teaches the floor, or a long sentence would
 *     raise the bar until the tail of it counted as silence;
 *   - the learned threshold never goes BELOW the old fixed one, so a quiet
 *     room behaves exactly as it did before.
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
 * The lowest threshold ever used, on that scale.
 *
 * 20·log10(0.004) is −48 dBFS, which the mapping above puts at 0.2. This was
 * the whole test before; it is now the floor under an adaptive one, so a
 * silent room is not made more twitchy than it used to be.
 */
export const SPEECH_LEVEL = 0.2;

/** How far above the room's own noise a sound must be to count as speech. */
const MARGIN = 0.12; // 0.12 × 60 dB ≈ 7 dB.

/**
 * How high the learned floor may go.
 *
 * Without a cap, a room loud enough would raise the threshold above ordinary
 * speech and the turn would never end at all -- the same failure this replaces,
 * reached from the other direction.
 */
const FLOOR_MAX = 0.35;

/*
 * Rates per reading, at the ~125 a second the 128-frame worklet produces.
 *
 * The floor tracks a minimum rather than an average, and the asymmetry is what
 * separates a room from a person: room noise is CONTINUOUS, so even the
 * slowest rise reaches it, while speech is full of gaps at this resolution --
 * between words, inside plosives -- and every gap drops the level back to the
 * room, where the fast fall pulls the floor down again.
 *
 * Learning cannot be gated on "this sample is not speech", which was the first
 * attempt: a room already above the threshold makes every sample look like
 * speech, nothing is ever learned, and the bug survives its own fix. So every
 * reading teaches, and a reading loud enough to be speech teaches very slowly.
 */
const FALL = 0.05;      // ~0.15 s to follow a room that goes quiet.
const RISE_NEAR = 0.01; // ~0.8 s, for a level around the floor: the room.
const RISE_FAR = 0.0008; // ~10 s, for a level above the bar: probably a voice.

/** The level a sound must exceed, given what the room has been doing. */
export function speechThreshold(floor: number): number {
  return Math.max(SPEECH_LEVEL, floor + MARGIN);
}

export function isSpeech(level: number, floor: number): boolean {
  return level > speechThreshold(floor);
}

/** The room's noise level after one more reading. */
export function nextFloor(floor: number, level: number): number {
  const rate = level < floor ? FALL : isSpeech(level, floor) ? RISE_FAR : RISE_NEAR;
  return Math.min(FLOOR_MAX, Math.max(0, floor + (level - floor) * rate));
}
