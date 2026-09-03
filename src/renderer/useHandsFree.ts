/**
 * The hands-free loop: listen, send, speak, listen again.
 *
 * Written as one explicit sequence rather than as several effects that happen
 * to fire in the right order, because the failure this shape prevents is
 * specific and unpleasant: two of these steps open the microphone, and a race
 * between them leaves a live microphone with nothing listening to it. The
 * device is only ever held by one of the two paths below, and every transition
 * goes through `to()`.
 *
 *   listening   the user is talking; dictation is recording
 *   thinking    the turn is in flight
 *   speaking    the answer is being read out, and the microphone is open for
 *               the sole purpose of noticing that the user has started talking
 *
 * Two decisions worth stating, since neither is recoverable by reading the code:
 *
 *   - **Silence ends a turn, but only after speech.** A pause of 1.5 s sends
 *     what was said. The same pause before anything has been said is somebody
 *     thinking, and treating it as the end of a turn would transcribe an empty
 *     recording every 1.5 s for as long as they were quiet.
 *   - **Barge-in needs echo cancellation.** The microphone is open while the
 *     speakers are playing Karen's own voice, so without cancellation the loop
 *     hears itself and cuts its own answer off after one syllable. That is the
 *     only reason `echoCancellation` is a parameter on the capture at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DictationCapture } from "./capture.ts";
import type { DictationState } from "./types.ts";

export type HandsFreePhase = "off" | "listening" | "thinking" | "speaking";

/**
 * How long a pause means "your turn".
 *
 * Shorter than dictation's own 2.5 s silence warning, and deliberately: that
 * number exists to tell somebody their microphone might be muted, while this
 * one is a conversational beat. Two and a half seconds of dead air before a
 * reply makes the whole exchange feel broken.
 */
const END_OF_TURN_MS = 1_500;

/** The raw amplitude that counts as somebody talking. Matches useDictation. */
const SPEECH_AMPLITUDE = 0.004;

/**
 * The same floor, on the scale the dictation meter reports.
 *
 * `useDictation` hands out a dB-mapped 0-1 reading rather than the amplitude:
 * 20·log10(0.004) is −48 dBFS, which that mapping puts at (−48+60)/60 = 0.2.
 * Comparing the raw threshold against the scaled number -- which is what this
 * did first -- treats an ordinary speaking voice as silence.
 */
const SPEECH_LEVEL = 0.2;

/**
 * How long they must keep talking before the answer is cut off.
 *
 * A single loud sample is a door, a cough, or a click. Interrupting a spoken
 * answer is destructive -- the rest of it is never read -- so it takes a run of
 * consecutive loud frames rather than one.
 */
const BARGE_IN_MS = 350;

export interface HandsFreeControls {
  phase: HandsFreePhase;
  error?: string | undefined;
}

export function useHandsFree({
  enabled,
  busy,
  answer,
  dictation,
  speech,
  micDeviceId,
}: {
  enabled: boolean;
  /** Whether a turn is in flight. */
  busy: boolean;
  /** The finished answer to read out, and an id that changes per answer. */
  answer: { id: string; text: string } | undefined;
  dictation: {
    state: DictationState;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    cancel: () => Promise<void>;
  };
  speech: {
    speak: (text: string) => Promise<void>;
    stop: () => void;
  };
  micDeviceId?: string;
}): HandsFreeControls {
  const [phase, setPhase] = useState<HandsFreePhase>("off");
  const [error, setError] = useState<string | undefined>();

  /* Refs rather than state for everything the sequence reads, because the
     sequence runs inside timers and callbacks that would otherwise close over
     whatever was true when they were created. */
  /*
   * The two collaborators, held by reference.
   *
   * `useDictation` and `useSpeech` return a NEW object on every render, so an
   * effect that lists either in its dependencies re-runs on every render --
   * which broke the loop in two separate ways before this: the speaking effect
   * cancelled its own continuation through its cleanup, so the loop stopped
   * dead after the first answer, and the end-of-turn interval was torn down and
   * rebuilt faster than its own 200 ms tick, so it never fired at all. Reading
   * the latest value through a ref means the effects below depend only on
   * things that actually change.
   */
  const speechRef = useRef(speech);
  speechRef.current = speech;
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  const monitor = useRef<DictationCapture | undefined>(undefined);
  /* Which pass through the loop is current. A sequence checks this rather than
     a `cancelled` flag captured in an effect closure, because that flag was
     being set by an unrelated re-render. */
  const sequence = useRef(0);

  const heardSpeech = useRef(false);
  const lastSound = useRef(0);
  const spokenId = useRef<string | undefined>(undefined);
  const phaseRef = useRef<HandsFreePhase>("off");
  const running = useRef(false);

  const to = useCallback((next: HandsFreePhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopMonitor = useCallback(async (): Promise<void> => {
    const open = monitor.current;
    monitor.current = undefined;
    await open?.stop();
  }, []);

  /** Open the microphone and start a turn. */
  const listen = useCallback(async (): Promise<void> => {
    await stopMonitor();
    heardSpeech.current = false;
    lastSound.current = Date.now();
    try {
      await dictationRef.current.start();
      to("listening");
    } catch (err) {
      setError((err as Error).message);
      to("off");
      running.current = false;
    }
  }, [stopMonitor, to]);

  /**
   * Listen for the user talking over the answer, and cut it off when they do.
   *
   * A capture whose chunks are discarded: this is a level meter, not a
   * recording, and nothing it hears is written down or sent anywhere. Karen's
   * own voice is subtracted by the browser (see echoCancellation), which is
   * what makes the threshold below mean "the user" rather than "the speakers".
   */
  const watchForBargeIn = useCallback(async (): Promise<void> => {
    if (monitor.current) return;
    const session = new DictationCapture();
    let loudSince = 0;
    try {
      await session.start({
        ...(micDeviceId ? { micDeviceId } : {}),
        echoCancellation: true,
        onChunk: () => {},
        onLevel: ({ rms }) => {
          if (rms <= SPEECH_AMPLITUDE) {
            loudSince = 0;
            return;
          }
          if (!loudSince) loudSince = Date.now();
          if (Date.now() - loudSince < BARGE_IN_MS) return;
          if (phaseRef.current !== "speaking") return;
          /* Stop the audio first, then take the microphone: the other order
             leaves the speakers playing into a live recording. */
          speechRef.current.stop();
        },
      });
      monitor.current = session;
    } catch {
      /* No microphone for the monitor is not fatal -- the answer still gets
         read out, and the loop still comes back round when it finishes. The
         only thing lost is the ability to interrupt by talking. */
      await session.stop();
    }
  }, [micDeviceId]);

  /* ------------------------------------------------------------- the loop -- */

  // Switched on and off. Everything the mode holds is released on the way out,
  // including a microphone that is open for barge-in.
  useEffect(() => {
    if (enabled && !running.current) {
      running.current = true;
      setError(undefined);
      void listen();
    }
    if (!enabled && running.current) {
      running.current = false;
      sequence.current++;
      spokenId.current = undefined;
      speechRef.current.stop();
      void stopMonitor();
      void dictationRef.current.cancel();
      to("off");
    }
  }, [enabled, listen, stopMonitor, to]);

  useEffect(() => () => {
    /* Unmounting is switching off, as far as the microphone is concerned. */
    void stopMonitor();
  }, [stopMonitor]);

  /* The meter, watched out of the render path so the interval below can keep
     running while it changes. What is kept is not the level itself but the two
     facts the end-of-turn test needs: that speech happened at all, and when it
     was last heard. */
  useEffect(() => {
    if (dictation.state.level > SPEECH_LEVEL) {
      heardSpeech.current = true;
      lastSound.current = Date.now();
    }
  }, [dictation.state.level]);

  // End of turn: a pause, but only once something has actually been said.
  useEffect(() => {
    if (!enabled || phase !== "listening") return undefined;
    const timer = setInterval(() => {
      if (!heardSpeech.current) return;
      if (Date.now() - lastSound.current < END_OF_TURN_MS) return;
      clearInterval(timer);
      to("thinking");
      void dictationRef.current.stop();
    }, 200);
    return () => clearInterval(timer);
  }, [enabled, phase, to]);

  /*
   * Speak the answer, then go round again.
   *
   * Keyed on the answer's id rather than its text: an answer identical to the
   * last one is still a new answer, and comparing the words would silently skip
   * reading it out.
   */
  useEffect(() => {
    if (!enabled || busy || !answer?.text.trim()) return;
    if (spokenId.current === answer.id) return;
    if (phaseRef.current === "speaking") return;
    spokenId.current = answer.id;

    const mine = ++sequence.current;
    void (async () => {
      to("speaking");
      /* Started before the audio, so an interruption in the first second is
         caught -- that is when someone realises the answer is not what they
         asked for. */
      await watchForBargeIn();
      await speechRef.current.speak(answer.text);
      await stopMonitor();
      /* Not a cleanup flag: this must survive an unrelated re-render and must
         NOT survive the mode being switched off, and only the counter can tell
         those two apart. */
      if (mine !== sequence.current || !running.current) return;
      await listen();
    })();
  }, [enabled, busy, answer, listen, stopMonitor, watchForBargeIn, to]);

  /**
   * What the transcript does when it lands.
   *
   * Empty means the recording held no words -- a cough, or a door. The loop
   * goes back to listening rather than sending an empty message, which is what
   * makes a false end-of-turn harmless rather than a message the user has to
   * apologise for.
   */
  useEffect(() => {
    if (!enabled || busy) return undefined;
    if (phase !== "thinking") return undefined;
    if (dictation.state.phase !== "idle") return undefined;
    /* Dictation has settled and no turn started, so the recording held no
       words. The delay is for the gap between the transcript arriving and the
       message being sent, which is a render apart. */
    const timer = setTimeout(() => {
      if (phaseRef.current === "thinking" && running.current && !busy) void listen();
    }, 600);
    return () => clearTimeout(timer);
  }, [enabled, busy, phase, dictation.state.phase, listen]);

  /* Errors from either half stop the loop rather than retrying into them: a
     misconfigured voice model would otherwise spin, opening the microphone and
     failing, several times a second. */
  useEffect(() => {
    if (!enabled) return;
    const message = dictation.state.error;
    if (!message) return;
    setError(message);
    running.current = false;
    void stopMonitor();
    to("off");
  }, [enabled, dictation.state.error, stopMonitor, to]);

  return { phase, ...(error ? { error } : {}) };
}
