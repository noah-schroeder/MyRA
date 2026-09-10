/**
 * How a model chooses its next token, per model, set by the user.
 *
 * Distinct from the options in `runtime/modelOptions.ts`, and the difference is
 * not cosmetic. Those are LOAD settings: Lemonade owns them, they go in a file
 * the daemon reads when it starts llama-server, and changing one means
 * reloading several gigabytes. These are REQUEST settings: they ride on each
 * chat completion, they change the next reply and nothing else, and they belong
 * to a conversation rather than to a process.
 *
 * ## Why this is not sent to everyone
 *
 * llama.cpp accepts a wide set of sampler fields on its OpenAI-compatible
 * endpoint. Hosted APIs accept a much smaller one and reject the rest outright
 * — a request carrying `top_k` to an endpoint that has never heard of it comes
 * back as a 400, not as a quietly ignored field. So each field declares whether
 * it is standard, and only the standard ones are sent to a provider Karen did
 * not start.
 *
 * That is why "leave it alone" has to be expressible per field, and why the
 * absence of a value is meaningful: an unset field is not sent at all, so the
 * server's own default applies, which is a different thing from sending what we
 * guess the default to be.
 */

export type SamplingKind = "number" | "integer";

export interface SamplingField {
  key: string;
  label: string;
  kind: SamplingKind;
  min: number;
  max: number;
  step: number;
  /** Accepted by hosted OpenAI-compatible APIs, not only by llama.cpp. */
  standard: boolean;
  help: string;
  advanced: boolean;
}

/**
 * The sampler set, in the order a person tunes them.
 *
 * Ranges are the ones llama.cpp actually accepts, and the help says what the
 * knob does rather than what it is called. Anything left blank is not sent.
 */
export const SAMPLING_FIELDS: SamplingField[] = [
  { key: "temperature", label: "Temperature", kind: "number", min: 0, max: 2, step: 0.05, standard: true, advanced: false,
    help: "How adventurous the wording is. Low is repetitive and literal; high wanders. 0 makes it as close to deterministic as the backend allows." },
  { key: "top_p", label: "Top-p (nucleus)", kind: "number", min: 0, max: 1, step: 0.01, standard: true, advanced: false,
    help: "Consider only the most likely words whose probabilities add up to this. 1 disables it." },
  { key: "top_k", label: "Top-k", kind: "integer", min: 0, max: 500, step: 1, standard: false, advanced: false,
    help: "Consider only this many candidates for each word. 0 disables it." },
  { key: "min_p", label: "Min-p", kind: "number", min: 0, max: 1, step: 0.01, standard: false, advanced: false,
    help: "Drop candidates less likely than this fraction of the best one. Often used instead of top-p." },
  { key: "typical_p", label: "Typical-p", kind: "number", min: 0, max: 1, step: 0.01, standard: false, advanced: true,
    help: "Locally typical sampling. 1 disables it." },
  { key: "repeat_penalty", label: "Repetition penalty", kind: "number", min: 0, max: 2, step: 0.01, standard: false, advanced: false,
    help: "Discourage words that have already appeared. 1 is off; above about 1.2 the writing starts to distort." },
  { key: "repeat_last_n", label: "Repetition window", kind: "integer", min: -1, max: 8192, step: 1, standard: false, advanced: true,
    help: "How many recent tokens the repetition penalty looks back over. -1 uses the whole context." },
  { key: "presence_penalty", label: "Presence penalty", kind: "number", min: -2, max: 2, step: 0.05, standard: true, advanced: true,
    help: "Push towards new subject matter." },
  { key: "frequency_penalty", label: "Frequency penalty", kind: "number", min: -2, max: 2, step: 0.05, standard: true, advanced: true,
    help: "Push away from words already used often." },
  { key: "dry_multiplier", label: "DRY multiplier", kind: "number", min: 0, max: 5, step: 0.01, standard: false, advanced: true,
    help: "Penalise repeated phrases rather than repeated words. 0 is off." },
  { key: "dry_base", label: "DRY base", kind: "number", min: 0, max: 8, step: 0.01, standard: false, advanced: true,
    help: "How steeply the DRY penalty grows with the length of the repeated phrase." },
  { key: "dry_allowed_length", label: "DRY allowed length", kind: "integer", min: 0, max: 64, step: 1, standard: false, advanced: true,
    help: "Phrases up to this many tokens may repeat before DRY acts." },
  { key: "xtc_probability", label: "XTC probability", kind: "number", min: 0, max: 1, step: 0.01, standard: false, advanced: true,
    help: "Chance of removing the most likely candidates outright, to break predictable phrasing. 0 is off." },
  { key: "xtc_threshold", label: "XTC threshold", kind: "number", min: 0, max: 1, step: 0.01, standard: false, advanced: true,
    help: "Only candidates above this probability can be removed by XTC." },
  { key: "mirostat", label: "Mirostat", kind: "integer", min: 0, max: 2, step: 1, standard: false, advanced: true,
    help: "0 off, 1 or 2 to target a fixed surprise level instead of using top-p and top-k." },
  { key: "mirostat_tau", label: "Mirostat target", kind: "number", min: 0, max: 10, step: 0.1, standard: false, advanced: true,
    help: "The surprise level Mirostat aims for. Lower is more focused." },
  { key: "mirostat_eta", label: "Mirostat rate", kind: "number", min: 0, max: 1, step: 0.01, standard: false, advanced: true,
    help: "How quickly Mirostat corrects itself." },
  { key: "seed", label: "Seed", kind: "integer", min: -1, max: 2_147_483_647, step: 1, standard: true, advanced: true,
    help: "Fix this to make a reply reproducible with the same prompt. -1 is random each time." },
  { key: "max_tokens", label: "Reply limit", kind: "integer", min: 1, max: 131_072, step: 1, standard: true, advanced: true,
    help: "Hard ceiling on the length of one reply. Leave blank to let the model stop on its own." },
];

const BY_KEY = new Map(SAMPLING_FIELDS.map((f) => [f.key, f]));

/** Only the keys above; a value is a finite number or the field is absent. */
export type Sampling = Record<string, number>;

/**
 * Read stored sampling back, dropping anything that is not a usable setting.
 *
 * Out-of-range values are dropped rather than clamped. A clamp would silently
 * turn a temperature of 40 -- which is somebody's typo -- into 2, and the reply
 * would be strange for a reason nothing on screen explained.
 */
export function parseSampling(raw: unknown): Sampling {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Sampling = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = BY_KEY.get(key);
    if (!field) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < field.min || n > field.max) continue;
    if (field.kind === "integer" && !Number.isInteger(n)) continue;
    out[key] = n;
  }
  return out;
}

/**
 * What a model's authors published as their own sampler defaults.
 *
 * `generation_config.json` sits beside the weights and is where a temperature
 * of 0.6 with top-p 0.95 comes from when a model card recommends one. Two names
 * differ from the OpenAI spelling and are renamed; everything else either
 * matches or is dropped, so a file full of `bos_token_id` and `eos_token_id`
 * yields nothing rather than noise.
 *
 * `do_sample: false` is deliberately NOT read as `temperature: 0`. That is an
 * inference about what the authors meant, and this module's whole discipline is
 * to carry values somebody stated rather than to guess a default -- an unset
 * field is not sent at all, which is a different thing from sending what we
 * imagine the server would have done.
 */
export function samplingFromGenerationConfig(raw: unknown): Sampling {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = { ...(raw as Record<string, unknown>) };
  const rename: Record<string, string> = {
    max_new_tokens: "max_tokens",
    repetition_penalty: "repeat_penalty",
  };
  for (const [from, to] of Object.entries(rename)) {
    if (row[from] !== undefined && row[to] === undefined) row[to] = row[from];
    delete row[from];
  }
  return parseSampling(row);
}

/**
 * The fields to actually send.
 *
 * `standardOnly` is the whole reason this function exists: a hosted API that has
 * never heard of `top_k` answers 400 for the whole request, so a user who tuned
 * min-p for their local model would find every hosted model broken and no
 * indication which setting did it.
 */
export function samplingForRequest(sampling: Sampling, standardOnly: boolean): Sampling {
  const out: Sampling = {};
  for (const [key, value] of Object.entries(sampling)) {
    const field = BY_KEY.get(key);
    if (!field) continue;
    if (standardOnly && !field.standard) continue;
    out[key] = value;
  }
  return out;
}

/** Which tuned fields will NOT be sent, so the editor can say so. */
export function droppedForExternal(sampling: Sampling): string[] {
  return Object.keys(sampling)
    .filter((key) => BY_KEY.get(key) && !BY_KEY.get(key)!.standard)
    .map((key) => BY_KEY.get(key)!.label);
}
