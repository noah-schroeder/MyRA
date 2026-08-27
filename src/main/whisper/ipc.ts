/**
 * The transcription runtime, exposed to the window.
 *
 * Nothing here is reachable by the model. Installing a binary and downloading a
 * model are things a person does from a settings screen, not tool calls, and
 * the agent has no verb that touches any of it.
 */

import { ipcMain } from "electron";
import type { WhisperManager } from "./manager.ts";

export interface WhisperDeps {
  whisper: WhisperManager;
  send: (channel: string, payload?: unknown) => void;
}

export function installWhisperIpc({ whisper, send }: WhisperDeps): void {
  whisper.onChange((snapshot) => send("karen:whisper", snapshot));

  /** One download at a time, cancellable, like the model runtime's. */
  let inFlight: AbortController | undefined;
  const progress = (p: unknown): void => send("karen:whisper-download", p);

  ipcMain.handle("karen:whisper-state", () => whisper.snapshot());

  ipcMain.handle("karen:whisper-config", async (_e, patch: unknown) => {
    const next = patch as { useForTranscription?: boolean };
    return await whisper.update(
      next?.useForTranscription === undefined ? {} : { useForTranscription: Boolean(next.useForTranscription) },
    );
  });

  ipcMain.handle("karen:whisper-install", async () => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const result = await whisper.installBuild(inFlight.signal, progress);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      inFlight = undefined;
      progress(undefined);
    }
  });

  ipcMain.handle("karen:whisper-model-install", async (_e, file: string) => {
    inFlight?.abort();
    inFlight = new AbortController();
    try {
      const path = await whisper.installModel(String(file), inFlight.signal, progress);
      return { ok: true, path };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      inFlight = undefined;
      progress(undefined);
    }
  });

  ipcMain.handle("karen:whisper-model-use", async (_e, file: string) => {
    try {
      await whisper.useModel(String(file));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:whisper-model-remove", async (_e, file: string) => {
    try {
      await whisper.removeModel(String(file));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:whisper-start", async () => {
    try {
      return { ok: true, status: await whisper.start() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("karen:whisper-stop", async () => {
    await whisper.stop();
    return { ok: true };
  });

  ipcMain.handle("karen:whisper-cancel", () => {
    inFlight?.abort();
    return { ok: true };
  });
}
