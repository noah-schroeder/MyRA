/**
 * Playing what Karen says, and knowing when it has stopped.
 *
 * The audio arrives from the main process as bytes rather than a URL, because
 * the window is sandboxed and has no filesystem and because an utterance
 * written to disk would leave a record of a thing whose whole nature is that it
 * is spoken and gone. A blob URL is made here, played, and revoked -- revoked
 * on every path out, including the interrupted one, or a long conversation
 * accumulates a megabyte of MP3 per turn in the page's memory.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechPhase = "idle" | "thinking" | "speaking";

export interface SpeechState {
  phase: SpeechPhase;
  error?: string | undefined;
}

export function useSpeech() {
  const [state, setState] = useState<SpeechState>({ phase: "idle" });
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const url = useRef<string | undefined>(undefined);
  /* Bumped by every stop. A synthesis request that was in flight when the user
     interrupted must not start playing when it lands, and the promise cannot be
     cancelled from here -- so the result is checked against this instead. */
  const generation = useRef(0);

  const release = useCallback((): void => {
    if (audio.current) {
      audio.current.pause();
      audio.current.src = "";
      audio.current = undefined;
    }
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = undefined;
    }
  }, []);

  const stop = useCallback((): void => {
    generation.current++;
    release();
    setState({ phase: "idle" });
  }, [release]);

  /** Nothing outlives the screen it belongs to. */
  useEffect(() => () => release(), [release]);

  /**
   * Say this, and resolve when it has finished being said.
   *
   * Resolves rather than rejects when it was interrupted or failed: every
   * caller is a loop deciding what to do next, and "it did not get spoken" is a
   * normal outcome there rather than an exception. The error, when there is
   * one, is in the state for the screen to show.
   */
  const speak = useCallback(async (text: string): Promise<void> => {
    const mine = ++generation.current;
    release();
    setState({ phase: "thinking" });

    const result = await window.karen.speak(text);
    if (mine !== generation.current) return; // Interrupted while synthesising.

    if (!result.ok || !result.audio) {
      setState({ phase: "idle", error: result.error ?? "The voice model returned no audio." });
      return;
    }

    const type = result.mime ?? "audio/mpeg";
    const blob = new Blob([new Uint8Array(result.audio)], { type });
    const src = URL.createObjectURL(blob);
    url.current = src;
    const element = new Audio(src);
    audio.current = element;
    setState({ phase: "speaking" });

    await new Promise<void>((resolve) => {
      const done = (error?: string): void => {
        if (mine === generation.current) {
          release();
          setState(error ? { phase: "idle", error } : { phase: "idle" });
        }
        resolve();
      };
      element.onended = () => done();
      /*
       * A decode failure names the format, because that is the whole question.
       *
       * "Failed to load because no supported source was found" was reported
       * after a synthesis that had worked: the audio was there and this build
       * would not decode it. Which format it was is the difference between a
       * missing codec and a mislabelled container, and neither is guessable
       * from the sentence Chromium supplies.
       */
      const cannotPlay = `That audio could not be played: the voice model returned ${type}.`;
      element.onerror = () => done(cannotPlay);
      element.play().catch(() => done(cannotPlay));
    });
  }, [release]);

  return { state, speak, stop, speaking: state.phase !== "idle" };
}
