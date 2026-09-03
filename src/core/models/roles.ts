/**
 * What a model is for, and how a choice of one is written down.
 *
 * Lemonade serves chat, speech, voice, embeddings and images through one API,
 * so "what is this model for" has exactly one answer available: the `labels`
 * array on `/api/v1/models`. That is the field this module is built on, and it
 * replaces the way Karen used to decide -- `/whisper|moonshine/i` against the
 * model id, which is a guess that was already wrong for anything renamed and
 * would have called a Kokoro voice model a transcriber the moment someone
 * published `whisper-tts`.
 *
 * A choice is stored as a REFERENCE, the same shape the chat model uses:
 * a bare id is a model the local daemon runs, and `provider::model` is one of
 * the user's own providers. That is what lets one field answer both "which
 * model" and "does using it leave this machine".
 *
 * This started life as core/audio/models.ts, serving two roles. It was lifted
 * here whole when image generation arrived, because the alternative was a
 * second copy of "which endpoint does this reference mean, and does it leave
 * the machine" -- and that is the one question in this app where two answers
 * that disagree is a privacy bug rather than an inconsistency.
 */

import { parseModelRef } from "../providers.ts";

/** A job a model can be picked for, besides answering in the chat. */
export type MediaRole = "transcription" | "voice" | "image";

/**
 * The labels that mean a model does this job.
 *
 * `realtime-transcription` is included because every Whisper and Moonshine
 * entry in the catalogue carries both, and a model that can stream can also do
 * a single utterance. Excluding it would have hidden all three Moonshine
 * models from a picker they belong in.
 *
 * `image` is the label the catalogue already groups diffusion models under
 * (see LABEL_GROUPS in runtime/catalog.ts), so nothing new is being invented
 * here -- this is the reader for a field the rest of the app already writes.
 */
export const ROLE_LABELS: Record<MediaRole, readonly string[]> = {
  transcription: ["transcription", "realtime-transcription"],
  voice: ["tts"],
  image: ["image"],
};

export function isForRole(labels: readonly string[] | undefined, role: MediaRole): boolean {
  const wanted = ROLE_LABELS[role];
  return (labels ?? []).some((label) => wanted.includes(label));
}

/** One choice a picker can offer. */
export interface ModelOption {
  /** What gets stored: `Whisper-Base`, or `p3::gpt-4o-transcribe`. */
  ref: string;
  /** The model's own id, without the provider qualifier. */
  model: string;
  /** Where it runs. */
  where: "local" | "provider";
  /** Provider label, for the group heading. */
  providerLabel?: string;
  /** True when a request to it leaves this machine. */
  external?: boolean;
  /** Already on disk (local), so choosing it costs nothing. */
  downloaded?: boolean;
  /** Download size, for one that is not here yet. */
  sizeBytes?: number | undefined;
  /** Currently held in memory by the daemon. */
  loaded?: boolean;
}

/**
 * Whether a stored choice names one of the user's providers.
 *
 * The same test `standsDownForLocal` makes for the chat model, and it has to
 * agree with it: a qualified reference is routed to a provider, and a bare one
 * can only ever mean the daemon on this machine.
 */
export function isProviderRef(ref: string): boolean {
  return Boolean(parseModelRef(ref).providerId);
}

/**
 * The model id to put in the request body.
 *
 * Never the whole reference. Sending `p3::whisper-1` as the model name is a
 * request no server can answer, and the failure reads as "the endpoint does
 * not have that model" rather than as a bug here.
 */
export function modelIdOf(ref: string): string {
  return parseModelRef(ref).model;
}

/**
 * Names for a list of models, shortened only while they stay distinguishable.
 *
 * `shortModelName` strips a trailing -GGUF and a quantisation suffix, which is
 * right for a model found in another tool's folder: there the suffix is how it
 * was packaged, not which model it is. It is wrong for the catalogue, which
 * lists `SD-Turbo` AND `SD-Turbo-GGUF` as separate downloads -- 5.2 GB against
 * 2.0 GB -- and the picker drew two rows both saying "SD-Turbo" with nothing to
 * choose between them.
 *
 * So the short form is used unless it is ambiguous IN THIS LIST, and everything
 * caught in a collision keeps its full id. Returns a function rather than a map
 * so a caller with one model in hand -- the button on the bar, which must not
 * disagree with the menu behind it -- can ask the same question.
 */
export function modelNamer(
  models: readonly string[],
  short: (model: string) => string,
): (model: string) => string {
  const counts = new Map<string, number>();
  for (const model of models) {
    const name = short(model);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (model) => {
    const name = short(model);
    return (counts.get(name) ?? 0) > 1 ? model : name;
  };
}
