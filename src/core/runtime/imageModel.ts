/**
 * Adding a diffusion model by naming its parts.
 *
 * The one thing the registry search cannot do. A modern image model is three
 * files -- the diffusion model, a text encoder and a VAE -- and which three go
 * together is written down only in Lemonade's own catalogue: FLUX.2-klein-9B's
 * encoder is a Qwen3-8B in an unrelated repository, and nothing on Hugging
 * Face connects them. So a model the catalogue does not carry can only be had
 * by somebody typing the three addresses, and this is the half of that with no
 * socket in it.
 *
 * Measured against `POST /api/v1/models/register` on lemond 11.8.0, because
 * every rule below is one the daemon enforces and none of it is documented:
 *
 *   - the name must be in the `user.` namespace, or 400: `Registered model
 *     definitions must use a non-empty 'user.*' name`;
 *   - `checkpoints` must be an object carrying `main`;
 *   - every other role must name an exact file, not just a repository
 *     (`Additional checkpoints must contain an exact repository variant`);
 *   - and all of them must come from one registry (`All checkpoints in one
 *     model must use the same remote registry`).
 *
 * Checked here rather than left to the daemon because a 400 carrying the
 * daemon's own sentence arrives after the dialog has closed, and the person
 * who mistyped a repository needs to be told which field.
 */

/** The parts a diffusion model is assembled from, in the order they are asked for. */
export const IMAGE_PART_ROLES = ["main", "text_encoder", "vae"] as const;

export type ImagePartRole = (typeof IMAGE_PART_ROLES)[number];

/** What each field is called and what it is for, so the form and the tests agree. */
export const IMAGE_PART_WORDS: Record<ImagePartRole, { label: string; hint: string }> = {
  main: {
    label: "Diffusion model",
    hint: "The model itself — org/repo:file.gguf, or .safetensors.",
  },
  text_encoder: {
    label: "Text encoder",
    hint: "What turns the prompt into something the model reads. Leave blank for an all-in-one checkpoint.",
  },
  vae: {
    label: "VAE",
    hint: "What turns the result into a picture. Leave blank for an all-in-one checkpoint.",
  },
};

export interface ImageModelInput {
  /** What the person calls it; becomes the `user.` name. */
  name: string;
  parts: Partial<Record<ImagePartRole, string>>;
  /** `sd-cpp` unless something else grows a split-checkpoint engine. */
  recipe?: string | undefined;
}

export interface ImageModelRecord {
  modelName: string;
  checkpoints: Record<string, string>;
  recipe: string;
}

/**
 * `org/repo:file`, which is what an additional checkpoint has to be.
 *
 * The file part is required even for `main`: the daemon accepts a bare
 * repository there, but then picks a file itself, and for a diffusion
 * repository holding thirty quantisations that choice is not one to leave to
 * alphabetical order.
 */
const ADDRESS = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._\-/]+$/;

/**
 * The daemon's namespace rule, applied to whatever the person typed.
 *
 * Their own text is kept recognisable rather than hashed -- this name is what
 * they will look for in the model list -- so only what Lemonade cannot carry is
 * replaced, and a name they already prefixed is not prefixed twice.
 */
export function imageModelName(label: string): string {
  const slug = label.trim().replace(/^user\./, "").replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `user.${slug}` : "";
}

export type ImageModelCheck =
  | { ok: true; record: ImageModelRecord }
  | { ok: false; field: "name" | ImagePartRole; error: string };

/**
 * Turn what the form holds into what the daemon takes, or say what is wrong.
 *
 * Returns the offending field rather than only a sentence, because the dialog
 * has four inputs and "that address is not valid" without saying which one is
 * the error message this function exists to avoid.
 */
export function checkImageModel(input: ImageModelInput): ImageModelCheck {
  const modelName = imageModelName(input.name);
  if (!modelName) {
    return { ok: false, field: "name", error: "Give the model a name so you can find it in the list." };
  }

  const main = input.parts.main?.trim() ?? "";
  if (!main) {
    return { ok: false, field: "main", error: "The diffusion model is the one part that is never optional." };
  }

  const checkpoints: Record<string, string> = {};
  for (const role of IMAGE_PART_ROLES) {
    const value = input.parts[role]?.trim() ?? "";
    if (!value) continue;
    if (!ADDRESS.test(value)) {
      return {
        ok: false,
        field: role,
        error:
          `${IMAGE_PART_WORDS[role].label} must name a repository and a file, as ` +
          `org/repo:file.safetensors. “${value}” names ${value.includes(":") ? "neither" : "no file"}.`,
      };
    }
    checkpoints[role] = value;
  }

  /* The daemon's "same remote registry" rule needs nothing here: a registry is
     a per-model field, not part of an address, so every role a model carries
     is fetched from the one `source` MyRA sends with it. */
  return { ok: true, record: { modelName, checkpoints, recipe: input.recipe ?? "sd-cpp" } };
}
