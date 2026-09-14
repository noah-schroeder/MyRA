/**
 * Capturing audio, in the only place that can.
 *
 * Device access is a Web API, so it exists here and nowhere else. v1 spawned
 * two `pw-record` processes in the main process instead, which worked and tied
 * the whole feature to Linux with PipeWire running.
 *
 * Two tracks, because that is what gives speaker separation without a
 * diarization model: the microphone is the user, and the system's own output is
 * everyone else. A microphone alone records the person wearing the headphones
 * and nobody else.
 */

import type { AudioSource } from "./types.ts";

export const RATE = 16_000;

export class CaptureError extends Error {
  override readonly name = "CaptureError";
}

/**
 * Enumerate capture devices and report them to the main process.
 *
 * Labels are empty until permission has been granted at least once, so this
 * asks for the microphone first and immediately stops it. Without that the
 * device picker in Settings shows a list of blank names.
 */
export async function enumerate(): Promise<AudioSource[]> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of probe.getTracks()) track.stop();
  } catch {
    // Denied or unavailable: still enumerate, the ids remain useful.
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const sources: AudioSource[] = devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({
      id: d.deviceId,
      name: d.label || `Microphone ${i + 1}`,
      description: d.label || "Microphone",
      isDefault: d.deviceId === "default",
      kind: "microphone" as const,
    }));

  await window.myra.reportDevices(sources);
  return sources;
}

/**
 * Peak and RMS of one chunk, 0..1.
 *
 * Duplicated from core's levelOf rather than shared, because that one reads a
 * Buffer and the renderer has none -- Node's Buffer is not in a sandboxed
 * window. The arithmetic is four lines; a shim to unify them would be longer
 * than both.
 */
export function levelOfPcm(pcm: Int16Array): { peak: number; rms: number } {
  if (pcm.length === 0) return { peak: 0, rms: 0 };
  let peak = 0;
  let sum = 0;
  for (const sample of pcm) {
    const value = sample / 32_768;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  return { peak: Math.min(1, peak), rms: Math.min(1, Math.sqrt(sum / pcm.length)) };
}

interface Track {
  context: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode | ScriptProcessorNode;
}

/**
 * One meeting's worth of capture.
 *
 * `start` throws if the microphone is refused, because a meeting recorded from
 * nothing is worse than one that failed loudly. System audio is different: it
 * is unavailable on some platforms, so a failure there degrades to mic-only
 * with a warning rather than stopping the meeting.
 */
export class MeetingCapture {
  #tracks = new Map<string, Track>();

  get active(): string[] {
    return [...this.#tracks.keys()];
  }

  async start(opts: {
    micDeviceId?: string;
    systemAudio: boolean;
    /**
     * Let the browser subtract what the speakers are playing.
     *
     * Off everywhere except the hands-free mode, and that one exception is
     * the whole reason it is a parameter. MyRA speaking her own answer through
     * the speakers, into the microphone she is listening on, is heard as the
     * user interrupting -- so the loop would cut its own reply off after the
     * first syllable, every time. Meetings must keep it off for the opposite
     * reason: the far side of a call IS the thing cancellation removes.
     */
    echoCancellation?: boolean;
    onChunk: (trackId: string, pcm: ArrayBuffer) => void;
    onWarning?: (message: string) => void;
  }): Promise<{ id: string; label: string; source?: string }[]> {
    const specs: { id: string; label: string; source?: string }[] = [];

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
          // Off unless a caller asks, deliberately. These are tuned for
          // intelligibility on a call, and echo cancellation in particular will
          // remove the far side of the conversation -- which is the half the
          // second track exists to keep. The hands-free mode is the one caller
          // that wants it; see the option above.
          echoCancellation: opts.echoCancellation === true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      throw new CaptureError(
        `The microphone is not available: ${(err as Error).message}. ` +
          `Check the system's privacy settings for microphone access.`,
      );
    }
    await this.#attach("me", mic, opts.onChunk);
    specs.push({ id: "me", label: "Me", ...(opts.micDeviceId ? { source: opts.micDeviceId } : {}) });

    if (opts.systemAudio) {
      try {
        /*
         * Audio with no video, and both halves of that are load-bearing.
         *
         * No video, because the main process answers this request with the
         * system's own output and has no screen to hand back -- it refuses a
         * request that asks for one, and MyRA has no business capturing a
         * screen to record a conversation. See the handler in main/index.ts.
         *
         * And every piece of processing off, for a reason worse than the one
         * the microphone has. Chromium's automatic gain control does not just
         * pump the recording: it turns the capture device's own volume down,
         * through the system's mixer, and leaves it there. Measured on
         * PipeWire, a single recording took the output monitor from 1.0 to
         * 0.000482 -- so the meeting sounded acceptable and every meeting
         * after it recorded silence, with nothing on screen to say why. Noise
         * suppression and echo cancellation are off for the reason they are
         * off on the microphone: the far side of the call is the signal here,
         * not the noise.
         */
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: false,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (display.getAudioTracks().length === 0) {
          throw new Error("the request was granted without audio");
        }
        await this.#attach("them", display, opts.onChunk);
        specs.push({ id: "them", label: "Everyone else" });
      } catch (err) {
        // A meeting missed cannot be recovered; a meeting recorded from one
        // side usually can be worked with. So warn and carry on.
        /* The advice differs by platform because the cause does. On macOS the
           capture is gated by a permission the user can grant. On Linux it is
           not gated at all -- it goes through PulseAudio, which is what
           PipeWire serves too -- so what is left to go wrong is that there is
           no PulseAudio for it to go through. The advice this used to give
           there, to pick a monitor source as the microphone in Settings, could
           not be followed by anyone: Chromium leaves monitor sources out of
           enumerateDevices entirely, so no such device has ever appeared in
           that list. */
        const advice =
          navigator.userAgent.includes("Mac OS X")
            ? "On macOS, check System Settings → Privacy & Security → Screen Recording."
            : navigator.userAgent.includes("Windows")
              ? "Windows records whatever is playing; check that something is."
              : "On Linux this needs PipeWire or PulseAudio, which a desktop normally " +
                "already runs.";
        opts.onWarning?.(
          `Recording your side only — system audio was not captured (${(err as Error).message}). ` +
            advice,
        );
      }
    }

    return specs;
  }

  async #attach(
    id: string,
    stream: MediaStream,
    onChunk: (trackId: string, pcm: ArrayBuffer) => void,
  ): Promise<void> {
    const context = new AudioContext({ sampleRate: RATE });
    const source = context.createMediaStreamSource(stream);

    let node: AudioWorkletNode | ScriptProcessorNode;
    try {
      // Loaded as a real file from public/, not bundled. `new URL(..., import.meta.url)`
      // makes Vite inline it as a data: URL, which the app's own CSP
      // (script-src 'self') then blocks -- silently dropping to the fallback
      // below, which is the worse implementation. Resolved against the
      // document so it works under both the dev server and file://.
      await context.audioWorklet.addModule(new URL("pcm-worklet.js", document.baseURI).href);
      /* Mono, stated rather than assumed. The worklet reads the first channel
         only, and the system-audio track arrives in stereo -- so left on its
         own would be the recording, and anything panned to the right side of a
         call would be missing from it. Explicit here makes the graph downmix
         first, which is what the ScriptProcessor below already gets from being
         built with one input channel. */
      const worklet = new AudioWorkletNode(context, "pcm-worklet", {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(id, event.data);
      node = worklet;
    } catch {
      // Older engines, or a worklet that failed to load. Works, but runs on the
      // main thread and can drop audio under load.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(channel.length);
        for (let i = 0; i < channel.length; i++) {
          const s = Math.max(-1, Math.min(1, channel[i]!));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        onChunk(id, pcm.buffer);
      };
      processor.connect(context.destination);
      node = processor;
    }

    source.connect(node);
    this.#tracks.set(id, { context, stream, node });
  }

  /** Stop every track and release the devices. */
  async stop(): Promise<void> {
    for (const { context, stream, node } of this.#tracks.values()) {
      node.disconnect();
      if ("port" in node) node.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => {});
    }
    this.#tracks.clear();
  }
}

/**
 * Dictation: one microphone, straight into the composer.
 *
 * A thin wrapper over the same capture path meetings use, because the only
 * differences are that there is one track and the audio goes to a different
 * IPC channel. The level is computed here rather than asked of the main
 * process: the chunks pass through this code anyway, and a round trip per
 * meter frame would be absurd.
 */
export class DictationCapture {
  #capture: MeetingCapture | undefined;

  async start(opts: {
    micDeviceId?: string;
    /** Only the hands-free loop sets this; see MeetingCapture.start. */
    echoCancellation?: boolean;
    onChunk: (pcm: ArrayBuffer) => void;
    onLevel?: (level: { peak: number; rms: number }) => void;
  }): Promise<void> {
    const capture = new MeetingCapture();
    await capture.start({
      ...(opts.micDeviceId ? { micDeviceId: opts.micDeviceId } : {}),
      ...(opts.echoCancellation ? { echoCancellation: true } : {}),
      systemAudio: false,
      onChunk: (_track, pcm) => {
        opts.onLevel?.(levelOfPcm(new Int16Array(pcm)));
        opts.onChunk(pcm);
      },
    });
    this.#capture = capture;
  }

  async stop(): Promise<void> {
    await this.#capture?.stop();
    this.#capture = undefined;
  }

  get active(): boolean {
    return this.#capture !== undefined;
  }
}
