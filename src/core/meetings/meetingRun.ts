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

export interface RunOptions {
  record: MeetingRecord;
  context: MeetingContext;
  transcription: EndpointSettings;
  llm: EndpointSettings;
  transcriptionKey?: string;
  llmKey?: string;
  /** Vault-relative directory for the report, e.g. "Meetings". */
  reportDir?: string;
  /** Remove the WAVs once a transcript exists. */
  deleteAudio?: boolean;
  /** Writes into the vault, jailed and audited by the broker. */
  save: (rel: string, content: string) => Promise<{ path: string; bytes: number }>;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  notes: MeetingNotes;
  transcript: string;
  lines: Line[];
  /** Absolute path of the report in the vault. */
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
      "tags: [meeting, karen]",
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
    "tags: [meeting, transcript, karen]",
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

export async function runMeeting(opts: RunOptions): Promise<RunResult> {
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
          "The transcription endpoint returned no timestamps, so the two recordings " +
            "cannot be interleaved. It needs to support response_format=verbose_json.",
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

  report("assembling", 0.72);
  // The sink monitor is the clean digital copy of the remote voices; where the
  // microphone caught the same words through a speaker, its version loses.
  const authoritative = record.tracks.find((t) => t.id !== "me")?.id;
  const lines = joinRuns(
    mergeTracks(tracks, authoritative ? { authoritative } : {}),
  );
  if (lines.length === 0) throw new MeetingRunError("The meeting transcribed to nothing at all.");
  const transcript = formatTranscript(lines);

  const notes = await generateNotes({
    endpoint: opts.llm,
    context,
    lines,
    transcript,
    ...(opts.llmKey ? { apiKey: opts.llmKey } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (stage) =>
      report(stage, stage === "extracting" ? 0.75 : stage === "verifying" ? 0.85 : 0.88),
  });

  report("filing", 0.95);
  const dir = opts.reportDir || "Meetings";
  const name = noteName(record);
  const transcriptRel = join(dir, `${name} — transcript.md`);
  const reportRel = join(dir, `${name}.md`);

  // The transcript is written first: the report links to it, and a link to a
  // file that does not exist is worse than no link.
  const transcriptFile = await opts.save(transcriptRel, renderTranscript(record, transcript));
  const reportFile = await opts.save(
    reportRel,
    renderReport(record, notes, transcriptRel.replace(/\.md$/, "")),
  );

  let audioDeleted = false;
  if (opts.deleteAudio) {
    // Only now, with the transcript safely in the vault.
    await deleteAudio(record.dir);
    audioDeleted = true;
  }

  report("done", 1);
  return {
    notes,
    transcript,
    lines,
    reportPath: reportFile.path,
    transcriptPath: transcriptFile.path,
    actions: notes.actions,
    audioDeleted,
  };
}
