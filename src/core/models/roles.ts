/**
 * What a model is for, and how a choice of one is written down.
 *
 * Lemonade serves chat, speech, voice, embeddings and images through one API,
 * so "what is this model for" has exactly one answer available: the `labels`
 * array on `/api/v1/models`. That is the field this module is built on, and it
 * replaces the way MyRA used to decide -- `/whisper|moonshine/i` against the
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

/**
 * Every label that means "this is not something you hold a conversation with".
 *
 * The chat picker's version of `isForRole`, and it has to be a denial rather
 * than an allow-list: chat models carry `chat`, `reasoning`, `vision`, `tools`
 * and more besides, and a model with none of them is far more likely to be a
 * chat model whose entry is thin than a diffusion model in disguise.
 */
export const MEDIA_LABELS: ReadonlySet<string> = new Set([
  ...ROLE_LABELS.transcription, ...ROLE_LABELS.voice, ...ROLE_LABELS.image,
  /* `embeddings`, plural, is what the daemon actually writes -- checked
     against its own catalogue, where all five entries carry exactly that. The
     singular was here alone, matched nothing, and left every embedding model
     in the list of things you could hold a conversation with. */
  "embeddings", "embedding",
]);

/**
 * The label that means "these labels are defaults, not findings".
 *
 * Measured on a running daemon: `embeddinggemma-300M-GGUF-Q8_0` comes back as
 * `["chat", "custom"]`. It is not a chat model. Anything registered from a
 * folder rather than found in Lemonade's own catalogue is labelled `custom`
 * and given `chat` because that is what most GGUFs are -- so for those, and
 * only those, the id is better evidence than the label.
 */
export const CUSTOM_LABEL = "custom";

/**
 * Whether a LOCAL model can hold a conversation.
 *
 * Labels first, because they are the daemon's own; the name only where the
 * labels are known to be a guess. Both wrong answers were seen in one build:
 * Whisper offered as a chat model when the labels were not read at all, and
 * an embedding model offered when they were read too trustingly.
 */
export function localFitsChat(id: string, labels: readonly string[] | undefined): boolean {
  const said = labels ?? [];
  if (said.some((label) => MEDIA_LABELS.has(label))) return false;
  if (!said.length || said.includes(CUSTOM_LABEL)) return fitsRole(id, "chat");
  return true;
}

export function isForRole(labels: readonly string[] | undefined, role: MediaRole): boolean {
  const wanted = ROLE_LABELS[role];
  return (labels ?? []).some((label) => wanted.includes(label));
}

/**
 * Whether a chat model reads images, going by the same labels the catalogue's
 * `vision` group already declares (`LABEL_GROUPS` in runtime/catalog.ts).
 *
 * Not a refusal when it comes back false: a `custom`-labelled model's labels
 * are a guess (see CUSTOM_LABEL above), and a hosted provider reports no
 * labels at all. Both are reasons to warn before sending an image, never a
 * reason to block it -- the composer says so and sends anyway.
 */
export function hasVision(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((label) => label === "vision" || label === "omni");
}

/**
 * What a PROVIDER's model looks like it is for, from its name alone.
 *
 * Guessing is exactly what this module's header says not to do, and the
 * reasoning still holds — for local models, where `labels` is a fact the
 * daemon reports. A provider offers no such field: `/v1/models` is a list of
 * ids and nothing else, so the only alternatives to guessing are to show every
 * model for every job or to make the user classify their whole catalogue by
 * hand. The first is what the pickers did, and it put `gpt-4o` in the list of
 * things that could transcribe a meeting and `whisper-1` in the list of things
 * that could hold a conversation.
 *
 * So: a guess, but never a fence. Everything it excludes stays one click away
 * in the menu (see ModelMenu), and a model already chosen is never hidden —
 * the guess decides what is offered FIRST, not what exists.
 *
 * Ordered, and deliberately: `gpt-4o-transcribe` and `gpt-4o-mini-tts` both
 * contain a chat model's name, so the specific patterns are tested before
 * anything is called chat.
 */
/**
 * "embeddings" is a job here, though it is not a media role.
 *
 * It has no picker of its own in the bar, but it is very much a thing the CHAT
 * picker has to keep out: `embeddinggemma-300M-GGUF`, indexed out of an LM
 * Studio folder and so carrying no labels, sat in the list of models to hold a
 * conversation with. An embedding model asked for a conversation returns
 * vectors or an error.
 */
export type GuessedRole = MediaRole | "chat" | "embeddings";

const ROLE_HINTS: readonly (readonly [GuessedRole, RegExp])[] = [
  ["embeddings", /embed|(^|[^a-z])bge([^a-z]|$)|gte-|e5-(small|base|large)|nomic-embed|minilm/i],
  ["transcription", /whisper|transcrib|speech[-_ ]?to[-_ ]?text|(^|[^a-z])stt([^a-z]|$)|moonshine|deepgram|nova-\d|scribe|canary|parakeet/i],
  ["voice", /(^|[^a-z])tts([^a-z]|$)|text[-_ ]?to[-_ ]?speech|speech-\d|voice|kokoro|eleven|sonic|orpheus|bark/i],
  ["image", /image|dall[-_ ]?e|diffusion|(^|[^a-z])sd(xl)?([^a-z]|$)|flux|imagen|midjourney|firefly|ideogram|recraft/i],
];

/** The job a provider's model id suggests, or "chat" when nothing suggests otherwise. */
export function guessRole(model: string): GuessedRole {
  for (const [role, pattern] of ROLE_HINTS) if (pattern.test(model)) return role;
  return "chat";
}

/**
 * Whether a provider's model belongs in the list for this job.
 *
 * "chat" is a role here too, because the chat picker has the same problem in
 * the other direction: a provider's whole catalogue was offered as models to
 * hold a conversation with, `tts-1` and `whisper-1` included.
 */
export function fitsRole(model: string, role: GuessedRole): boolean {
  return guessRole(model) === role;
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
  /**
   * Whether this looks like a model for the job that was asked about.
   *
   * Always true for a local model, where the daemon's labels settle it. For a
   * provider's model it is `guessRole`'s answer, and false means "offered
   * second, behind one click" — never "hidden".
   */
  fits?: boolean;
  /**
   * The engine a local model runs on: `whispercpp`, `kokoro`, `sd-cpp`…
   *
   * Carried so a picker can say that an engine is not installed BEFORE the
   * model is chosen. Lemonade installs engines one recipe at a time, and
   * installing the one that answers chat installs none of the others — so the
   * list happily offered Whisper, the download succeeded, and the failure
   * waited until the end of the first sentence somebody dictated.
   */
  recipe?: string;
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
