/**
 * "The model would not load", said in a way somebody can act on.
 *
 * The daemon's own answer is a 500 with a JSON body:
 *
 *     {"error":{"code":"model_load_error",
 *               "message":"Failed to load model 'Whisper-Large-v3-Turbo':
 *                          whisper-server failed to start or become ready",
 *               "requested_model":"Whisper-Large-v3-Turbo", ...}}
 *
 * which arrived in front of a user, in full, at the end of a sentence they had
 * just dictated. Every word of it is true and none of it says what to do.
 *
 * What it almost always means: the model is fine and the ENGINE that runs it is
 * not installed. Lemonade installs engines per recipe — `llamacpp` for chat,
 * `whispercpp` for Whisper, `kokoro` for the voice — and installing the one
 * that runs chat does not install the others. So the model list offers Whisper,
 * the download succeeds, and the failure waits until the first thing you say.
 *
 * This is the pure half: recognising that shape and writing the sentence. The
 * engine's name is passed in, because only the main process has the catalogue
 * that maps a model to its recipe.
 */

import type { MediaRole } from "./roles.ts";

export interface LoadFailure {
  /** The model the daemon was asked for, when it named one. */
  model: string;
}

/**
 * Lemonade's "could not load that" in any of the forms it arrives in.
 *
 * Matched on the code first, since that is the field the daemon owns and the
 * one least likely to be reworded. The prose is checked too because the same
 * failure reaches Karen through the OpenAI-shaped error path of three
 * different clients, and one of them may only have the message.
 */
export function loadFailureIn(text: string): LoadFailure | undefined {
  if (!/model_load_error|failed to start or become ready|failed to load model/i.test(text)) {
    return undefined;
  }
  const named =
    /"requested_model"\s*:\s*"([^"]+)"/.exec(text) ??
    /failed to load model ['"]([^'"]+)['"]/i.exec(text);
  return { model: named?.[1] ?? "" };
}

const DOES: Record<MediaRole, string> = {
  transcription: "transcribe",
  voice: "speak",
  image: "draw",
};

/**
 * What to say instead of the raw body.
 *
 * Names the model, names the engine when it is known, and points at the one
 * screen that can fix it. Deliberately does NOT claim the engine is missing:
 * an installed engine that crashes on startup produces this same error, and
 * the daemon's log — which is on that screen — is what tells the two apart.
 */
export function explainLoadFailure(
  failure: LoadFailure,
  opts: { role: MediaRole; engine?: string | undefined },
): string {
  const model = failure.model || `the ${opts.role === "voice" ? "voice" : opts.role} model`;
  const engine = opts.engine
    ? `It runs on the ${opts.engine} engine`
    : "It runs on an engine of its own";
  return (
    `${model} would not load, so there was nothing to ${DOES[opts.role]} with. ` +
    `${engine}, which is installed separately from the one that answers chat — ` +
    "open Settings → Runtime to install it, or to see the log if it is installed " +
    "and failing to start."
  );
}

/**
 * The whole translation, or nothing when this was a different failure.
 *
 * Returning undefined rather than a vague sentence is the point: a timeout, a
 * refused key and a 404 all have their own messages that are better than this
 * one, and overwriting them would be a downgrade.
 */
export function explainIfLoadFailure(
  text: string,
  opts: { role: MediaRole; engine?: string | undefined },
): string | undefined {
  const failure = loadFailureIn(text);
  return failure ? explainLoadFailure(failure, opts) : undefined;
}
