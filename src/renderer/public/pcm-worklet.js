/**
 * Float32 to signed 16-bit PCM, on the audio thread.
 *
 * This runs in an AudioWorklet rather than a ScriptProcessorNode because a
 * ScriptProcessor runs on the main thread: a React render or a long tool result
 * arriving mid-meeting would drop audio, and a meeting cannot be re-recorded.
 *
 * No resampling here. The AudioContext is constructed at 16 kHz and the
 * browser resamples on the way in, which is both correct and free.
 */
class PcmWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      // Clamp before scaling: a sample above 1.0 wraps to a large negative
      // number otherwise, which sounds like a loud click rather than clipping.
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
