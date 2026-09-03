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
 * engine's name and its state on this machine are passed in, because only the
 * main process has the catalogue that maps a model to its recipe and the
 * daemon's answer about which engines are installed here.
 */

import type { Runnable } from "../runtime/runnable.ts";
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

export interface LoadContext {
  role: MediaRole;
  /** The Lemonade recipe that runs this model, when it is known. */
  engine?: string | undefined;
  /**
   * What the daemon says about that engine on THIS machine.
   *
   * The reason the advice cannot be one sentence. Karen told a user with
   * whisper.cpp already installed to go and install whisper.cpp, because the
   * only sentence it had assumed the common case. The daemon knows which case
   * it is -- `/api/v1/system-info` reports every backend as installed,
   * installable or unsupported -- so asking it is the difference between
   * advice and a guess.
   */
  engineState?: Runnable | undefined;
  /**
   * True when Karen had to ship a C runtime for the daemon on this machine.
   *
   * Which makes this the likeliest cause of all, and a certain one rather than
   * a guess: the engines Lemonade downloads are built against GLIBC_2.38 --
   * measured on the released `whisper-server` and `koko` binaries -- and get
   * none of the help the daemon gets, because Lemonade starts them itself.
   * llama.cpp's build asks for 2.34, so on such a machine chat works and every
   * speech model exits the moment it starts. That asymmetry is the whole
   * confusing part of the symptom, and it deserves to be named.
   */
  oldSystem?: boolean | undefined;
  /**
   * The models sitting on the graphics card, other than the one being used.
   *
   * The list, not a byte count: the daemon reports each loaded model's device
   * but not the card's free memory, and a number Karen had to estimate would
   * be a worse thing to put in front of somebody than the names of the models
   * they can actually unload.
   */
  gpuResident?: string[] | undefined;
}

/**
 * What to say instead of the raw body.
 *
 * Three different failures arrive as this one error, and they have nothing in
 * common but the message:
 *
 *   - the engine is not installed, which is the usual one, because installing
 *     the engine that answers chat does not install the others;
 *   - the engine IS installed and its server died on startup, which is a
 *     half-downloaded model or a backend this machine cannot initialise;
 *   - the engine cannot run here at all.
 *
 * Naming the wrong one is worse than saying less: it sends somebody to a
 * screen where the button they are told to press is already done.
 */
export function explainLoadFailure(failure: LoadFailure, opts: LoadContext): string {
  const model = failure.model || `the ${opts.role} model`;
  const engine = opts.engine ? `the ${opts.engine} engine` : "an engine of its own";
  const opening = `${model} would not load, so there was nothing to ${DOES[opts.role]} with. `;

  if (opts.engineState === "ready" && opts.oldSystem) {
    return (
      opening +
      `${engine} is installed, so this is not something left undone: its server needs newer ` +
      "system libraries than this machine has, which is also why chat keeps working — " +
      "llama.cpp is built against an older system than the speech and image engines are. " +
      "Karen adapts those engines to this machine using the C library it ships for the " +
      "Lemonade daemon, and this failing means that did not take. Restarting Karen tries " +
      "again; Settings → Runtime has the log if it does not."
    );
  }

  if (opts.engineState === "ready") {
    /* The engine is there and its server exited anyway. Karen cannot see that
       server's own output -- the daemon starts it and keeps its stderr -- so
       this names the two causes that actually produce it rather than
       pretending to know which. A model file that stopped short is first
       because it is the one the user can fix without knowing anything. */
    return (
      opening +
      `${engine} is installed, so this is that engine's server exiting as soon as it ` +
      "started. Two things do that: a model file that did not finish downloading, and a " +
      "backend this machine cannot start. Settings → Runtime has the daemon's log, and " +
      "downloading the model again is the quicker of the two to rule out."
    );
  }

  if (opts.engineState === "unsupported") {
    return (
      opening +
      `This machine has no way to run ${engine} — the hardware it needs is not here, so ` +
      "another model is the only way forward. Settings → Runtime lists what this machine can run."
    );
  }

  const installed = opts.engineState === "needs-engine"
    ? `It runs on ${engine}, which is not installed yet`
    : `It runs on ${engine}, which is installed separately from the one that answers chat`;
  return (
    opening + installed +
    " — open Settings → Runtime to install it, or to see the log if it is installed " +
    "and failing to start."
  );
}

/**
 * The engine answered, and there was nothing in the answer.
 *
 * A different failure from "would not load" and it has to be said differently:
 * the server started, passed its readiness check and returned 200 to the
 * daemon, so nothing is missing and nothing needs installing. What is wrong is
 * the backend it is running on, failing at the point of use.
 *
 * Reported as `generate_image returned no results`, in 250 ms, from an sd-cpp
 * server running the CUDA backend on a laptop with switchable graphics -- the
 * daemon had just logged `__NV_PRIME_RENDER_OFFLOAD=1`. For comparison, the
 * identical request against the Vulkan backend took 33 seconds and returned a
 * PNG, which is what a real generation costs and what makes an instant empty
 * answer diagnostic rather than ambiguous.
 */
export function producedNothing(text: string): boolean {
  return /returned no results|no images? (?:were )?(?:returned|generated)/i.test(text);
}

/**
 * Why it produced nothing, in the order the causes actually occur.
 *
 * The reported one, run by hand because the daemon discards its engine's
 * stderr: `cudaMalloc failed: out of memory`, allocating 1411 MiB on an RTX
 * 4060 that was already holding a 30B chat model, Whisper-Large-v3-Turbo and
 * Kokoro. The engine, the backend and the driver were all fine. Lemonade's own
 * `max_loaded_models` is 1 but applies PER TYPE -- measured, seven pools -- so
 * it will happily hold a model of each kind and never evict one to make room
 * for another.
 *
 * Karen cannot see the card's free bytes, but it does know what is on it, and
 * that list IS the answer when it is not empty. Naming it beats naming a
 * backend, because unloading one speech model is a click and reinstalling an
 * engine is not.
 */
function explainEmptyAnswer(opts: LoadContext): string {
  const engine = opts.engine ? `The ${opts.engine} engine` : "The engine";
  const opening =
    `${engine} answered without producing anything. Its server started and reported itself ` +
    "ready, so nothing is missing or broken. ";

  const holding = opts.gpuResident ?? [];
  if (holding.length) {
    const list = holding.join(", ");
    return (
      opening +
      `The usual cause is the graphics card being full, and it is currently holding ${list}. ` +
      "Unloading one of those frees room for the picture — the eject button beside each " +
      "speech model does it, and a smaller one is often enough."
    );
  }
  return (
    opening +
    "Nothing else is on the graphics card, so what failed is the hardware backend the engine " +
    "was built for. Settings → Runtime lists the other backends this machine can install for " +
    "it."
  );
}

/**
 * The whole translation, or nothing when this was a different failure.
 *
 * Returning undefined rather than a vague sentence is the point: a timeout, a
 * refused key and a 404 all have their own messages that are better than this
 * one, and overwriting them would be a downgrade.
 */
export function explainIfLoadFailure(text: string, opts: LoadContext): string | undefined {
  const failure = loadFailureIn(text);
  if (failure) return explainLoadFailure(failure, opts);
  return producedNothing(text) ? explainEmptyAnswer(opts) : undefined;
}
