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

  await window.karen.reportDevices(sources);
  return sources;
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
    onChunk: (trackId: string, pcm: ArrayBuffer) => void;
    onWarning?: (message: string) => void;
  }): Promise<{ id: string; label: string; source?: string }[]> {
    const specs: { id: string; label: string; source?: string }[] = [];

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
          // Off, deliberately. These are tuned for intelligibility on a call,
          // and echo cancellation in particular will remove the far side of the
          // conversation -- which is the half the second track exists to keep.
          echoCancellation: false,
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
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        // The video track is only there because some platforms refuse an
        // audio-only capture request. Stop it immediately; nothing reads it.
        for (const track of display.getVideoTracks()) {
          display.removeTrack(track);
          track.stop();
        }
        if (display.getAudioTracks().length === 0) {
          throw new Error("the chosen source was shared without audio");
        }
        await this.#attach("them", display, opts.onChunk);
        specs.push({ id: "them", label: "Everyone else" });
      } catch (err) {
        // A meeting missed cannot be recovered; a meeting recorded from one
        // side usually can be worked with. So warn and carry on.
        opts.onWarning?.(
          `Recording your side only — system audio was not captured (${(err as Error).message}). ` +
            `On macOS this needs a virtual audio device.`,
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
      const worklet = new AudioWorkletNode(context, "pcm-worklet");
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
