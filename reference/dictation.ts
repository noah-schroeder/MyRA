/**
 * Dictation: hotkey to text in the composer.
 *
 * The flow crosses three processes, which is what makes it work on Wayland:
 *
 *   keypress -> GNOME -> karen-ctl -> control socket -> here
 *                                                        |
 *                              pw-record --------------- +
 *                                     |
 *                        transcription endpoint -> renderer composer
 *
 * The agent is not involved at any point. Dictation puts text in the box; what
 * happens next is the user's decision, not Karen's.
 */

import { Recorder, type AudioSource, AudioError, listSources } from "./audio.ts";
import { CLIP_AMPLITUDE, meterScale, SILENCE_AMPLITUDE, SILENCE_MS, smooth } from "./meter.ts";
import { transcribe, TranscriptionError } from "./stt.ts";
import type { ConfigStore } from "./config.ts";
import type { SecretVault } from "./secrets.ts";

export type DictationPhase = "idle" | "recording" | "transcribing";

export interface DictationState {
  phase: DictationPhase;
  /** Milliseconds recorded so far, for the overlay's timer. */
  elapsedMs: number;
  /** Input level, 0..1, already scaled and smoothed for drawing. */
  level: number;
  /** The microphone has been producing nothing for a few seconds. */
  silent?: boolean;
  /** Input gain is too high and samples are hitting full scale. */
  clipping?: boolean;
  error?: string;
}

export interface DictationOptions {
  config: ConfigStore;
  secrets: SecretVault;
  /** Push state to the renderer so the overlay can follow along. */
  onState: (state: DictationState) => void;
  /** Deliver finished text to the composer. */
  onText: (text: string) => void;
}

/**
 * How often the level is read while recording.
 *
 * pw-record flushes its file about every 107 ms, so polling faster only
 * produces ticks with nothing new in them; this is roughly one reading per
 * flush, and fast enough that the bar moves with the voice.
 */
const METER_MS = 100;

export class Dictation {
  readonly #recorder = new Recorder();
  readonly #opts: DictationOptions;
  #phase: DictationPhase = "idle";
  #ticker: NodeJS.Timeout | undefined;
  #level = 0;
  #clipping = false;
  /** How long the input has been under the silence floor, unbroken. */
  #quietMs = 0;
  /** Set while a level read is outstanding, so slow ticks cannot pile up. */
  #reading = false;

  constructor(opts: DictationOptions) {
    this.#opts = opts;
  }

  get phase(): DictationPhase {
    return this.#phase;
  }

  state(): DictationState {
    return {
      phase: this.#phase,
      elapsedMs: this.#recorder.elapsedMs,
      level: this.#level,
      ...(this.#quietMs >= SILENCE_MS ? { silent: true } : {}),
      ...(this.#clipping ? { clipping: true } : {}),
    };
  }

  sources(): Promise<AudioSource[]> {
    return listSources();
  }

  #emit(error?: string): void {
    this.#opts.onState({ ...this.state(), ...(error ? { error } : {}) });
  }

  /**
   * One key, both directions.
   *
   * A press while transcribing is ignored rather than queued: the user is
   * waiting for text to appear, and starting a second recording underneath it
   * produces two transcripts racing for one composer.
   */
  async toggle(): Promise<string> {
    if (this.#phase === "transcribing") return "busy: still transcribing";
    return this.#phase === "recording" ? this.stop() : this.start();
  }

  async start(): Promise<string> {
    if (this.#phase !== "idle") return `already ${this.#phase}`;
    try {
      await this.#recorder.start({
        ...(this.#opts.config.current.dictationSource ? { source: this.#opts.config.current.dictationSource } : {}),
        onAutoStop: () => {
          // A latched hotkey should not record for ever.
          void this.stop();
        },
      });
      this.#phase = "recording";
      this.#level = 0;
      this.#clipping = false;
      this.#quietMs = 0;
      // The overlay shows a live timer and a live meter, so it needs a
      // heartbeat -- and the meter is what sets its rate.
      this.#ticker = setInterval(() => void this.#tick(), METER_MS);
      this.#emit();
      return "recording";
    } catch (err) {
      this.#phase = "idle";
      this.#emit(describe(err));
      return `error: ${describe(err)}`;
    }
  }

  /**
   * One meter reading, then one push to the renderer.
   *
   * Reads that overlap are dropped rather than queued: if the filesystem is
   * slow, a backlog of readings would each report a different moment and the
   * bar would jitter between them.
   */
  async #tick(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    try {
      const level = await this.#recorder.level();
      if (level) {
        this.#level = smooth(this.#level, meterScale(level.rms));
        this.#clipping = level.peak >= CLIP_AMPLITUDE;
        // Silence is judged on the peak, not the average: one loud syllable in
        // an otherwise quiet window means the microphone is plainly working.
        this.#quietMs = level.peak < SILENCE_AMPLITUDE ? this.#quietMs + METER_MS : 0;
      } else {
        // Nothing new to measure -- let the bar fall rather than freeze, which
        // would otherwise read as a held note.
        this.#level = smooth(this.#level, 0);
      }
    } finally {
      this.#reading = false;
    }
    if (this.#phase === "recording") this.#emit();
  }

  async stop(): Promise<string> {
    if (this.#phase !== "recording") return "not recording";
    clearInterval(this.#ticker);
    this.#level = 0;
    this.#clipping = false;
    this.#quietMs = 0;

    let audio: Buffer;
    let seconds: number;
    try {
      const recording = await this.#recorder.stop();
      seconds = recording.seconds;
      audio = await this.#recorder.take(recording);
    } catch (err) {
      this.#phase = "idle";
      this.#emit(describe(err));
      return `error: ${describe(err)}`;
    }

    this.#phase = "transcribing";
    this.#emit();

    try {
      const settings = this.#opts.config.current;
      const key = await this.#opts.secrets.get("transcriptionKey").catch(() => undefined);
      const text = await transcribe({
        endpoint: settings.transcription,
        audio,
        ...(key ? { apiKey: key } : {}),
        ...(settings.dictationLanguage ? { language: settings.dictationLanguage } : {}),
      });
      this.#phase = "idle";
      if (text) this.#opts.onText(text);
      this.#emit(text ? undefined : "Nothing was said, or nothing was heard.");
      return text || "(no speech detected)";
    } catch (err) {
      this.#phase = "idle";
      this.#emit(describe(err));
      return `error: ${describe(err)}`;
    } finally {
      // The audio buffer is not kept: dictation is transient by design, and
      // holding it would make a privacy promise the app does not need to break.
      audio.fill(0);
      void seconds;
    }
  }

  /** Throw the recording away without transcribing it. */
  async cancel(): Promise<string> {
    clearInterval(this.#ticker);
    this.#level = 0;
    this.#clipping = false;
    this.#quietMs = 0;
    await this.#recorder.cancel();
    this.#phase = "idle";
    this.#emit();
    return "cancelled";
  }
}

function describe(err: unknown): string {
  if (err instanceof AudioError || err instanceof TranscriptionError) return err.message;
  return (err as Error).message ?? String(err);
}
