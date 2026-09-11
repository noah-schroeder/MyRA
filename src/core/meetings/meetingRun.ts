/**
 * What happens after the meeting stops.
 *
 * Transcribe, assemble, write notes, file the report, offer the actions. It
 * runs for minutes rather than seconds, so every stage reports progress.
 *
 * Tracks are transcribed one after another, never in parallel. On an 8 GB card
 * two concurrent Whisper passes do not fit, and the failure mode is an
 * out-of-memory error at the end of a meeting that cannot be re-recorded.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deleteAudio, localDay, type MeetingRecord } from "./meeting.ts";
import { vocabularyPrompt, type MeetingContext } from "./meetingPrompts.ts";
import { generateNotes, type MeetingNotes, type VerifiedItem } from "./notes.ts";
import { transcribeDetailed, TranscriptionError } from "../stt.ts";
import {
  formatTranscript, joinRuns, mergeTracks, type Line, type TrackTranscript,
} from "./transcript.ts";
import type { EndpointSettings } from "../config.ts";

export class MeetingRunError extends Error {
  override readonly name = "MeetingRunError";
}

export type RunStage =
  | "transcribing"
  | "assembling"
  | "extracting"
  | "verifying"
  | "writing"
  | "filing"
  | "done";

export interface RunProgress {
  stage: RunStage;
  detail?: string;
  /** 0..1, for a progress bar that does not lie about what it knows. */
  fraction: number;
}

export interface TranscribeOptions {
  record: MeetingRecord;
  context: MeetingContext;
  transcription: EndpointSettings;
  transcriptionKey?: string;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}

export interface NoteOptions {
  record: MeetingRecord;
  context: MeetingContext;
  llm: EndpointSettings;
  llmKey?: string;
  /** The transcript to write from, as produced by `transcribeMeeting`. */
  lines: Line[];
  transcript: string;
  /** Directory for the report, relative to wherever `save` files things. */
  reportDir?: string;
  /** Remove the WAVs once a transcript exists. */
  deleteAudio?: boolean;
  /** Writes the note out, jailed by the caller. */
  save: (rel: string, content: string) => Promise<{ path: string; bytes: number }>;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}

export interface NoteResult {
  notes: MeetingNotes;
  /** Absolute path of the filed report. */
  reportPath: string;
  transcriptPath: string;
  actions: VerifiedItem[];
  audioDeleted: boolean;
}



/** Vault-safe name for the note: 2026-08-21-weekly-project-sync. */
export function noteName(record: MeetingRecord): string {
  const day = localDay(record.startedAt);
  const slug = basename(record.dir).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-?/, "");
  return slug ? `${day}-${slug}` : day;
}

/** How long the meeting ran, in words rather than seconds. */
export function duration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

/**
 * The report as it lands in the vault.
 *
 * Front matter first, so Obsidian can sort and filter meetings, then the notes
 * the model wrote, then the items that could not be sourced. That last section
 * is the honest part: an item whose quote is not in the transcript is shown
 * separately and labelled, never folded in with the rest as though it were
 * established.
 */
export function renderReport(
  record: MeetingRecord,
  notes: MeetingNotes,
  transcriptLink: string,
): string {
  const unverified = notes.items.filter((item) => item.sourcing === "unverified");
  const parts: string[] = [];

  parts.push(
    [
      "---",
      `title: ${JSON.stringify(record.title || "Untitled meeting")}`,
      `date: ${localDay(record.startedAt)}`,
      `duration: ${duration(record.seconds)}`,
      `actions: ${notes.actions.length}`,
      "tags: [meeting, myra]",
      "---",
    ].join("\n"),
  );

  parts.push(`# ${record.title || "Untitled meeting"}`);
  parts.push(
    `*${new Date(record.startedAt).toLocaleString()} · ${duration(record.seconds)} · ` +
      `[[${transcriptLink}|full transcript]]*`,
  );
  parts.push(notes.markdown);

  if (unverified.length > 0) {
    parts.push(
      [
        "## Unverified",
        "",
        "These were extracted but their supporting quote could not be found in the",
        "transcript. They may be real and paraphrased, or they may be invented.",
        "Check the recording before acting on any of them.",
        "",
        ...unverified.map((item) => `- **${item.type}** — ${item.title}${item.owner ? ` (${item.owner})` : ""}`),
      ].join("\n"),
    );
  }

  return `${parts.join("\n\n")}\n`;
}

/** The transcript file that the report links to. */
export function renderTranscript(record: MeetingRecord, transcript: string): string {
  return [
    "---",
    `title: ${JSON.stringify(`${record.title || "Untitled meeting"} — transcript`)}`,
    `date: ${localDay(record.startedAt)}`,
    "tags: [meeting, transcript, myra]",
    "---",
    "",
    `# ${record.title || "Untitled meeting"} — transcript`,
    "",
    "Machine transcription, unedited and unattributed. Timestamps are from the",
    "start of the recording.",
    "",
    "```text",
    transcript,
    "```",
    "",
  ].join("\n");
}

/**
 * Stage one: audio in, timed lines out.
 *
 * Split from note-taking because the two cost wildly different amounts. A
 * forty-minute meeting takes minutes to transcribe on a processor and seconds
 * to write notes from, and the note is the part people want to redo -- with a
 * different steer, a different model, or simply because the first attempt
 * missed something. Redoing the cheap step must not redo the expensive one.
 */
export async function transcribeMeeting(
  opts: TranscribeOptions,
): Promise<{ lines: Line[]; transcript: string }> {
  const { record, context } = opts;
  const report = (stage: RunStage, fraction: number, detail?: string) =>
    opts.onProgress?.({ stage, fraction, ...(detail ? { detail } : {}) });

  const vocabulary = vocabularyPrompt(context);
  const tracks: TrackTranscript[] = [];

  for (const [index, track] of record.tracks.entries()) {
    report(
      "transcribing",
      (index / Math.max(1, record.tracks.length)) * 0.7,
      record.tracks.length > 1 ? `track ${index + 1} of ${record.tracks.length}` : undefined,
    );

    let audio: Buffer;
    try {
      audio = await readFile(track.path);
    } catch (err) {
      throw new MeetingRunError(`the recording for ${track.label} could not be read: ${(err as Error).message}`);
    }

    try {
      const result = await transcribeDetailed({
        endpoint: opts.transcription,
        audio,
        filename: `${track.id}.wav`,
        ...(opts.transcriptionKey ? { apiKey: opts.transcriptionKey } : {}),
        ...(vocabulary ? { prompt: vocabulary } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // A track with no segments cannot be placed in time, so it cannot be
      // interleaved with the other one -- and silently dropping it would lose
      // half the meeting. Fail loudly instead.
      if (result.segments.length === 0 && record.tracks.length > 1) {
        throw new MeetingRunError(
          "The transcription model returned no timestamps, so the two recordings " +
            "cannot be interleaved. It needs to support response_format=verbose_json — " +
            "the Whisper models under Settings → Audio do.",
        );
      }
      tracks.push({
        id: track.id,
        label: track.label,
        segments: result.segments.length > 0 ? result.segments : [{ start: 0, end: track.seconds, text: result.text }],
      });
    } catch (err) {
      if (err instanceof TranscriptionError) throw new MeetingRunError(err.message);
      throw err;
    } finally {
      // The audio is not kept in memory a moment longer than it is needed.
      audio.fill(0);
    }
  }

  report("assembling", 0.9);
  // The sink monitor is the clean digital copy of the remote voices; where the
  // microphone caught the same words through a speaker, its version loses.
  const authoritative = record.tracks.find((t) => t.id !== "me")?.id;
  const lines = joinRuns(
    mergeTracks(tracks, authoritative ? { authoritative } : {}),
  );
  if (lines.length === 0) throw new MeetingRunError("The meeting transcribed to nothing at all.");
  report("done", 1);
  return { lines, transcript: formatTranscript(lines) };
}

/**
 * Stage two: timed lines in, a filed note out.
 *
 * Takes the transcript rather than the audio, so it can be run again as many
 * times as the user likes -- against a different model, or with different
 * instructions -- without touching the recording.
 */
export async function noteMeeting(opts: NoteOptions): Promise<NoteResult> {
  const { record, context, lines, transcript } = opts;
  const report = (stage: RunStage, fraction: number, detail?: string) =>
    opts.onProgress?.({ stage, fraction, ...(detail ? { detail } : {}) });

  const notes = await generateNotes({
    endpoint: opts.llm,
    context,
    lines,
    transcript,
    ...(opts.llmKey ? { apiKey: opts.llmKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (stage) =>
      report(stage, stage === "extracting" ? 0.2 : stage === "verifying" ? 0.6 : 0.75),
  });

  report("filing", 0.95);
  /* An empty string is a real answer: it means "the root you were given is the
     destination". Only an *absent* reportDir falls back to a subfolder, which
     is what a vault wants and a meeting's own directory does not. */
  const dir = opts.reportDir ?? "Meetings";
  const name = noteName(record);
  const transcriptRel = join(dir, `${name} — transcript.md`);
  const reportRel = join(dir, `${name}.md`);

  // The transcript is written first: the report links to it, and a link to a
  // file that does not exist is worse than no link.
  const transcriptFile = await opts.save(transcriptRel, renderTranscript(record, transcript));
  /*
   * The link names the file that was actually written, not the one we asked
   * for. `save` is allowed to rename -- filing into a meeting's own folder
   * writes `transcript.md` rather than a dated name -- and a wiki link built
   * from the requested name would then point at nothing.
   */
  const linkTarget = basename(transcriptFile.path).replace(/\.md$/, "");
  const reportFile = await opts.save(reportRel, renderReport(record, notes, linkTarget));

  let audioDeleted = false;
  if (opts.deleteAudio) {
    // Only now, with the transcript safely filed.
    await deleteAudio(record.dir);
    audioDeleted = true;
  }

  report("done", 1);
  return {
    notes,
    reportPath: reportFile.path,
    transcriptPath: transcriptFile.path,
    actions: notes.actions,
    audioDeleted,
  };
}

/*
 * There is no `runMeeting` any more.
 *
 * "Transcribe and take notes" is one button in the UI, but it is two calls: the
 * transcript is written to disk between them, so a failure while writing notes
 * leaves the expensive half done and the button offering only the cheap half
 * again. A combined function that held the transcript in memory would throw it
 * away on exactly the failure it most needs to survive.
 */
