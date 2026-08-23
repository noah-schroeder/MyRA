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
import { Recorder } from "../core/meetings/capture.ts";
import { transcribe } from "../core/stt.ts";
import { readFile } from "node:fs/promises";

export interface DictationDeps {
  config: ConfigStore;
  vault: SecretVault;
  send: (channel: string, payload?: unknown) => void;
}

/** A recording longer than this is almost certainly a hotkey left latched. */
const MAX_SECONDS = 10 * 60;

export function installDictationIpc(deps: DictationDeps): void {
  const { config, vault, send } = deps;
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
      const key = await vault.get("transcriptionKey");
      const text = await transcribe({
        endpoint: settings.transcription,
        audio: await readFile(recording.path),
        ...(key ? { apiKey: key } : {}),
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
