/**
 * The two audio models, resolved and served to whoever needs them.
 *
 * Dictation, meetings and the hands-free mode all ask the same question -- "the
 * model the user chose for this job, and where do I send it" -- and they used
 * to answer it three different ways: dictation read `settings.transcription`
 * and posted to whatever was there, meetings preferred Lemonade and fell back
 * to that endpoint, and nothing could speak at all. One resolver now, so a
 * model chosen once is the model used everywhere.
 *
 * The resolution itself is the same shape as `resolveLlm` in index.ts, and
 * deliberately so: a bare id is the daemon on this machine, `provider::model`
 * goes to one of the user's providers, and a reference naming a provider that
 * has since been deleted is an error rather than a silent fallback to something
 * local. That last rule is the one worth keeping honest -- falling back would
 * send audio somewhere the user did not choose, and audio is a recording of a
 * room.
 */

import { ipcMain } from "electron";

import type { AudioOption, AudioRole } from "../core/audio/models.ts";
import { speak, type Spoken } from "../core/audio/speech.ts";
import { speakable } from "../core/audio/speakable.ts";
import {
  explainModelFailure, modelOptions, resolveMediaModel, type MediaDeps, type ResolvedModel,
} from "./models.ts";

/** Audio asks the same things of the app that every other model role does. */
export type AudioDeps = MediaDeps;

export type ResolvedAudio = ResolvedModel;

/**
 * Turn a stored choice into something that can be called.
 *
 * The rules live in models.ts, shared with the image role. What is audio's own
 * is only which settings field each role reads.
 */
export async function resolveAudio(
  deps: Pick<AudioDeps, "config" | "vault" | "runtime">,
  role: AudioRole,
  { start = false }: { start?: boolean } = {},
): Promise<ResolvedAudio> {
  const audio = deps.config.current.audio;
  const ref = role === "transcription" ? audio.transcriptionModel : audio.voiceModel;
  return resolveMediaModel(deps, role, ref, { start });
}

/**
 * Speak, with the voice and pace the user chose.
 *
 * The text is cleaned here rather than at the call sites: every caller has a
 * Markdown answer in hand, and a rule about what is worth reading aloud should
 * not be re-decided per screen.
 */
export async function speakText(
  deps: Pick<AudioDeps, "config" | "vault" | "runtime">,
  text: string,
  signal?: AbortSignal,
): Promise<Spoken> {
  const resolved = await resolveAudio(deps, "voice", { start: true });
  const { voice, speed } = deps.config.current.audio;
  return speak({
    endpoint: resolved.endpoint,
    text: speakable(text),
    ...(voice ? { voice } : {}),
    ...(speed && speed !== 1 ? { speed } : {}),
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** Everything that could be chosen for a speech role. See models.ts. */
export async function audioOptions(
  deps: Pick<AudioDeps, "config" | "runtime">,
  role: AudioRole,
): Promise<AudioOption[]> {
  return modelOptions(deps, role);
}

export function installAudioIpc(
  deps: AudioDeps & {
    /**
     * Stop whatever is currently generating, before taking its model away.
     *
     * Injected rather than imported: this module is the audio IPC, and the
     * conversation's abort controller belongs to the process that owns the
     * turn. See modelDelete.ts for the same shape.
     */
    stopWork?: () => void;
  },
): void {
  const { runtime, send } = deps;

  ipcMain.handle("karen:audio-models", async (_e, role: AudioRole) => {
    try {
      return { ok: true, options: await audioOptions(deps, role) };
    } catch (err) {
      return { ok: false, error: (err as Error).message, options: [] };
    }
  });

  /**
   * Download and load a local audio model.
   *
   * Progress is pushed on a channel rather than returned, for the same reason
   * the chat model's download is: this is where a 3.1 GB Whisper arrives, and a
   * promise that settles in twenty minutes is a button that says nothing.
   */
  ipcMain.handle("karen:audio-load", async (_e, model: string) => {
    try {
      await runtime.loadAuxModel(model, (p) => send("karen:audio-progress", { model, ...p }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Say something, and hand back the audio for the window to play.
   *
   * The bytes cross the bridge rather than a file path: the renderer is
   * sandboxed and has no filesystem, and writing every utterance to disk would
   * leave a trail of what was said in a feature whose whole point is that it is
   * spoken and gone.
   */
  /**
   * Give a speech model back its memory.
   *
   * On the machines this is for, a Whisper and a chat model resident together
   * is most of an 8 GB card — and the transcription model is the one you are
   * finished with the moment the meeting is written up. Naming the model is
   * what stops this taking the conversation's model down with it.
   */
  ipcMain.handle("karen:model-unload", async (_e, model: string) => {
    try {
      /* First, and unconditionally. A generation in flight holds the model
         open, and the request that follows it reloads what was just unloaded
         -- so mid-run the button did nothing at all except briefly. Asking for
         the memory back is asking for the work to stop. */
      deps.stopWork?.();
      await runtime.unloadModel(model);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:audio-speak", async (_e, text: string) => {
    try {
      const spoken = await speakText(deps, text);
      /* A plain Uint8Array, because a Node Buffer crosses the bridge as an
         object with a `data` array -- structurally cloneable, and useless to
         `new Blob()` on the far side. */
      return { ok: true, audio: new Uint8Array(spoken.audio), mime: spoken.mime };
    } catch (err) {
      return {
        ok: false,
        error: await explainModelFailure(deps, "voice", deps.config.current.audio.voiceModel, err),
      };
    }
  });

  /** A sentence in the chosen voice, for the Preview button beside it. */
  ipcMain.handle("karen:audio-preview", async (_e, voice?: string) => {
    try {
      const resolved = await resolveAudio(deps, "voice", { start: true });
      const spoken = await speak({
        endpoint: resolved.endpoint,
        text: "This is how Karen will read your answers aloud.",
        ...(voice ? { voice } : {}),
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      });
      return { ok: true, audio: new Uint8Array(spoken.audio), mime: spoken.mime };
    } catch (err) {
      return {
        ok: false,
        error: await explainModelFailure(deps, "voice", deps.config.current.audio.voiceModel, err),
      };
    }
  });
}
