/**
 * The sizes to offer, because there is nothing to ask.
 *
 * The same position voices.ts is in: Lemonade publishes no OpenAPI document
 * and serves no route that enumerates what an image model will accept, so the
 * list is shipped rather than discovered. Three sizes rather than a dozen,
 * because the choice that matters is roughly "fast", "square figure" and "big
 * enough to print", and every extra row is a decision nobody wanted to make.
 *
 * The ceiling is a real one and worth stating in the UI: an SD1.5-class model
 * trained at 512 does not get better at 1024, it gets a second head and a
 * duplicated horizon. Offering the size is right -- SDXL-class models want it
 * -- but so is saying which model wants which.
 */

export interface ImageSize {
  id: string;
  label: string;
  hint: string;
}

export const IMAGE_SIZES: readonly ImageSize[] = [
  { id: "512x512", label: "512", hint: "Fastest, and what SD1.5-class models were trained at." },
  { id: "768x768", label: "768", hint: "A middle ground. Slower, and not every model holds together here." },
  { id: "1024x1024", label: "1024", hint: "For SDXL-class models. On a smaller one this usually makes a mess." },
];

export const DEFAULT_SIZE = "512x512";

/** `512x512` and nothing else -- this string goes straight into a request body. */
const SHAPE = /^\d{2,5}x\d{2,5}$/;

/**
 * Whether a size can be sent.
 *
 * Permissive about which sizes exist and strict about the shape, for the reason
 * voiceIsValid is: the shipped list is what MyRA knows, not what the engine
 * accepts, and a model that takes 1152x896 should not be refused by a table in
 * this file. What is refused is anything that is not a size at all, because
 * that came from an edited settings file rather than from the picker.
 */
export function sizeIsValid(size: string): boolean {
  if (!size.trim()) return true; // Omitted is legal; the engine picks.
  return SHAPE.test(size.trim());
}
