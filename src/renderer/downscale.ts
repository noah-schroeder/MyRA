/**
 * Shrinking a dropped photo before it ever leaves this component.
 *
 * A phone photo is routinely 12 megapixels, which would cost real context on
 * every turn it stays in the conversation (see IMAGE_TOKEN_ESTIMATE in
 * core/llm/attach.ts) and bloat the per-conversation attachment folder for no
 * benefit a vision model can use -- most encode at well under 1568px on the
 * long edge regardless of what is sent. The renderer is the only side of this
 * app with a DOM, so this is the one place it can happen.
 */

/** Long enough that OCR on a dense page of text still reads, short enough to
 *  bound the cost -- the edge length most vision encoders already downsample to. */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

export async function downscaleImage(file: File): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (!bitmap) return file.arrayBuffer();

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  // Already small enough, and already a format worth keeping as-is.
  if (scale === 1 && (file.type === "image/png" || file.type === "image/jpeg")) {
    bitmap.close();
    return file.arrayBuffer();
  }

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file.arrayBuffer();
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG only when nothing was resized -- a photo resized through a lossless
  // format is not actually smaller, which defeats the whole point.
  const asPng = scale === 1 && file.type === "image/png";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, asPng ? "image/png" : "image/jpeg", JPEG_QUALITY),
  );
  return blob ? blob.arrayBuffer() : file.arrayBuffer();
}
