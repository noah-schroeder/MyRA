/**
 * What the audio actually is, as opposed to what the header said.
 *
 * A reply that synthesised perfectly reached the window as "Failed to load
 * because no supported source was found" -- Chromium's words for a Blob it
 * will not decode. Two separate things produce that, and neither is visible
 * from the outside:
 *
 *   - the container is not what the `content-type` claimed, so the element is
 *     handed an MP3 labelled as something else, or bytes labelled
 *     `application/octet-stream` that it declines to sniff;
 *   - the container is exactly what it claimed and this build cannot decode
 *     it. MP3 needs a codec that not every Chromium ships, and WAV needs none.
 *
 * So what comes back is identified from its own first bytes rather than from
 * the header. Which container to ask for in the first place is `wav.ts`'s
 * business, and the answer turned out not to be WAV.
 */

/**
 * The format's own signature, or undefined when the bytes say nothing.
 *
 * Undefined is a real answer: it means trust the header, which is right for a
 * container this does not know rather than a reason to refuse to play it.
 */
export function sniffAudio(bytes: Uint8Array): string | undefined {
  const ascii = (at: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  if (bytes.length < 4) return undefined;
  // RIFF....WAVE
  if (ascii(0, "RIFF") && bytes.length >= 12 && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "fLaC")) return "audio/flac";
  // ISO base media: ....ftyp, which covers m4a and aac-in-mp4.
  if (bytes.length >= 12 && ascii(4, "ftyp")) return "audio/mp4";
  // MP3, both forms: an ID3 tag, or a bare frame sync.
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}

/**
 * The type to hand a Blob: the bytes' own answer, else the server's.
 *
 * `application/octet-stream` is discarded rather than passed on. It is what a
 * server says when it has not thought about it, and giving it to an <audio>
 * element is the difference between playing and "no supported source".
 */
export function audioMime(bytes: Uint8Array, header?: string | undefined): string {
  const sniffed = sniffAudio(bytes);
  if (sniffed) return sniffed;
  const said = header?.split(";")[0]?.trim().toLowerCase();
  if (said && said !== "application/octet-stream" && said.startsWith("audio/")) return said;
  return "audio/mpeg";
}

/** Whether a 400 was the server objecting to the container MyRA asked for. */
export function refusedTheFormat(status: number, body: string): boolean {
  return status === 400 && /response_format|format/i.test(body);
}
