/**
 * Rasterising an exported SVG string to a PNG data URL.
 *
 * ChartView and DiagramView each built this exact img-onto-canvas dance
 * separately -- load the SVG as a data URI, wait for it to decode, draw it
 * into a canvas at the target pixel size, and read the canvas back out. One
 * copy, so a change to how either figure rasterises (the export page-size
 * work is what surfaced the duplication) cannot update one and miss the
 * other.
 */
export async function svgToPng(svg: string, pxWidth: number, pxHeight: number): Promise<string | undefined> {
  const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = url;
  if (!(await loaded)) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pxWidth));
  canvas.height = Math.max(1, Math.round(pxHeight));
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
