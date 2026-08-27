/**
 * Meeting capture.
 *
 * Recording only. Nothing is transcribed while a meeting is running and no
 * model is loaded -- the whole point of doing this in one pass at the end is
 * that on an 8 GB card the transcription model and the model that writes the
 * notes cannot both be resident. So this module's only job is to end up with
 * complete, valid WAVs on disk, and to be boring about it.
 *
 * Tracks are a list rather than a fixed pair. One track (the microphone) is the
 * simple case; a second (the output sink's monitor, i.e. everyone who is not in
 * the room) is what makes "who committed to this" answerable without a
 * diarization model. The recorder does not care which it was given.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listDevices, Recorder, type AudioSource, type Recording } from "./capture.ts";
import { OWNER_ONLY_FILE, makePrivateDir } from "../paths.ts";

/** Meetings run long. This is a runaway guard, not an expected limit. */
const MAX_HOURS = 6;

export interface TrackSpec {
  /** Stable identifier used for the filename and in the transcript. */
  id: string;
  /** What to call this voice in the notes. */
  label: string;
  /** Capture device id, as the renderer reports it. Omitted means the default. */
  source?: string;
}

export interface TrackResult extends Recording {
  id: string;
  label: string;
}

export interface MeetingRecord {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  dir: string;
  tracks: TrackResult[];
  /** Tracks that were asked for but produced nothing usable, and why. */
  failed: { id: string; label: string; reason: string }[];
}

/**
 * A filesystem-safe, sortable meeting id: 2026-08-21T14-05-33.
 *
 * Local time, not UTC. A meeting at six in the evening is filed under the day
 * the person had it, and `toISOString` would file it under tomorrow for
 * everyone west of Greenwich — which is exactly when they would go looking for
 * it under today.
 */
export function meetingId(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  );
}

/** The local calendar day a meeting happened on: 2026-08-21. */
export function localDay(iso: string): string {
  return meetingId(new Date(iso)).slice(0, 10);
}

/**
 * Strip a title down to something that can be a directory name.
 *
 * Meeting titles are typed by a person and land on disk, so they arrive with
 * slashes, colons and emoji in them.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug;
}

export class MeetingError extends Error {
  override readonly name = "MeetingError";
}

export interface MeetingOptions {
  /**
   * Where meetings are kept. One directory per meeting beneath it.
   *
   * A function, so that changing the folder in Settings takes effect on the
   * next meeting rather than on the next app start.
   */
  root: string | (() => string);
  /** Called when a track stops on its own, so the UI can say so. */
  onTrackLost?: (id: string, reason: string) => void;
  /** Injectable for tests; defaults to asking PipeWire for every device. */
  listSources?: () => Promise<AudioSource[]>;
}

/**
 * Check the requested devices exist before recording a word.
 *
 * Established against a live PipeWire rather than assumed: `pw-record --target`
 * pointed at a node that does not exist does NOT fail. It falls back to the
 * default source and records happily, so a meeting configured with a stale sink
 * monitor id would capture the microphone twice and the second "voice" would be
 * an echo of the first -- discovered, as ever, at the transcript.
 *
 * If the devices cannot be listed at all we record anyway and let the caller
 * warn: an unverifiable device is a guess, but a meeting missed is not
 * recoverable and a meeting recorded from the wrong device usually is.
 */
export async function unknownSources(
  tracks: TrackSpec[],
  list: () => Promise<AudioSource[]> = listDevices,
): Promise<string[]> {
  const wanted = tracks.filter((t) => t.source !== undefined && t.source !== "");
  if (wanted.length === 0) return [];

  let sources: AudioSource[];
  try {
    sources = await list();
  } catch {
    return [];
  }
  if (sources.length === 0) return [];

  const known = new Set<string>();
  for (const source of sources) {
    known.add(String(source.id));
    known.add(source.name);
  }
  return wanted.filter((t) => !known.has(String(t.source))).map((t) => t.label);
}

/**
 * One meeting, being recorded.
 *
 * Failure policy: a meeting where one track died is still worth keeping. The
 * usual case is the sink monitor -- there is nothing to monitor until something
 * plays -- and throwing the microphone away because of it would be the wrong
 * trade every time.
 */
export class MeetingRecorder {
  readonly #opts: MeetingOptions;
  #recorders = new Map<string, { recorder: Recorder; spec: TrackSpec }>();
  #lost = new Map<string, string>();
  #id: string | undefined;
  #title = "";
  #dir: string | undefined;
  #startedAt: Date | undefined;

  constructor(opts: MeetingOptions) {
    this.#opts = opts;
  }

  get recording(): boolean {
    return this.#id !== undefined;
  }

  get id(): string | undefined {
    return this.#id;
  }

  get dir(): string | undefined {
    return this.#dir;
  }

  get elapsedMs(): number {
    return this.#startedAt ? Date.now() - this.#startedAt.getTime() : 0;
  }

  /**
   * Append captured audio to one track.
   *
   * Called from the IPC handler as the renderer streams PCM in. A chunk for a
   * track that has already stopped is dropped rather than thrown: the renderer
   * cannot know the exact moment the user clicked stop, and a late chunk is
   * normal rather than exceptional.
   */
  async write(trackId: string, pcm: Buffer): Promise<void> {
    await this.#recorders.get(trackId)?.recorder.write(pcm);
  }

  /** Track ids currently recording. */
  get trackIds(): string[] {
    return [...this.#recorders.keys()];
  }

  /** Live input levels, one per track that is still running. */
  async levels(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [id, { recorder }] of this.#recorders) {
      const level = await recorder.level();
      if (level) out[id] = level.rms;
    }
    return out;
  }

  /**
   * Begin.
   *
   * Every track must start, or none does: a meeting that silently recorded half
   * of what was asked for is discovered at the transcript, which is far too
   * late to do anything about it.
   */
  async start(title: string, tracks: TrackSpec[]): Promise<string> {
    if (this.#id) throw new MeetingError("a meeting is already being recorded");
    if (tracks.length === 0) throw new MeetingError("a meeting needs at least one track");

    const seen = new Set<string>();
    for (const track of tracks) {
      if (seen.has(track.id)) throw new MeetingError(`duplicate track id: ${track.id}`);
      seen.add(track.id);
    }

    const missing = await unknownSources(tracks, this.#opts.listSources ?? listDevices);
    if (missing.length > 0) {
      throw new MeetingError(
        `no such audio device for ${missing.join(" and ")} — pick one in Settings, ` +
          `because pw-record would otherwise record the default device instead and say nothing`,
      );
    }

    const startedAt = new Date();
    const id = meetingId(startedAt);
    const slug = slugify(title);
    const root = typeof this.#opts.root === "function" ? this.#opts.root() : this.#opts.root;
    const dir = join(root, slug ? `${id}-${slug}` : id);
    await makePrivateDir(dir);

    const started: string[] = [];
    for (const spec of tracks) {
      const recorder = new Recorder();
      try {
        await recorder.start({
          dir,
          name: spec.id,
          maxSeconds: MAX_HOURS * 3600,
          ...(spec.source !== undefined && spec.source !== "" ? { source: spec.source } : {}),
          onAutoStop: () => {
            this.#lost.set(spec.id, `stopped after ${MAX_HOURS} hours`);
            this.#opts.onTrackLost?.(spec.id, `stopped after ${MAX_HOURS} hours`);
          },
        });
      } catch (err) {
        // Unwind: stop what did start, and take the directory with it, so a
        // failed start leaves nothing behind to be mistaken for a recording.
        for (const id of started) await this.#recorders.get(id)?.recorder.cancel();
        this.#recorders.clear();
        await rm(dir, { recursive: true, force: true });
        throw new MeetingError(`could not record ${spec.label}: ${(err as Error).message}`);
      }
      this.#recorders.set(spec.id, { recorder, spec });
      started.push(spec.id);
    }

    this.#id = id;
    this.#title = title;
    this.#dir = dir;
    this.#startedAt = startedAt;
    this.#lost.clear();
    return id;
  }

  /** Stop every track and describe what was captured. */
  async stop(): Promise<MeetingRecord> {
    const id = this.#id;
    const dir = this.#dir;
    const startedAt = this.#startedAt;
    if (!id || !dir || !startedAt) throw new MeetingError("no meeting is being recorded");

    const tracks: TrackResult[] = [];
    const failed: MeetingRecord["failed"] = [];
    for (const [trackId, { recorder, spec }] of this.#recorders) {
      try {
        const recording = await recorder.stop();
        tracks.push({ ...recording, id: trackId, label: spec.label });
      } catch (err) {
        failed.push({ id: trackId, label: spec.label, reason: this.#lost.get(trackId) ?? (err as Error).message });
      }
    }
    this.#recorders.clear();

    const endedAt = new Date();
    const record: MeetingRecord = {
      id,
      title: this.#title,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      seconds: (endedAt.getTime() - startedAt.getTime()) / 1000,
      dir,
      tracks,
      failed,
    };

    this.#id = undefined;
    this.#dir = undefined;
    this.#startedAt = undefined;
    this.#title = "";

    if (tracks.length === 0) {
      // Nothing was captured at all; there is no meeting to keep.
      await rm(dir, { recursive: true, force: true });
      throw new MeetingError(
        failed.map((f) => `${f.label}: ${f.reason}`).join("; ") || "the meeting captured no audio",
      );
    }

    // The manifest is written before anything is transcribed, so a meeting that
    // is interrupted afterwards can still be found and picked up by hand.
    await writeFile(join(dir, "meeting.json"), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: OWNER_ONLY_FILE,
    });
    return record;
  }

  /** Abandon a meeting and delete what it recorded. */
  async discard(): Promise<void> {
    const dir = this.#dir;
    for (const { recorder } of this.#recorders.values()) await recorder.cancel();
    this.#recorders.clear();
    this.#id = undefined;
    this.#dir = undefined;
    this.#startedAt = undefined;
    this.#title = "";
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Delete a meeting's audio, keeping everything written about it.
 *
 * This is the "delete raw audio after transcription" setting. It removes the
 * WAVs only: the transcript, the notes and the manifest are the point of having
 * had the meeting, and deleting those would be deleting the work.
 */
export async function deleteAudio(dir: string): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".wav")) continue;
    await rm(join(dir, entry), { force: true });
    removed++;
  }
  return removed;
}

/**
 * The tracks a meeting records, given the settings.
 *
 * The microphone always. The system's output as well, unless it is turned off:
 * a microphone alone records the person wearing the headphones and nobody
 * else, so on a remote call that single track is one side of a conversation.
 * The user configures nothing -- the default output device is followed, which
 * is also what changes when they plug headphones in.
 */
export function defaultTracks(
  options: { source?: string; systemAudio?: boolean; sink?: AudioSource | undefined },
): TrackSpec[] {
  const tracks: TrackSpec[] = [
    { id: "me", label: "Me", ...(options.source ? { source: options.source } : {}) },
  ];
  if (options.systemAudio !== false && options.sink) {
    tracks.push({ id: "them", label: "Everyone else", source: options.sink.id });
  }
  return tracks;
}

/** Total bytes of audio a meeting is holding on disk. */
export async function audioBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".wav")) continue;
    total += (await stat(join(dir, entry))).size;
  }
  return total;
}
