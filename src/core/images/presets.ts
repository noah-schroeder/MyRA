/**
 * Prompt scaffolding for the figures academic work actually needs.
 *
 * A preset is style, never subject. The user's own words lead the prompt and
 * the scaffold follows, so switching preset changes how a thing is drawn and
 * never what is drawn -- and composition happens at send time from (typed,
 * presetId) rather than by editing the box, which is what stops a scaffold
 * being duplicated, half-deleted, or stranded in the textarea after the preset
 * that put it there was turned off.
 *
 * ## What is deliberately not here
 *
 * There is no flowchart preset, and no PRISMA preset, which are the first two
 * things a researcher will look for. Diffusion models cannot letter a diagram:
 * they produce text-shaped marks, so every box in a generated flow chart comes
 * back confidently labelled with something that is not a word. A button
 * promising one would be a button that silently disappoints, which is worse
 * than not offering it -- so the presets aim at illustration and composition,
 * which these models are genuinely good at, and LETTERING_WARNING says the
 * rest out loud instead of hiding it.
 */

export interface ImagePreset {
  id: string;
  label: string;
  /** Shown under the chip. What this is for, in the user's terms. */
  hint: string;
  /** Appended after the user's own words. */
  scaffold: string;
  /** Folded into whatever is in the negative box. */
  avoid: string;
}

/**
 * Said once, plainly, wherever the presets are.
 *
 * The register of the README's "What leaves this machine": a claim is only
 * honest if its edges are named, and the edge here is that the one thing a
 * figure needs most is the one thing this cannot do.
 */
export const LETTERING_WARNING =
  "Any lettering will come out as convincing gibberish — these models draw the shape of text, " +
  "not text. Generate the picture here and add real labels afterwards in a vector editor.";

const FIGURE_AVOID = "photorealistic, photograph, watermark, signature, jpeg artifacts, blurry";

export const IMAGE_PRESETS: readonly ImagePreset[] = [
  {
    id: "conceptual",
    label: "Conceptual diagram",
    hint: "Flat shapes and arrows for a relationship or a process. Add the labels yourself.",
    scaffold:
      "as a clean flat vector conceptual diagram, simple geometric shapes connected by arrows, " +
      "generous white space, limited flat colour palette, no text, no lettering",
    avoid: `${FIGURE_AVOID}, text, letters, words, captions, gradients, 3d render`,
  },
  {
    id: "schematic",
    label: "Schematic",
    hint: "Technical line drawing of an apparatus, device or cross-section.",
    scaffold:
      "as a precise technical schematic line drawing, thin uniform black linework on white, " +
      "orthographic cross-section, engineering drawing style, no shading, no text",
    avoid: `${FIGURE_AVOID}, text, letters, colour wash, painterly, perspective distortion`,
  },
  {
    id: "illustration",
    label: "Scientific illustration",
    hint: "A textbook plate — an organism, structure or specimen, drawn to be looked at closely.",
    scaffold:
      "as a detailed scientific illustration in the style of a textbook plate, accurate " +
      "anatomical or structural detail, fine stippling and clean linework, neutral background",
    avoid: `${FIGURE_AVOID}, cartoon, anime, text, surreal, extra limbs`,
  },
  {
    id: "abstract",
    label: "Graphical abstract",
    hint: "A single composition summarising a study, for a journal's abstract panel.",
    scaffold:
      "as a journal graphical abstract, one balanced composition reading left to right, " +
      "flat modern scientific illustration style, restrained palette, plenty of negative space, no text",
    avoid: `${FIGURE_AVOID}, text, letters, cluttered, busy background`,
  },
  {
    id: "poster",
    label: "Poster figure",
    hint: "High contrast and simple shapes, so it still reads from two metres away.",
    scaffold:
      "as a bold high-contrast poster figure, large simple shapes, strong silhouettes, " +
      "saturated but limited palette, legible at a distance, no text",
    avoid: `${FIGURE_AVOID}, text, letters, fine detail, low contrast, pastel`,
  },
  {
    id: "cover",
    label: "Cover image",
    hint: "An evocative opener for a talk or a chapter, where accuracy matters less.",
    scaffold:
      "as an evocative cover image, atmospheric lighting, striking composition, " +
      "restrained colour grading, editorial science-magazine feel",
    avoid: "watermark, signature, jpeg artifacts, text, letters, borders",
  },
];

export function presetById(id: string | undefined): ImagePreset | undefined {
  return id ? IMAGE_PRESETS.find((p) => p.id === id) : undefined;
}

/**
 * The prompt as it will be sent.
 *
 * The user's words first and the scaffold second, because a diffusion model
 * weights the front of a prompt most heavily and the subject is the part that
 * must survive. Joined with a comma rather than a full stop: these prompts are
 * tag-shaped, and a sentence boundary invites the model to read the scaffold as
 * a second scene.
 */
export function composePrompt(typed: string, preset?: ImagePreset): string {
  const words = typed.trim().replace(/[,\s]+$/, "");
  if (!preset) return words;
  if (!words) return preset.scaffold;
  return `${words}, ${preset.scaffold}`;
}

/** The negative prompt as it will be sent: the user's, then the preset's. */
export function composeNegative(typed: string, preset?: ImagePreset): string {
  const words = typed.trim().replace(/[,\s]+$/, "");
  if (!preset) return words;
  if (!words) return preset.avoid;
  return `${words}, ${preset.avoid}`;
}
