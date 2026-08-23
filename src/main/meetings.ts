/**
 * Meetings, wired to the window.
 *
 * The split is: the renderer captures (device access is a Web API and only
 * exists there), this file owns the files and the run, and core does the work.
 *
 * v1 had main spawn two `pw-record` processes and tail their WAVs. The audio
 * now arrives here as PCM over IPC, which is why this file is mostly plumbing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ConfigStore } from "../core/config.ts";
import type { SecretVault } from "./secrets.ts";
import { MeetingRecorder, type MeetingRecord, type TrackSpec } from "../core/meetings/meeting.ts";
import { runMeeting, type RunProgress } from "../core/meetings/meetingRun.ts";
import { ipcMain } from "electron";

export interface MeetingDeps {
  config: ConfigStore;
  vault: SecretVault;
  send: (channel: string, payload?: unknown) => void;
}

type Phase = "idle" | "recording" | "processing" | "done" | "failed";

interface MeetingState {
  phase: Phase;
  title?: string;
  elapsedMs?: number;
  tracks?: string[];
  progress?: RunProgress;
  reportPath?: string;
  error?: string;
}

export function installMeetingIpc(deps: MeetingDeps): void {
  const { config, vault, send } = deps;
  let recorder: MeetingRecorder | undefined;
  let state: MeetingState = { phase: "idle" };

  const publish = (next: Partial<MeetingState>): void => {
    state = { ...state, ...next };
    send("karen:meeting", state);
  };

  const recorderFor = (): MeetingRecorder => {
    recorder ??= new MeetingRecorder({
      root: () => config.current.meetingsRoot,
      onTrackLost: (id, reason) => publish({ error: `${id}: ${reason}` }),
    });
    return recorder;
  };

  /**
   * Write into the vault, jailed to the configured subdirectory.
   *
   * The same rule as the document tools, applied to the one place the app
   * writes on the agent's behalf: resolve, then compare against the root. This
   * is not agent-reachable -- there is no tool for it -- but the report name is
   * derived from a meeting title the user typed, so it is still checked.
   */
  const saveToVault = async (rel: string, content: string): Promise<{ path: string; bytes: number }> => {
    const root = resolve(join(config.current.vaultRoot, config.current.vaultWriteSubdir));
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`refusing to write outside the vault: ${rel}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { path: abs, bytes: Buffer.byteLength(content, "utf8") };
  };

  const process_ = async (record: MeetingRecord): Promise<void> => {
    publish({ phase: "processing" });
    try {
      const settings = config.current;
      const result = await runMeeting({
        record,
        context: { title: record.title, date: record.startedAt },
        transcription: settings.transcription,
        llm: settings.llm,
        ...(await vault.get("transcriptionKey").then((k) => (k ? { transcriptionKey: k } : {}))),
        ...(await vault.get("llmKey").then((k) => (k ? { llmKey: k } : {}))),
        reportDir: settings.meetingReportDir,
        deleteAudio: settings.deleteRawAudioAfterTranscription,
        save: saveToVault,
        onProgress: (progress) => publish({ progress }),
      });
      publish({ phase: "done", reportPath: result.reportPath });
    } catch (err) {
      // The recording is still on disk. Say so, because the useful next step is
      // to retry the transcription, not to hold the meeting again.
      publish({
        phase: "failed",
        error: `${(err as Error).message} — the audio is still in ${record.dir}`,
      });
    }
  };

  ipcMain.handle("karen:meeting-state", () => state);

  ipcMain.handle("karen:meeting-start", async (_e, title: string, tracks: TrackSpec[]) => {
    const id = await recorderFor().start(String(title ?? "Meeting"), tracks);
    publish({ phase: "recording", title: String(title ?? "Meeting"), tracks: tracks.map((t) => t.id) });
    return id;
  });

  ipcMain.handle("karen:meeting-audio", async (_e, trackId: string, pcm: ArrayBuffer) => {
    await recorderFor().write(String(trackId), Buffer.from(pcm));
  });

  ipcMain.handle("karen:meeting-levels", () => recorderFor().levels());

  ipcMain.handle("karen:meeting-stop", async () => {
    const record = await recorderFor().stop();
    // Deliberately not awaited: transcription takes minutes and the renderer
    // must not sit on a blocked IPC call for that long.
    void process_(record);
    return record;
  });

  ipcMain.handle("karen:meeting-discard", async () => {
    await recorderFor().discard();
    // Replaced wholesale rather than patched: a discard must clear the title,
    // the progress and any error, and a partial patch would leave one behind.
    state = { phase: "idle" };
    send("karen:meeting", state);
  });
}
