/**
 * Recording, without a platform behind it.
 *
 * v1 spawned one `pw-record` per track and tailed the growing WAV to drive the
 * level meter. That worked, and it worked only on Linux with PipeWire running.
 *
 * Here the audio arrives instead: the renderer captures with getUserMedia (and
 * getDisplayMedia for the far side of a call), downsamples to the mono 16 kHz
 * s16le that transcription endpoints want, and pushes chunks in over IPC. This
 * module owns the file, so it owns the header too -- which removes v1's most
 * delicate dependency, that SIGTERM (never SIGKILL) had to reach pw-record
 * itself for the WAV header to be finalised.
 *
 * The class keeps the same shape the meeting recorder already drives:
 * start / write / level / stop / cancel.
 */

import { mkdtemp, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePrivateDir, OWNER_ONLY_FILE } from "../paths.ts";
import { levelOf, type Level } from "./meter.ts";

export const RATE = 16_000;
export const CHANNELS = 1;
/** Bytes per sample, s16le. */
const SAMPLE_BYTES = 2;
const HEADER_BYTES = 44;

/** Half a second of audio: enough for a meter reading, small enough to be cheap. */
const LEVEL_WINDOW_BYTES = RATE * SAMPLE_BYTES * 0.5;

export class AudioError extends Error {
  override readonly name = "AudioError";
}

/**
 * A capture device as the renderer sees it.
 *
 * `id` is a MediaDeviceInfo.deviceId, not a PipeWire node id -- it is an opaque
 * string, and on some platforms it is stable only within a browsing session.
 */
export interface AudioSource {
  id: string;
  name: string;
  description: string;
  isDefault?: boolean;
  kind: "microphone" | "system";
}

export interface RecordOptions {
  /** Device id, for the record only. Capture itself is driven by the renderer. */
  source?: string;
  /** Where to write. Omitted means a private temporary directory. */
  dir?: string;
  /** Basename of the WAV, without extension. */
  name?: string;
  /** Cap on the recording, after which onAutoStop fires. */
  maxSeconds?: number;
  onAutoStop?: () => void;
}

export interface Recording {
  /** Absolute path to the finished WAV. */
  path: string;
  bytes: number;
  seconds: number;
}

/**
 * A 44-byte canonical WAV header.
 *
 * Written twice: once with zero lengths when the file is created, then again
 * with the real ones on stop. Writing it up front means a recording that dies
 * with the process still leaves a file a player can open, which a
 * length-prefixed format written only at the end would not.
 */
export function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  const byteRate = RATE * CHANNELS * SAMPLE_BYTES;
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // PCM fmt chunk size
  b.writeUInt16LE(1, 20); // format: PCM
  b.writeUInt16LE(CHANNELS, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(CHANNELS * SAMPLE_BYTES, 32); // block align
  b.writeUInt16LE(SAMPLE_BYTES * 8, 34); // bits per sample
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** Seconds of audio in a given number of PCM bytes. */
export function secondsOf(dataBytes: number): number {
  return dataBytes / (RATE * CHANNELS * SAMPLE_BYTES);
}

/** One recording in flight. */
export class Recorder {
  #handle: FileHandle | undefined;
  #path: string | undefined;
  #dir: string | undefined;
  #owned = true;
  #bytes = 0;
  #startedAt = 0;
  #stopTimer: NodeJS.Timeout | undefined;
  #onAutoStop: (() => void) | undefined;
  /** Most recent PCM, kept only to drive the meter. */
  #window = Buffer.alloc(0);

  get path(): string | undefined {
    return this.#path;
  }

  get running(): boolean {
    return this.#handle !== undefined;
  }

  async start(options: RecordOptions = {}): Promise<void> {
    if (this.#handle) throw new AudioError("already recording");

    if (options.dir) {
      this.#dir = options.dir;
      this.#owned = false;
      await makePrivateDir(options.dir);
    } else {
      /*
       * `mkdtemp`, not a name we compose ourselves.
       *
       * This used to be `karen-rec-<pid>-<Date.now()>`, which is a path anyone
       * on the machine can predict and therefore create first -- as a symlink
       * pointing wherever they like, with the recording written through it. It
       * also inherited the umask, so a meeting's raw audio sat in a shared
       * /tmp readable by every other account.
       *
       * mkdtemp closes both: the suffix is random, it fails rather than reuses
       * if the name is taken, and the directory is 0700 by definition.
       */
      this.#dir = await mkdtemp(join(tmpdir(), "karen-rec-"));
      this.#owned = true;
    }

    this.#path = join(this.#dir, `${options.name ?? "recording"}.wav`);
    // 0600: audio of a meeting is the most sensitive thing this app produces.
    this.#handle = await open(this.#path, "w", OWNER_ONLY_FILE);
    await this.#handle.write(wavHeader(0), 0, HEADER_BYTES, 0);
    this.#bytes = 0;
    this.#window = Buffer.alloc(0);
    this.#startedAt = Date.now();

    if (options.maxSeconds && options.maxSeconds > 0) {
      this.#onAutoStop = options.onAutoStop;
      this.#stopTimer = setTimeout(() => {
        this.#onAutoStop?.();
      }, options.maxSeconds * 1000);
      this.#stopTimer.unref?.();
    }
  }

  /** Append captured PCM. Silently ignored once stopped, so a late IPC chunk
   *  arriving after the user clicked stop is not an error. */
  async write(pcm: Buffer): Promise<void> {
    const handle = this.#handle;
    if (!handle || pcm.length === 0) return;
    await handle.write(pcm, 0, pcm.length, HEADER_BYTES + this.#bytes);
    this.#bytes += pcm.length;
    const joined =
      pcm.length >= LEVEL_WINDOW_BYTES ? pcm : Buffer.concat([this.#window, pcm]);
    this.#window = Buffer.from(joined.subarray(Math.max(0, joined.length - LEVEL_WINDOW_BYTES)));
  }

  /** Current input level, or undefined if nothing has arrived yet. */
  async level(): Promise<Level | undefined> {
    if (!this.#handle || this.#window.length < SAMPLE_BYTES) return undefined;
    return levelOf(this.#window);
  }

  async stop(): Promise<Recording> {
    const handle = this.#handle;
    const path = this.#path;
    if (!handle || !path) throw new AudioError("not recording");

    this.#clearTimer();
    // Patch the header before closing: the length fields were written as zero,
    // and a player that trusts them plays nothing at all.
    await handle.write(wavHeader(this.#bytes), 0, HEADER_BYTES, 0);
    await handle.close();
    this.#handle = undefined;

    const size = await stat(path).then((s) => s.size).catch(() => HEADER_BYTES + this.#bytes);
    const recording: Recording = {
      path,
      bytes: size,
      seconds: secondsOf(this.#bytes),
    };
    this.#window = Buffer.alloc(0);
    return recording;
  }

  /** Stop and discard. Used when a recording is abandoned rather than kept. */
  async cancel(): Promise<void> {
    this.#clearTimer();
    await this.#handle?.close().catch(() => {});
    this.#handle = undefined;
    if (this.#path) await rm(this.#path, { force: true }).catch(() => {});
    if (this.#owned && this.#dir) await rm(this.#dir, { recursive: true, force: true }).catch(() => {});
    this.#path = undefined;
    this.#window = Buffer.alloc(0);
  }

  #clearTimer(): void {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = undefined;
  }
}

/**
 * Capture devices.
 *
 * Only the renderer can enumerate them -- device discovery is a Web API, and
 * the main process has no access to it -- so the app installs a resolver at
 * startup. Left uninstalled it reports nothing, which is what a test wants and
 * what a headless run should see.
 */
let deviceResolver: () => Promise<AudioSource[]> = async () => [];

export function setDeviceResolver(fn: () => Promise<AudioSource[]>): void {
  deviceResolver = fn;
}

export async function listDevices(): Promise<AudioSource[]> {
  return await deviceResolver();
}
