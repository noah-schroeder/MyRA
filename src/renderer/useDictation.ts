/**
 * Dictation, from the button to the text in the composer.
 *
 * v1 drove this from a GNOME keybinding through a unix socket, because
 * Electron's globalShortcut does not work on GNOME Wayland. That was Linux
 * only and went with the VM; this is a button, which works everywhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DictationCapture } from "./capture.ts";
import { levelFromAmplitude } from "../core/audio/endpointing.ts";
import type { DictationState } from "./types.ts";

/*
 * The silence thresholds, restated here rather than imported from core's meter.
 *
 * core/meetings/meter.ts is Node-side -- it reads a Buffer, which a sandboxed
 * window does not have -- so the renderer cannot import it. These are the same
 * numbers, calibrated the same way: an open mic in a quiet room sits well above
 * the amplitude floor and a muted one sits far below, and 2.5s is long enough
 * that a pause between sentences does not trip the warning.
 *
 * This one stays fixed on purpose. It answers "is this microphone dead", where
 * hands-free asks "has this person stopped talking" -- a question about the
 * room, which core/audio/endpointing.ts answers by learning it.
 */
const SILENCE_AMPLITUDE = 0.004;
const SILENCE_MS = 2_500;

const IDLE: DictationState = { phase: "idle", elapsedMs: 0, level: 0 };

export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>(IDLE);
  const capture = useRef<DictationCapture | undefined>(undefined);
  const startedAt = useRef(0);
  const lastSound = useRef(0);

  useEffect(() => window.karen.onDictationText(onText), [onText]);

  // The clock and the silence check share one timer: two would drift apart and
  // the HUD would tick while claiming nothing had been heard for a while.
  useEffect(() => {
    if (state.phase !== "recording") return;
    const timer = setInterval(() => {
      setState((s) => ({
        ...s,
        elapsedMs: Date.now() - startedAt.current,
        silent: Date.now() - lastSound.current > SILENCE_MS,
      }));
    }, 200);
    return () => clearInterval(timer);
  }, [state.phase]);

  const start = useCallback(async () => {
    if (capture.current?.active) return;
    const session = new DictationCapture();
    startedAt.current = Date.now();
    lastSound.current = Date.now();
    try {
      const settings = await window.karen.getSettings();
      await window.karen.dictationStart();
      await session.start({
        ...(settings.dictationSource ? { micDeviceId: settings.dictationSource } : {}),
        onChunk: (pcm) => void window.karen.dictationAudio(pcm),
        onLevel: ({ peak, rms }) => {
          if (rms > SILENCE_AMPLITUDE) lastSound.current = Date.now();
          setState((s) => ({ ...s, level: levelFromAmplitude(rms), clipping: peak >= 0.99 }));
        },
      });
      capture.current = session;
      setState({ phase: "recording", elapsedMs: 0, level: 0 });
    } catch (err) {
      await session.stop();
      await window.karen.dictationCancel();
      setState({ ...IDLE, error: (err as Error).message });
    }
  }, []);

  const stop = useCallback(async () => {
    await capture.current?.stop();
    capture.current = undefined;
    // Transcription takes a moment, and a HUD that vanishes on stop makes it
    // look as though the recording was thrown away.
    setState((s) => ({ ...s, phase: "transcribing" }));
    try {
      /* The handler answers rather than rejecting, so that a transcription
         failure reads as Karen's own sentence instead of Electron's "Error
         invoking remote method" with a JSON body on the end. The catch is
         still here for the bridge itself going wrong. */
      const result = await window.karen.dictationStop();
      setState(result?.ok === false ? { ...IDLE, error: result.error ?? "" } : IDLE);
    } catch (err) {
      setState({ ...IDLE, error: (err as Error).message });
    }
  }, []);

  const cancel = useCallback(async () => {
    await capture.current?.stop();
    capture.current = undefined;
    await window.karen.dictationCancel();
    setState(IDLE);
  }, []);

  return { state, start, stop, cancel, dismiss: () => setState(IDLE) };
}
