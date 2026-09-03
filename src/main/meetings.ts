/**
 * Meetings, wired to the window.
 *
 * The split is: the renderer captures (device access is a Web API and only
 * exists there), this file owns the files and the stages, and core does the
 * work.
 *
 * The three stages are separate on purpose. Recording, transcribing and writing
 * notes used to be one indivisible act -- press stop, wait minutes, get either
 * a note or an error -- and a failure at any point lost the whole meeting from
 * the app's point of view even though the audio was on disk. Now each stage
 * leaves an artifact in the meeting's directory, the page lists what is there,
 * and any stage can be run again on its own.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ipcMain, shell } from "electron";

import type { ConfigStore, EndpointSettings } from "../core/config.ts";
import { MeetingRecorder, type MeetingRecord, type TrackSpec } from "../core/meetings/meeting.ts";
import {
  noteMeeting, renderTranscript, transcribeMeeting, type RunProgress,
} from "../core/meetings/meetingRun.ts";
import {
  deleteMeeting, filingRoot, listMeetings, readRecord, readState, readTranscript,
  writeState, writeTranscript, NOTES_MD, TRANSCRIPT_MD,
} from "../core/meetings/store.ts";
import { makePrivateDir, OWNER_ONLY_FILE } from "../core/paths.ts";

export interface MeetingDeps {
  config: ConfigStore;
  /**
   * The model that is actually answering, resolved the same way chat resolves
   * it. Not `settings.llm`: with a local model loaded that field is empty, and
   * reading it directly is how note-taking came to report "no LLM endpoint is
   * configured" while a model sat loaded.
   */
  llm: () => Promise<{ endpoint: EndpointSettings; apiKey?: string; label?: string }>;
  /**
   * The transcription model the user chose, resolved to somewhere callable.
   *
   * Handed in rather than worked out here, so meetings and dictation cannot
   * end up transcribing with two different models: there is one choice, in
   * Settings → Audio, and one resolver behind it.
   */
  transcription: () => Promise<{ endpoint: EndpointSettings; apiKey?: string | undefined }>;
  send: (channel: string, payload?: unknown) => void;
}

/**
 * How long a meeting stage may take before it is called a failure.
 *
 * Not the interactive timeout. Chat is someone waiting at a keyboard, and two
 * minutes of silence there means something is wrong. Transcribing forty minutes
 * of audio on a processor, or extracting items from it with a local model, is a
 * batch job nobody is staring at -- and the extraction prompt alone is fifteen
 * hundred words before the transcript is added. Measured here: an eleven-second
 * clip through a 2.6B model on CPU exceeded the 120-second default at the
 * extraction step, which is not a real meeting and not a slow machine.
 *
 * Twenty minutes, and the row has a Cancel button for the cases it does not
 * cover.
 */
const BATCH_TIMEOUT_MS = 20 * 60_000;

/** The same endpoint, given a deadline that suits a batch job. */
function forBatch(endpoint: EndpointSettings): EndpointSettings {
  return { ...endpoint, timeoutMs: Math.max(endpoint.timeoutMs, BATCH_TIMEOUT_MS) };
}

type Phase = "idle" | "recording" | "processing" | "done" | "failed";

/* Optionals written `?: T | undefined`: under exactOptionalPropertyTypes,
   clearing a field by assigning undefined -- which is what "no longer
   recording" and "no longer failed" mean here -- is otherwise a type error. */
interface MeetingState {
  phase: Phase;
  title?: string | undefined;
  elapsedMs?: number | undefined;
  tracks?: string[] | undefined;
  progress?: RunProgress | undefined;
  reportPath?: string | undefined;
  /** The meeting the current stage is working on, so the row can show it. */
  workingOn?: string | undefined;
  error?: string | undefined;
}

export function installMeetingIpc(deps: MeetingDeps): void {
  const { config, send } = deps;
  let recorder: MeetingRecorder | undefined;
  let state: MeetingState = { phase: "idle" };
  let running: AbortController | undefined;

  const publish = (next: Partial<MeetingState>): void => {
    state = { ...state, ...next };
    send("karen:meeting", state);
  };

  const refresh = async (): Promise<void> => {
    send("karen:meetings", await listMeetings(config.current.meetingsRoot));
  };

  const recorderFor = (): MeetingRecorder => {
    recorder ??= new MeetingRecorder({
      root: () => config.current.meetingsRoot,
      onTrackLost: (id, reason) => publish({ error: `${id}: ${reason}` }),
    });
    return recorder;
  };

  /**
   * A meeting directory named by the renderer, checked before it is used.
   *
   * Every handler below takes a `dir` across IPC, and four of them used it
   * unchecked -- reading from it, writing `karen.json` into it, revealing it in
   * the file manager. Only `meeting-delete` compared it against the root.
   *
   * Nothing can currently reach these but our own window (there is no `innerHTML`
   * anywhere in the renderer, so model output cannot become script), and this is
   * not a hole so much as a rule the project already keeps elsewhere and did not
   * keep here: `deleteModel`, `resolveInJail` and `sessions.pathFor` all check a
   * path before touching it, and the last says why in as many words -- "it is
   * still checked rather than trusted".
   *
   * `strict` excludes the root itself. The delete handler compared with
   * `target !== root && !target.startsWith(root + sep)`, which ACCEPTS the root:
   * one call naming the meetings folder would have taken every meeting in it
   * with a recursive remove.
   */
  const meetingDir = (dir: unknown, { strict = true } = {}): string => {
    const root = resolve(config.current.meetingsRoot);
    const target = resolve(String(dir ?? ""));
    const inside = strict
      ? target.startsWith(root + sep)
      : target === root || target.startsWith(root + sep);
    if (!inside) throw new Error("that is not a meeting folder.");
    return target;
  };

  /**
   * Write a meeting's output, jailed to wherever it is being filed.
   *
   * Resolve, then compare against the root — the same rule the document tools
   * use. This is not agent-reachable, but the filename is derived from a title
   * the user typed, so it is still checked.
   */
  const saver =
    (root: string) =>
    async (rel: string, content: string): Promise<{ path: string; bytes: number }> => {
      const base = resolve(root);
      const abs = resolve(base, rel);
      if (abs !== base && !abs.startsWith(base + sep)) {
        throw new Error(`refusing to write outside ${base}: ${rel}`);
      }
      await makePrivateDir(dirname(abs));
      await writeFile(abs, content, { encoding: "utf8", mode: OWNER_ONLY_FILE });
      return { path: abs, bytes: Buffer.byteLength(content, "utf8") };
    };

  const transcriptionEndpoint = async (): Promise<{ endpoint: EndpointSettings; apiKey?: string | undefined }> =>
    deps.transcription();

  const contextFor = async (record: MeetingRecord, dir: string) => {
    const stored = await readState(dir);
    const instructions = (stored.instructions ?? config.current.meetingInstructions ?? "").trim();
    return {
      title: record.title,
      date: record.startedAt,
      ...(instructions ? { instructions } : {}),
    };
  };

  /* --------------------------------------------------------- the stages --- */

  const transcribe = async (dir: string): Promise<void> => {
    const record = await readRecord(dir);
    if (!record) throw new Error("that meeting has no recording to transcribe.");

    const { endpoint, apiKey } = await transcriptionEndpoint();
    publish({ phase: "processing", workingOn: dir, error: undefined });
    running = new AbortController();
    try {
      const { lines, transcript } = await transcribeMeeting({
        record,
        context: await contextFor(record, dir),
        transcription: forBatch(endpoint),
        ...(apiKey ? { transcriptionKey: apiKey } : {}),
        signal: running.signal,
        onProgress: (progress) => publish({ progress }),
      });
      await writeTranscript(dir, { lines, text: transcript });
      // The readable copy lands beside the recording whatever else happens to
      // it, so a transcript is never trapped inside a JSON file.
      await saver(dir)(TRANSCRIPT_MD, renderTranscript(record, transcript));
      await writeState(dir, {
        transcribedAt: new Date().toISOString(),
        transcriptModel: endpoint.model ?? endpoint.baseUrl,
        error: undefined,
      });
    } finally {
      running = undefined;
    }
  };

  const takeNotes = async (dir: string): Promise<string> => {
    const record = await readRecord(dir);
    if (!record) throw new Error("that meeting has no recording.");
    const stored = await readTranscript(dir);
    if (!stored) throw new Error("that meeting has not been transcribed yet.");

    const settings = config.current;
    const { endpoint: llm, apiKey: llmKey, label } = await deps.llm();
    publish({ phase: "processing", workingOn: dir, error: undefined });
    running = new AbortController();
    try {
      /*
       * Where the write-up goes, and under what name.
       *
       * With a vault, it is filed there under a dated name, the way it always
       * was, and a copy stays in the meeting's folder so this page can show the
       * note without reading someone's Obsidian directory.
       *
       * Without a vault, the meeting's own folder *is* the filing — so the
       * report is written straight to `notes.md` rather than to a dated name
       * inside a `Meetings/` subfolder of a folder that is already one meeting.
       * The first attempt did exactly that and produced
       * `meetings/<id>/Meetings/2026-08-26-standup.md` beside an identical
       * `meetings/<id>/notes.md`.
       */
      const vault = settings.vaultRoot.trim();
      const root = filingRoot(settings.vaultRoot, settings.meetingReportDir, dir);
      const canonical = (rel: string): string =>
        vault ? rel : rel.includes("transcript") ? TRANSCRIPT_MD : NOTES_MD;

      const result = await noteMeeting({
        record,
        context: await contextFor(record, dir),
        llm: forBatch(llm),
        ...(llmKey ? { llmKey } : {}),
        lines: stored.lines,
        transcript: stored.text,
        deleteAudio: settings.deleteRawAudioAfterTranscription,
        ...(vault ? { reportDir: settings.meetingReportDir } : { reportDir: "" }),
        save: (rel, content) => saver(root)(canonical(rel), content),
        signal: running.signal,
        onProgress: (progress) => publish({ progress }),
      });
      // Only when it was filed somewhere else: writing it twice into the same
      // directory is how the duplicate above happened.
      if (vault) await saver(dir)(NOTES_MD, result.notes.markdown);
      await writeState(dir, {
        notedAt: new Date().toISOString(),
        notesModel: label,
        filedNotePath: result.reportPath,
        filedTranscriptPath: result.transcriptPath,
        error: undefined,
      });
      return result.reportPath;
    } finally {
      running = undefined;
    }
  };

  const attempt = async (dir: string, work: () => Promise<string | undefined>): Promise<{ ok: boolean; error?: string }> => {
    try {
      const reportPath = await work();
      publish({ phase: "done", ...(reportPath ? { reportPath } : {}), progress: undefined });
      await refresh();
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      await writeState(dir, { error: message }).catch(() => undefined);
      publish({ phase: "failed", error: message, progress: undefined });
      await refresh();
      return { ok: false, error: message };
    }
  };

  /* ------------------------------------------------------------- the IPC -- */

  ipcMain.handle("karen:meeting-state", () => state);
  ipcMain.handle("karen:meeting-list", () => listMeetings(config.current.meetingsRoot));

  ipcMain.handle("karen:meeting-start", async (_e, title: string, tracks: TrackSpec[]) => {
    const id = await recorderFor().start(String(title ?? "Meeting"), tracks);
    publish({
      phase: "recording",
      title: String(title ?? "Meeting"),
      tracks: tracks.map((t) => t.id),
      error: undefined,
      reportPath: undefined,
    });
    return id;
  });

  ipcMain.handle("karen:meeting-audio", async (_e, trackId: string, pcm: ArrayBuffer) => {
    await recorderFor().write(String(trackId), Buffer.from(pcm));
  });

  ipcMain.handle("karen:meeting-levels", () => recorderFor().levels());

  /**
   * Stop recording, and stop there.
   *
   * This used to start transcription automatically. It no longer does: what
   * happens next is a decision -- transcribe now, transcribe later, transcribe
   * with a different model, or never -- and taking it silently is what made a
   * failure look like a lost meeting.
   */
  ipcMain.handle("karen:meeting-stop", async () => {
    const record = await recorderFor().stop();
    publish({ phase: "idle", title: undefined, tracks: undefined });
    await refresh();
    return record;
  });

  /*
   * The jail is applied BEFORE `attempt`, not inside it.
   *
   * `attempt` records a failure by writing the error into the meeting's own
   * `karen.json`, so handing it an unchecked directory would turn a rejected
   * path into a write to that path -- the failure path becoming the thing the
   * check was there to prevent.
   */
  const staged = (
    dir: unknown,
    work: (meeting: string) => Promise<string | undefined>,
  ): Promise<{ ok: boolean; error?: string }> => {
    let meeting: string;
    try {
      meeting = meetingDir(dir);
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message });
    }
    return attempt(meeting, () => work(meeting));
  };

  ipcMain.handle("karen:meeting-transcribe", (_e, dir: string) =>
    staged(dir, async (meeting) => {
      await transcribe(meeting);
      return undefined;
    }),
  );

  ipcMain.handle("karen:meeting-notes", (_e, dir: string) =>
    staged(dir, (meeting) => takeNotes(meeting)),
  );

  ipcMain.handle("karen:meeting-run", (_e, dir: string) =>
    staged(dir, async (meeting) => {
      const already = await readTranscript(meeting);
      if (!already) await transcribe(meeting);
      return await takeNotes(meeting);
    }),
  );

  ipcMain.handle("karen:meeting-cancel", () => {
    running?.abort();
    return { ok: true };
  });

  ipcMain.handle("karen:meeting-instructions", async (_e, dir: string, text: unknown) => {
    try {
      await writeState(meetingDir(dir), { instructions: String(text ?? "") });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    await refresh();
    return { ok: true };
  });

  ipcMain.handle("karen:meeting-read", async (_e, dir: string, which: string) => {
    const { readFile } = await import("node:fs/promises");
    const name = which === "notes" ? NOTES_MD : TRANSCRIPT_MD;
    try {
      return await readFile(join(meetingDir(dir), name), "utf8");
    } catch {
      return undefined;
    }
  });

  ipcMain.handle("karen:meeting-reveal", async (_e, path: string) => {
    /*
     * Two roots are legitimate here, not one: a meeting's own folder, and the
     * vault, because that is where notes are filed when a vault is configured.
     * Anywhere else is not something this button can have produced.
     */
    const target = resolve(String(path ?? ""));
    const roots = [config.current.meetingsRoot, config.current.vaultRoot]
      .filter((r) => r.trim())
      .map((r) => resolve(r));
    if (!roots.some((root) => target === root || target.startsWith(root + sep))) {
      return { ok: false, error: "that is not a meeting file." };
    }
    // Show it in the file manager rather than opening it: the user may want the
    // folder, and a .md opened in whatever claims the extension is rarely it.
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle("karen:meeting-delete", async (_e, dir: string) => {
    let target: string;
    try {
      target = meetingDir(dir);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    await deleteMeeting(target);
    await refresh();
    return { ok: true };
  });

  ipcMain.handle("karen:meeting-discard", async () => {
    await recorderFor().discard();
    // Replaced wholesale rather than patched: a discard must clear the title,
    // the progress and any error, and a partial patch would leave one behind.
    state = { phase: "idle" };
    send("karen:meeting", state);
    await refresh();
  });
}
