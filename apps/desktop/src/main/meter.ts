/**
 * Turning captured audio into something the eye can read.
 *
 * The meter answers the one question the timer cannot: is the microphone
 * actually hearing anything? Without it a silent recording is only discovered
 * at the transcript, by which point what you said is gone.
 *
 * Levels come from tailing the WAV pw-record is already writing, not from
 * teeing the audio through this process. The capture path therefore stays
 * exactly as it was verified, and a meter that fails cannot spoil a recording.
 * Measured against a live PipeWire, that file grows every ~107 ms -- roughly
 * one quantum -- which is fine granularity for a meter and no lag worth seeing.
 */

/** Quietest level the meter draws at all. Below this the bar reads empty. */
const FLOOR_DB = -60;

/**
 * Below this the microphone is judged to be hearing nothing.
 *
 * Calibrated against this machine's actual input rather than picked: an open
 * mic in a quiet room sits well above it, and a muted one sits far below.
 */
export const SILENCE_AMPLITUDE = 0.004;

/** How long the input must stay under that before the HUD says so. */
export const SILENCE_MS = 2_500;

/** Peaks this close to full scale are being clipped by the input gain. */
export const CLIP_AMPLITUDE = 0.99;

export interface Level {
  /** Loudest sample in the window, 0..1. */
  peak: number;
  /** Root-mean-square of the window, 0..1 -- what the bar is drawn from. */
  rms: number;
}

/**
 * Where a WAV's PCM payload begins, or -1 if the header is not complete yet.
 *
 * pw-record writes a canonical 44-byte header, so this could be a constant.
 * It walks the chunks instead because a constant would be silently wrong the
 * day it writes an extensible header, and being wrong here means reading
 * header bytes as audio -- which reads as a loud noise, the one reading a
 * meter must never invent.
 */
export function pcmStart(head: Buffer): number {
  if (head.length < 12) return -1;
  if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return -1;

  let at = 12;
  while (at + 8 <= head.length) {
    const id = head.toString("latin1", at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === "data") return at + 8;
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    at += 8 + size + (size % 2);
  }
  return -1;
}

/** Peak and RMS of a window of signed 16-bit little-endian mono samples. */
export function levelOf(pcm: Buffer): Level {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { peak: 0, rms: 0 };

  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32_768;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  return { peak: Math.min(1, peak), rms: Math.min(1, Math.sqrt(sum / samples)) };
}

/**
 * Amplitude to bar fill, on a decibel scale.
 *
 * This is what separates a meter from a decoration. Speech sits around -20
 * dBFS, which is 0.1 in linear amplitude -- a linear bar would barely twitch
 * while someone talks normally, and would look broken. On a dB scale that same
 * speech fills two thirds of the bar, which is what the eye expects.
 */
export function meterScale(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, amplitude));
  if (db <= FLOOR_DB) return 0;
  return Math.min(1, (db - FLOOR_DB) / -FLOOR_DB);
}

/**
 * Fast attack, slow release -- the standard meter ballistics.
 *
 * A bar that follows the samples exactly flickers at 10 Hz and is unreadable.
 * Rises are shown immediately, because a late meter is a lying meter; falls
 * decay so the eye can track them.
 */
export function smooth(previous: number, next: number): number {
  const RELEASE = 0.35;
  return next >= previous ? next : previous + (next - previous) * RELEASE;
}
