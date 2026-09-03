/**
 * Which voices a speech model can speak in.
 *
 * There is no endpoint to ask. Lemonade serves no `/audio/voices`, publishes no
 * OpenAPI document, and a request naming a voice it does not have comes back as
 * a bare `backend returned HTTP 500` with no list attached -- measured against
 * 11.8.0. So the names have to be shipped, and the ones below are not copied
 * from a README: each was POSTed to a running daemon and kept only if it
 * answered with audio. All forty did; `not_a_real_voice` did not, which is what
 * makes the list evidence rather than a guess.
 *
 * Kokoro encodes the language and the gender in the first two characters, so
 * the human-readable name is derived rather than written out forty times. A
 * table would have been forty chances to mislabel a voice.
 */

/** A voice as the picker shows it. */
export interface Voice {
  id: string;
  /** "Heart", from `af_heart`. */
  name: string;
  language: string;
  gender: "female" | "male";
}

/**
 * The voices `kokoro-v1` answers to, measured.
 *
 * Ordered as upstream lists them, which puts the best-graded American voices
 * first -- that ordering is the only quality signal available here, and
 * alphabetical would bury the ones most people should pick.
 */
export const KOKORO_VOICE_IDS: readonly string[] = [
  "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_alloy", "af_aoede",
  "af_jessica", "af_kore", "af_nova", "af_river",
  "am_adam", "am_michael", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_onyx",
  "am_puck", "am_santa",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
  "ef_dora", "em_alex",
  "ff_siwis",
  "hf_alpha",
  "if_sara", "im_nicola",
  "jf_alpha", "jm_kumo",
  "pf_dora", "pm_alex",
  "zf_xiaobei", "zm_yunjian",
];

/**
 * Kokoro's default when a request names no voice at all.
 *
 * Not invented: a request with the `voice` field omitted returns audio rather
 * than an error, and this is the voice it uses. Named explicitly so the picker
 * opens on the voice you would get anyway.
 */
export const DEFAULT_VOICE = "af_heart";

const LANGUAGES: Record<string, string> = {
  a: "American English",
  b: "British English",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Brazilian Portuguese",
  z: "Mandarin Chinese",
};

/** `af_heart` → Heart, American English, female. */
export function describeVoice(id: string): Voice {
  const match = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!match) {
    /* A voice someone typed in for a model Karen does not know. Shown as it
       was written rather than dropped: the field accepts free text precisely
       so an unknown engine's voices can be used. */
    return { id, name: id, language: "", gender: "female" };
  }
  const [, lang = "", sex = "f", rest = ""] = match;
  return {
    id,
    name: rest.charAt(0).toUpperCase() + rest.slice(1).replace(/_/g, " "),
    language: LANGUAGES[lang] ?? "",
    gender: sex === "m" ? "male" : "female",
  };
}

/**
 * The voices to offer for a model, or none when they are not knowable.
 *
 * An empty list is not a failure and the UI must not treat it as one: it means
 * "this engine's voices are not something Karen can enumerate", and the right
 * control for that is a text box, not an empty dropdown that cannot be used.
 * Every TTS engine besides Kokoro is in that position today -- OpenMOSS clones
 * a voice from a reference clip rather than choosing from a set, and a hosted
 * provider's voices are the provider's business.
 */
export function voicesFor(model: string): Voice[] {
  return isKokoro(model) ? KOKORO_VOICE_IDS.map(describeVoice) : [];
}

/**
 * Matched on the name rather than on the recipe.
 *
 * The recipe is the honest field and it is not always to hand: the chat bar's
 * picker has model ids and nothing else, and a round trip to the daemon to
 * colour in a dropdown would make the menu wait on the network. Every Kokoro
 * build published through Lemonade carries `kokoro` in its id, and a false
 * negative costs a text box instead of a dropdown.
 */
export function isKokoro(model: string): boolean {
  return /kokoro/i.test(model);
}

/** Whether a voice can be sent to this model without a 500 coming back. */
export function voiceIsValid(model: string, voice: string): boolean {
  if (!voice.trim()) return true; // Omitted is legal; the engine picks.
  const known = voicesFor(model);
  return known.length === 0 || known.some((v) => v.id === voice);
}

/**
 * The voice to keep when a model is chosen, which is not always the one stored.
 *
 * A voice belongs to an engine. Pick Kokoro, choose `af_heart`, then switch the
 * voice model to a hosted one, and that name stays in the settings and goes out
 * with every request — to a provider that has never heard of it. Kokoro's own
 * failure for an unknown voice is a bare HTTP 500, so what the user gets is a
 * feature that worked yesterday and now errors on every answer, with the cause
 * two panes away and no indication that the two are related.
 *
 * Two directions, both conservative, and both ending in a voice the engine can
 * actually speak in:
 *
 *   - Kokoro with a voice it does not have goes back to Kokoro's default.
 *   - Anything else carrying a Kokoro voice id is cleared, because those names
 *     come from one engine and mean nothing to another. Empty is legal
 *     everywhere: `speak` omits the field and the engine picks its own.
 *
 * A voice typed in for an engine Karen cannot enumerate is left exactly as it
 * was — that free text is the whole point of the box it was typed into.
 */
export function voiceForModel(model: string, voice: string): string {
  const wanted = voice.trim();
  if (!wanted) return "";
  if (isKokoro(model)) return voiceIsValid(model, wanted) ? wanted : DEFAULT_VOICE;
  return KOKORO_VOICE_IDS.includes(wanted) ? "" : wanted;
}
