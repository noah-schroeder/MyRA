/**
 * Making the voice model's audio into something a browser will play.
 *
 * The reply synthesised, the daemon answered 200, and the window said "Failed
 * to load because no supported source was found". Asking for WAV instead of
 * MP3 did not help, and the reason is in the bytes -- measured on the local
 * daemon's own `response_format: "wav"`:
 *
 *     fmt  audioFormat: 3   bitsPerSample: 32   sampleRate: 24000
 *     RIFF size: 4294967295      data size: 4294967295
 *
 * Two independent defects. The samples are IEEE **float32**, which Chromium's
 * WAV decoder does not accept; and both size fields are 0xFFFFFFFF, the
 * placeholder a streaming writer puts there and never goes back to patch, so
 * a decoder reading them is told to expect four gigabytes that do not exist.
 *
 * Neither is Karen's to fix upstream, and both are trivial to fix here. The
 * daemon will also hand over raw 16-bit PCM if asked, which needs no repair at
 * all -- only a header. So Karen asks for that, and keeps the repair for
 * whatever else an endpoint might send.
 */

/** Formats in a `fmt ` chunk. 1 is integer PCM; 3 is IEEE float. */
const PCM = 1;
const FLOAT = 3;

/** What Karen asks for, and what the header below is built for. */
export const PCM_FORMAT = "pcm";
/** Asked for next, when an endpoint will not produce raw samples. */
export const WAV_FORMAT = "wav";

export interface PcmShape {
  rate: number;
  channels: number;
  /** Bits per sample of the SOURCE; 32 means float and is converted. */
  bits: number;
}

/**
 * The 24 kHz mono the OpenAI-shaped `pcm` format means.
 *
 * Both the local daemon and OpenAI document exactly this, and it is what the
 * measurement above shows, so it is the right default when a `content-type`
 * declines to say.
 */
export const DEFAULT_PCM: PcmShape = { rate: 24_000, channels: 1, bits: 16 };

/** Whether a content-type says "these are raw samples, not a container". */
export function isRawPcm(contentType?: string | undefined): boolean {
  return /^audio\/(l16|l24|pcm|x-pcm|raw)\b/i.test((contentType ?? "").trim());
}

/** The sample rate an `audio/l16;rate=24000` header declares. */
export function rateFrom(contentType?: string | undefined): number | undefined {
  const found = /[;\s]rate=(\d{4,6})/i.exec(contentType ?? "");
  const rate = found ? Number(found[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * A canonical 44-byte WAV header in front of 16-bit samples.
 *
 * Every size is written from the actual byte count, which is the whole point:
 * this is the header the streaming one should have been.
 */
export function wavFromPcm(samples: Uint8Array, shape: PcmShape = DEFAULT_PCM): Uint8Array {
  const bits = 16;
  const channels = Math.max(1, shape.channels);
  const rate = Math.max(1, shape.rate);
  const blockAlign = (channels * bits) / 8;
  const out = new Uint8Array(44 + samples.length);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, samples.length, true);
  out.set(samples, 44);
  return out;
}

/** Float32 samples in [-1, 1] as signed 16-bit little-endian. */
export function floatToInt16(bytes: Uint8Array): Uint8Array {
  const count = Math.floor(bytes.length / 4);
  const from = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(count * 2);
  const to = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    const v = Math.max(-1, Math.min(1, from.getFloat32(i * 4, true)));
    /* Asymmetric on purpose: -1 maps to -32768 and +1 to 32767, which is the
       range a signed 16-bit sample actually has. */
    to.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

interface Chunk { id: string; at: number; size: number }

/** The RIFF chunks, reading declared sizes but never trusting them. */
function chunks(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    out.push({ id, at: at + 8, size });
    /* A placeholder size, or one past the end, means this is the last chunk
       and it runs to the end of what actually arrived. */
    if (size === 0xffffffff || at + 8 + size > bytes.length) break;
    at += 8 + size + (size % 2);
  }
  return out;
}

function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = (at: number, text: string): boolean =>
    String.fromCharCode(...bytes.subarray(at, at + text.length)) === text;
  return tag(0, "RIFF") && tag(8, "WAVE");
}

/**
 * A WAV a browser will accept, or undefined when it was already fine.
 *
 * Undefined rather than a copy, so nothing is rewritten needlessly: the common
 * case for a hosted provider is a perfectly ordinary file.
 */
export function repairWav(bytes: Uint8Array): Uint8Array | undefined {
  if (!isWav(bytes)) return undefined;
  const found = chunks(bytes);
  const fmt = found.find((c) => c.id === "fmt ");
  const data = found.find((c) => c.id === "data");
  if (!fmt || !data || fmt.size < 16) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(fmt.at, true);
  const channels = view.getUint16(fmt.at + 2, true);
  const rate = view.getUint32(fmt.at + 4, true);
  const bits = view.getUint16(fmt.at + 14, true);

  /* The real length of the samples, which is the only number that can be
     trusted: the declared one is 0xFFFFFFFF on a streamed file. */
  const declared = data.size === 0xffffffff ? Number.POSITIVE_INFINITY : data.size;
  const length = Math.min(declared, bytes.length - data.at);
  const samples = bytes.subarray(data.at, data.at + length);

  const broken = data.size === 0xffffffff || data.at + data.size > bytes.length;
  if (format === FLOAT && bits === 32) {
    return wavFromPcm(floatToInt16(samples), { rate, channels, bits: 16 });
  }
  if (format === PCM && bits === 16 && broken) {
    return wavFromPcm(samples, { rate, channels, bits: 16 });
  }
  // Integer PCM with honest sizes, or something exotic this should not touch.
  return broken ? wavFromPcm(samples, { rate, channels, bits }) : undefined;
}
