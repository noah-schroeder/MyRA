/**
 * Which models can hear, and which can speak.
 *
 * The vocabulary itself -- roles, labels, the shape of a choice -- moved to
 * core/models/roles.ts when image generation became a third role asking the
 * same questions. What is left here is the audio-shaped view of it: a role
 * type narrowed to the two speech jobs, so a picker built for audio cannot be
 * handed "image" by accident, and the re-exports that keep every existing
 * import site working.
 */

export {
  isForRole, isProviderRef, modelIdOf, ROLE_LABELS,
} from "../models/roles.ts";
export type { MediaRole, ModelOption } from "../models/roles.ts";

import type { MediaRole, ModelOption } from "../models/roles.ts";

/** The two speech roles, and only those. */
export type AudioRole = Extract<MediaRole, "transcription" | "voice">;

/** One choice the Audio pane or the chat bar can offer. */
export type AudioOption = ModelOption;
