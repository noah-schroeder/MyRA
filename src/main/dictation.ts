/**
 * Dictation: hold, speak, and the text lands in the composer.
 *
 * v1 bound this to a GNOME custom keybinding via gsettings, because Electron's
 * globalShortcut does not work on GNOME Wayland. That was Linux-only and is
 * gone; the renderer captures and this side transcribes.
 */

import { ipcMain } from "electron";
import type { ConfigStore } from "../core/config.ts";
import type { SecretVault } from "./secrets.ts";
import type { RuntimeManager } from "./runtime/manager.ts";
import { Recorder } from "../core/meetings/capture.ts";
import { transcribe } from "../core/stt.ts";
import { resolveAudio } from "./audio.ts";
import { readFile } from "node:fs/promises";

export interface DictationDeps {
  config: ConfigStore;
  vault: SecretVault;
  runtime: RuntimeManager;
  send: (channel: string, payload?: unknown) => void;
}

/** A recording longer than this is almost certainly a hotkey left latched. */
const MAX_SECONDS = 10 * 60;

export function installDictationIpc(deps: DictationDeps): void {
  const { config, send } = deps;
  let recorder: Recorder | undefined;

  ipcMain.handle("karen:dictation-start", async () => {
    await recorder?.cancel();
    recorder = new Recorder();
    await recorder.start({ maxSeconds: MAX_SECONDS });
  });

  ipcMain.handle("karen:dictation-audio", async (_e, pcm: ArrayBuffer) => {
    await recorder?.write(Buffer.from(pcm));
  });

  ipcMain.handle("karen:dictation-stop", async () => {
    const active = recorder;
    recorder = undefined;
    if (!active) return;

    const recording = await active.stop();
    try {
      const settings = config.current;
      /*
       * Started if it is not running, unlike every other caller.
       *
       * Somebody has just held the microphone down and spoken; the recording
       * exists and is about to be thrown away. Refusing it because the daemon
       * was idle would lose what they said in order to avoid a few seconds of
       * startup, which is the wrong side of that trade.
       */
      const resolved = await resolveAudio(deps, "transcription", { start: true });
      const text = await transcribe({
        endpoint: resolved.endpoint,
        audio: await readFile(recording.path),
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(settings.dictationLanguage ? { language: settings.dictationLanguage } : {}),
      });
      if (text.trim()) send("karen:dictation-text", text.trim());
    } finally {
      // The audio was a means to the text and is never kept: dictation is not
      // a recording feature, and a stray WAV per utterance adds up.
      await active.cancel();
    }
  });

  ipcMain.handle("karen:dictation-cancel", async () => {
    const active = recorder;
    recorder = undefined;
    await active?.cancel();
  });
}
