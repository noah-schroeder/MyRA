/**
 * Meetings on disk, and what has been done to each one.
 *
 * Recording, transcribing and note-taking used to be one indivisible act: you
 * pressed stop and, minutes later, either a note appeared in the vault or an
 * error did. Nothing was listed anywhere afterwards, so a meeting whose
 * transcription failed was simply gone as far as the app was concerned, even
 * though the audio was sitting on disk the whole time.
 *
 * So each stage now leaves its own artifact in the meeting's own directory, and
 * the directory is the record:
 *
 *   meeting.json      the recording — written by MeetingRecorder
 *   me.wav, them.wav  the audio
 *   myra.json        what has been done since, and the note instructions
 *   transcript.json   timed lines, so notes can be redone without re-transcribing
 *   transcript.md     the readable transcript
 *   notes.md          the note
 *   actions.json      the note's action items, so a checked "create task" box
 *                      survives a restart instead of offering to create the
 *                      same task twice
 *
 * Reading a directory tells you exactly which of the three buttons to offer,
 * which is the whole point: transcription is expensive and note-taking is
 * cheap, and redoing the cheap one with a different prompt must not redo the
 * expensive one.
 */

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeetingRecord } from "./meeting.ts";
import type { VerifiedItem } from "./notes.ts";
import type { Line } from "./transcript.ts";
import { OWNER_ONLY_FILE } from "../paths.ts";

export const RECORD_FILE = "meeting.json";
export const STATE_FILE = "myra.json";
export const TRANSCRIPT_FILE = "transcript.json";
export const TRANSCRIPT_MD = "transcript.md";
export const NOTES_MD = "notes.md";
export const ACTIONS_FILE = "actions.json";
/**
 * Every verified item the notes run extracted -- decisions, questions, risks
 * and updates as well as actions -- so a meeting filed to a research project
 * can offer them to its notes. `notes.md` has them only as prose, and reading
 * prose back into items is the reconstruction the grounding exists to avoid.
 */
export const ITEMS_FILE = "items.json";

/** An action item as notes.ts extracted and verified it, plus whether it has
 *  already become a MyRA task. `taskId` is the done-marker: once set, the
 *  page must not offer to create it again. */
export interface ActionRecord extends VerifiedItem {
  taskId?: string | undefined;
}

/* Optionals written `?: T | undefined` throughout: clearing a field by assigning
   undefined -- "this no longer failed" -- is otherwise a type error under
   exactOptionalPropertyTypes, and clearing is exactly what a retry does. */
export interface MeetingState {
  /** The steer sent to the model when notes are written. Per meeting. */
  instructions?: string | undefined;
  transcribedAt?: string | undefined;
  /** Which endpoint or model produced the transcript, for the record. */
  transcriptModel?: string | undefined;
  notedAt?: string | undefined;
  notesModel?: string | undefined;
  /** Where the note was filed outside the meeting directory, if anywhere. */
  filedNotePath?: string | undefined;
  filedTranscriptPath?: string | undefined;
  /** The last failure, kept so the page can show why rather than going quiet. */
  error?: string | undefined;
}

export interface StoredTranscript {
  lines: Line[];
  text: string;
}

/** A meeting as the list shows it. */
export interface MeetingSummary {
  id: string;
  dir: string;
  title: string;
  startedAt: string;
  seconds: number;
  tracks: string[];
  /** False once the audio has been deleted, which is allowed after transcribing. */
  hasAudio: boolean;
  audioBytes: number;
  transcribed: boolean;
  noted: boolean;
  /** Whether the notes run saved its items (`items.json`) -- runs before it did saved only prose. */
  itemized: boolean;
  state: MeetingState;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function readRecord(dir: string): Promise<MeetingRecord | undefined> {
  return await readJson<MeetingRecord>(join(dir, RECORD_FILE));
}

export async function readState(dir: string): Promise<MeetingState> {
  return (await readJson<MeetingState>(join(dir, STATE_FILE))) ?? {};
}

export async function writeState(dir: string, patch: Partial<MeetingState>): Promise<MeetingState> {
  const next = { ...(await readState(dir)), ...patch };
  // Undefined keys mean "clear this", which JSON.stringify already drops; the
  // point of merging first is that a step must not erase what another wrote.
  await writeFile(join(dir, STATE_FILE), JSON.stringify(next, null, 2) + "\n", {
    encoding: "utf8",
    mode: OWNER_ONLY_FILE,
  });
  return next;
}

export async function readTranscript(dir: string): Promise<StoredTranscript | undefined> {
  return await readJson<StoredTranscript>(join(dir, TRANSCRIPT_FILE));
}

export async function writeTranscript(dir: string, stored: StoredTranscript): Promise<void> {
  await writeFile(join(dir, TRANSCRIPT_FILE), JSON.stringify(stored, null, 2) + "\n", {
    encoding: "utf8",
    mode: OWNER_ONLY_FILE,
  });
}

export async function readNotes(dir: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, NOTES_MD), "utf8");
  } catch {
    return undefined;
  }
}

/** `[]` for a meeting with no action items, one noted before this file
 *  existed, or a record that fails to parse -- the same forgiving read every
 *  other artifact here gets, since a truncated actions.json is a reason to
 *  show no action panel, not a reason to hide the whole meeting. */
export async function readActions(dir: string): Promise<ActionRecord[]> {
  return (await readJson<ActionRecord[]>(join(dir, ACTIONS_FILE))) ?? [];
}

export async function readItems(dir: string): Promise<VerifiedItem[] | undefined> {
  const raw = await readJson<unknown>(join(dir, ITEMS_FILE));
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((it): it is VerifiedItem => {
    const row = it as Record<string, unknown>;
    return Boolean(row) && typeof row["title"] === "string" && typeof row["type"] === "string" && typeof row["quote"] === "string";
  });
}

export async function writeItems(dir: string, items: VerifiedItem[]): Promise<void> {
  await writeFile(join(dir, ITEMS_FILE), JSON.stringify(items, null, 2) + "\n", {
    encoding: "utf8",
    mode: OWNER_ONLY_FILE,
  });
}

export async function writeActions(dir: string, items: ActionRecord[]): Promise<void> {
  await writeFile(join(dir, ACTIONS_FILE), JSON.stringify(items, null, 2) + "\n", {
    encoding: "utf8",
    mode: OWNER_ONLY_FILE,
  });
}

async function bytesIn(dir: string): Promise<{ bytes: number; wavs: number }> {
  let bytes = 0;
  let wavs = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
      wavs++;
      bytes += (await stat(join(dir, entry.name))).size;
    }
  } catch {
    // A directory that vanished mid-scan is not an error worth failing over.
  }
  return { bytes, wavs };
}

/**
 * Every meeting under the root, newest first.
 *
 * A directory without a `meeting.json` is skipped rather than guessed at: it is
 * either a recording that was interrupted before it could be finalised, or not
 * a meeting at all, and inventing a summary for it would put a row on the page
 * that no button could act on.
 */
export async function listMeetings(root: string): Promise<MeetingSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: MeetingSummary[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    const record = await readRecord(dir);
    if (!record) continue;
    const state = await readState(dir);
    const { bytes, wavs } = await bytesIn(dir);
    out.push({
      id: record.id || name,
      dir,
      title: record.title || "Untitled meeting",
      startedAt: record.startedAt,
      seconds: record.seconds,
      tracks: (record.tracks ?? []).map((t) => t.label),
      hasAudio: wavs > 0,
      audioBytes: bytes,
      transcribed: (await readTranscript(dir)) !== undefined,
      noted: (await readNotes(dir)) !== undefined,
      itemized: (await readItems(dir)) !== undefined,
      state,
    });
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** Remove a meeting and everything in it. */
export async function deleteMeeting(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Where a meeting's output is filed.
 *
 * The vault when there is one, and the meeting's own directory when there is
 * not. The previous behaviour was worse than either: with no vault configured,
 * `resolve(join("", "MyRA"))` is `<working directory>/MyRA`, so notes were
 * written next to whatever the app happened to be launched from. Nobody would
 * find them there, and on a packaged build that path is not writable.
 */
export function filingRoot(vaultRoot: string, subdir: string, meetingDir: string): string {
  return vaultRoot.trim() ? join(vaultRoot, subdir) : meetingDir;
}
