/**
 * Microphone capture, on the host.
 *
 * All audio is host-side: the VM has no reason to hear anything, and routing a
 * microphone into it would widen the sandbox for no benefit. The agent never
 * touches this module -- dictation is a user action, not a tool call.
 *
 * Capture is `pw-record`, spawned directly rather than through a shell. Two
 * details were established against a live PipeWire rather than assumed:
 *
 *  - SIGTERM finalises the WAV header correctly, so a recording stopped by the
 *    hotkey is a valid file. SIGKILL would leave the data chunk size stale.
 *  - the signal must reach pw-record ITSELF. Signalling a wrapper leaves the
 *    recorder running, and a second recording then races the first on the same
 *    file -- which produced a WAV whose declared length disagreed with its
 *    contents by four seconds of audio.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { levelOf, pcmStart, type Level } from "./meter.ts";

const execFileAsync = promisify(execFile);

/** Whisper-family endpoints want 16 kHz mono; anything more is wasted upload. */
const RATE = 16_000;
const CHANNELS = 1;
const FORMAT = "s16";

/**
 * The most audio one meter reading looks at: 0.5 s at 16 kHz mono.
 *
 * A window this size bounds the work per tick and, more importantly, keeps the
 * meter current -- if a tick is late the reading skips ahead rather than
 * dutifully reporting what the microphone heard a second ago.
 */
const MAX_WINDOW = RATE * 2 * 0.5;

/** A recording longer than this is almost certainly a hotkey left latched. */
const MAX_SECONDS = 10 * 60;

export class AudioError extends Error {
  override readonly name = "AudioError";
}

export interface AudioSource {
  id: number;
  name: string;
  description: string;
  /** True for the node PipeWire currently treats as the default. */
  isDefault?: boolean;
}

/**
 * Capture devices, from `pw-dump`.
 *
 * `wpctl status` is the human-facing view and is a tree meant for reading;
 * pw-dump is JSON and does not need parsing by eye.
 */
export async function listSources(): Promise<AudioSource[]> {
  return (await audioNodes()).sources;
}

/**
 * Every node a recording may target: capture devices and output monitors alike.
 *
 * Both, because `pw-record --target` accepts either -- a sink id records that
 * sink's monitor. Validating a meeting's tracks against the sources alone would
 * reject the system-audio track for naming a device that plainly exists.
 */
export async function listDevices(): Promise<AudioSource[]> {
  const { sources, sinks } = await audioNodes();
  return [...sources, ...sinks];
}

/**
 * Output devices, whose monitors are how the rest of a meeting is captured.
 *
 * `pw-record --target <sink>` records that sink's monitor -- everything being
 * played, which in a remote meeting is everyone who is not in the room.
 * Verified against a live PipeWire by playing a tone and reading it back.
 */
export async function listSinks(): Promise<AudioSource[]> {
  return (await audioNodes()).sinks;
}

/**
 * The sink PipeWire currently treats as the default.
 *
 * Read from its metadata rather than guessed, so "record the system audio"
 * follows the device the user is actually listening on -- which changes the
 * moment they plug in headphones, quite possibly mid-meeting.
 */
export async function defaultSink(): Promise<AudioSource | undefined> {
  const { sinks, defaultSinkName } = await audioNodes();
  return sinks.find((s) => s.name === defaultSinkName) ?? sinks[0];
}

interface AudioNodes {
  sources: AudioSource[];
  sinks: AudioSource[];
  defaultSinkName?: string;
  defaultSourceName?: string;
}

async function audioNodes(): Promise<AudioNodes> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync("pw-dump", [], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    raw = stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new AudioError("pw-dump is not installed (package: pipewire-bin)");
    throw new AudioError(`could not list audio devices: ${(err as Error).message}`);
  }

  let objects: unknown[];
  try {
    objects = JSON.parse(raw) as unknown[];
  } catch {
    throw new AudioError("pw-dump returned something that is not JSON");
  }

  const result: AudioNodes = { sources: [], sinks: [] };
  for (const o of objects) {
    const node = o as {
      id?: number;
      type?: string;
      info?: { props?: Record<string, unknown> };
      metadata?: { key?: string; value?: unknown }[];
    };

    if (node.type === "PipeWire:Interface:Metadata") {
      for (const entry of node.metadata ?? []) {
        const value = entry.value as { name?: unknown } | undefined;
        const name = typeof value?.name === "string" ? value.name : undefined;
        if (entry.key === "default.audio.sink" && name) result.defaultSinkName = name;
        if (entry.key === "default.audio.source" && name) result.defaultSourceName = name;
      }
      continue;
    }

    if (node.type !== "PipeWire:Interface:Node" || typeof node.id !== "number") continue;
    const props = node.info?.props ?? {};
    const mediaClass = String(props["media.class"] ?? "");
    const name = String(props["node.name"] ?? "");
    const entry: AudioSource = {
      id: node.id,
      name,
      description: String(props["node.description"] ?? (name || `node ${node.id}`)),
    };
    if (mediaClass.includes("Audio/Source")) result.sources.push(entry);
    else if (mediaClass.includes("Audio/Sink")) result.sinks.push(entry);
  }

  for (const source of result.sources) {
    if (source.name === result.defaultSourceName) source.isDefault = true;
  }
  for (const sink of result.sinks) {
    if (sink.name === result.defaultSinkName) sink.isDefault = true;
  }
  return result;
}

export interface RecordOptions {
  /** PipeWire node id or name. Omitted means the system default. */
  source?: number | string;
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
 * One recording in flight.
 *
 * Deliberately a single instance rather than a set: dictation is one microphone
 * and one composer, and a second concurrent recording would produce two
 * transcripts racing for the same text box.
 */
export class Recorder {
  #child: ChildProcess | undefined;
  #dir: string | undefined;
  #path: string | undefined;
  #startedAt = 0;
  #stopTimer: NodeJS.Timeout | undefined;
  #onAutoStop: (() => void) | undefined;
  /** Whether this recorder made the directory, and so may delete it. */
  #owned = true;
  /** Open only while metering; the recording does not depend on it. */
  #meter: FileHandle | undefined;
  /** How far into the file the meter has read. -1 until the header is parsed. */
  #read = -1;

  get recording(): boolean {
    return this.#child !== undefined;
  }

  get elapsedMs(): number {
    return this.#startedAt ? Date.now() - this.#startedAt : 0;
  }

  /**
   * Begin capturing.
   *
   * A fresh directory per recording by default, so a previous file can never be
   * partially overwritten and read back as the new one. A caller that needs the
   * audio to outlive the recording -- a meeting, which is kept until it has been
   * transcribed -- passes its own directory instead.
   */
  async start(options: RecordOptions = {}): Promise<void> {
    if (this.#child) throw new AudioError("already recording");

    const { source: sourceId, onAutoStop, maxSeconds = MAX_SECONDS, name = "dictation" } = options;
    const owned = options.dir === undefined;
    const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "karen-dictation-")));
    const path = join(dir, `${name}.wav`);
    const args = ["--rate", String(RATE), "--channels", String(CHANNELS), "--format", FORMAT];
    if (sourceId !== undefined && sourceId !== "") args.push("--target", String(sourceId));
    args.push(path);

    const child = spawn("pw-record", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });

    // A spawn failure arrives asynchronously, so the caller learns about a
    // missing pw-record here rather than from an empty file later.
    const failed = await new Promise<Error | undefined>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) =>
        resolve(
          err.code === "ENOENT"
            ? new AudioError("pw-record is not installed (package: pipewire-bin)")
            : new AudioError(err.message),
        );
      child.once("error", onError);
      // Nothing failed within a beat: treat it as started.
      setTimeout(() => {
        child.removeListener("error", onError);
        resolve(child.exitCode === null ? undefined : new AudioError(stderr.trim() || "pw-record exited immediately"));
      }, 250);
    });
    if (failed) {
      // Only tidy up a directory this recorder made; one handed in belongs to
      // the caller and may already hold another track of the same meeting.
      if (owned) await rm(dir, { recursive: true, force: true });
      throw failed;
    }

    this.#child = child;
    this.#dir = dir;
    this.#path = path;
    this.#startedAt = Date.now();
    this.#onAutoStop = onAutoStop;
    this.#owned = owned;
    this.#read = -1;

    // A latched hotkey should not fill the disk overnight.
    this.#stopTimer = setTimeout(() => {
      if (this.#child) this.#onAutoStop?.();
    }, maxSeconds * 1000);
  }

  /** Stop and return the finished file. */
  async stop(): Promise<Recording> {
    const child = this.#child;
    const dir = this.#dir;
    const path = this.#path;
    if (!child || !dir || !path) throw new AudioError("not recording");

    clearTimeout(this.#stopTimer);
    await this.#closeMeter();
    const seconds = this.elapsedMs / 1000;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      // SIGTERM, never SIGKILL: pw-record rewrites the WAV header on the way
      // out, and killing it outright leaves the data chunk size stale.
      child.kill("SIGTERM");
      // If it will not go quietly, take the file as it stands rather than hang.
      setTimeout(() => {
        child.removeListener("exit", done);
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
    });

    this.#child = undefined;
    this.#dir = undefined;
    this.#path = undefined;
    this.#startedAt = 0;

    const owned = this.#owned;
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      if (owned) await rm(dir, { recursive: true, force: true });
      throw new AudioError("the recording produced no file");
    }
    // A WAV header alone is 44 bytes; anything at that size caught no audio.
    if (bytes <= 64) {
      if (owned) await rm(dir, { recursive: true, force: true });
      throw new AudioError("the recording was empty — check the microphone is not muted");
    }
    return { path, bytes, seconds };
  }

  /** Abandon a recording without transcribing it. */
  async cancel(): Promise<void> {
    if (!this.#child) return;
    await this.#closeMeter();
    const dir = this.#dir;
    try {
      await this.stop();
    } catch {
      /* the file is being discarded anyway */
    }
    if (dir && this.#owned) await rm(dir, { recursive: true, force: true });
  }

  /**
   * The loudest and average level captured since the last call.
   *
   * Read by tailing the file pw-record is writing rather than by intercepting
   * the audio: the capture path is left exactly as it was verified, and every
   * failure here is swallowed. A meter that throws must never be the reason a
   * recording is lost -- the worst it may do is stop moving.
   */
  async level(): Promise<Level | undefined> {
    if (!this.#child || !this.#path) return undefined;
    try {
      this.#meter ??= await open(this.#path, "r");

      if (this.#read < 0) {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await this.#meter.read(head, 0, head.length, 0);
        const start = pcmStart(head.subarray(0, bytesRead));
        // The header is not written yet; there is nothing to measure either.
        if (start < 0) return undefined;
        this.#read = start;
      }

      const size = (await this.#meter.stat()).size;
      let from = this.#read;
      // Fall behind and the meter shows what was said a second ago, which is
      // worse than showing nothing: skip forward and stay honest about "now".
      if (size - from > MAX_WINDOW) from = size - MAX_WINDOW;
      // Samples are two bytes; an odd offset would read them shifted, turning
      // quiet audio into noise.
      if (from % 2 !== this.#read % 2) from += 1;
      const span = size - from;
      if (span < 2) return undefined;

      const pcm = Buffer.alloc(span - (span % 2));
      const { bytesRead } = await this.#meter.read(pcm, 0, pcm.length, from);
      this.#read = from + bytesRead;
      return levelOf(pcm.subarray(0, bytesRead - (bytesRead % 2)));
    } catch {
      return undefined;
    }
  }

  async #closeMeter(): Promise<void> {
    const handle = this.#meter;
    this.#meter = undefined;
    this.#read = -1;
    try {
      await handle?.close();
    } catch {
      /* the file is going away regardless */
    }
  }

  /** Read the finished audio and delete it from disk. */
  async take(recording: Recording): Promise<Buffer> {
    const bytes = await readFile(recording.path);
    await rm(join(recording.path, ".."), { recursive: true, force: true });
    return bytes;
  }
}
