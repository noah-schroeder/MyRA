/**
 * Per-model load settings: how each model is started, saved per model.
 *
 * Lemonade keeps these itself, in a `recipe_options.json` it owns, reachable at
 * `GET|POST|DELETE /api/v1/models/<id>/options`. MyRA does not invent a
 * parallel store: the daemon is what launches llama-server, so the settings
 * have to live where the launch reads them or they would be advice rather than
 * configuration.
 *
 * Two things about that API shape the whole design here.
 *
 * **The fields depend on the recipe.** `llamacpp` offers `ctx_size`,
 * `llamacpp_args`, `llamacpp_backend` and `llamacpp_device`; `whispercpp`
 * offers none of those and has `whispercpp_args` instead. Measured, not
 * assumed -- and a POST of a key the recipe does not know is rejected with
 * `Unknown option 'x' for recipe 'llamacpp'`. So the editor is built from the
 * `defaults` object the daemon returns for that model, and a field MyRA has
 * never heard of still renders rather than being silently dropped.
 *
 * **Default, saved and effective are three different things.** `defaults` is
 * what the daemon would do, `saved` is only what you overrode, and `effective`
 * is the merge. Keeping them apart is what makes "reset this one field" and
 * "show me what I changed" possible, and it is why the editor sends a patch of
 * changes rather than the whole object.
 *
 * `ctx_size: -1` means auto-tune, which is not a number a person can act on --
 * so `resolvedCtxSize` carries what the auto-tune actually resolves to, before
 * anything is loaded.
 */

export interface ModelOptions {
  modelName: string;
  /** `llamacpp`, `whispercpp`, … — decides which fields exist. */
  recipe?: string | undefined;
  /** What the daemon would use with nothing overridden. */
  defaults: Record<string, unknown>;
  /** Only the overrides, which is what "reset" removes. */
  saved: Record<string, unknown>;
  /** defaults + saved, which is what a load will actually use. */
  effective: Record<string, unknown>;
  /** What `ctx_size: -1` resolves to on this machine, before loading. */
  resolvedCtxSize?: number | undefined;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseModelOptions(raw: unknown, fallbackName = ""): ModelOptions {
  const body = obj(raw);
  const resolved = body["resolved_ctx_size"];
  return {
    modelName: typeof body["model_name"] === "string" ? body["model_name"] : fallbackName,
    ...(typeof body["recipe"] === "string" ? { recipe: body["recipe"] } : {}),
    defaults: obj(body["defaults"]),
    saved: obj(body["saved"]),
    effective: obj(body["effective"]),
    ...(typeof resolved === "number" && resolved > 0 ? { resolvedCtxSize: resolved } : {}),
  };
}

/* ----------------------------------------------------------------- fields -- */

export type FieldKind = "context" | "text" | "number" | "seconds" | "toggle";

export interface OptionField {
  key: string;
  label: string;
  kind: FieldKind;
  /** One line under the control, in the words of what it does. */
  help?: string;
  /** Advanced fields are behind a disclosure; the common ones are not. */
  advanced: boolean;
}

/**
 * What each option is called in the window, and whether it is everyday.
 *
 * Only the keys worth explaining are here. Anything else the daemon reports is
 * still editable -- `fieldsFor` falls back to the key name and the value's own
 * type -- because a version of Lemonade that adds an option should not need a
 * MyRA release before it can be set.
 */
const KNOWN: Record<string, Omit<OptionField, "key" | "advanced"> & { advanced?: boolean }> = {
  ctx_size: {
    label: "Context window",
    kind: "context",
    help: "How much of a conversation the model can hold at once. Bigger costs memory — the KV cache grows with it.",
  },
  llamacpp_backend: {
    label: "Backend",
    kind: "text",
    help: "Which build runs it: cuda, vulkan, rocm or cpu. Leave as the default unless you have a reason.",
  },
  whispercpp_backend: { label: "Backend", kind: "text", help: "Which build runs transcription." },
  llamacpp_device: {
    label: "Device",
    kind: "text",
    help: "Which card, when there is more than one. Blank lets the backend choose.",
    advanced: true,
  },
  llamacpp_args: {
    label: "Extra llama.cpp arguments",
    kind: "text",
    help: "Passed to llama-server verbatim, e.g. --flash-attn on. A bad flag here stops the model loading.",
    advanced: true,
  },
  whispercpp_args: {
    label: "Extra whisper.cpp arguments",
    kind: "text",
    help: "Passed to the transcription server verbatim.",
    advanced: true,
  },
  evict_idle_timeout: {
    label: "Unload after idle",
    kind: "seconds",
    help: "Free the memory when the model has not been used for this long.",
  },
  downsize_idle_timeout: {
    label: "Shrink after idle",
    kind: "seconds",
    help: "Reduce the model's footprint before unloading it outright.",
    advanced: true,
  },
  evict_weight_factor: {
    label: "Eviction weight",
    kind: "number",
    help: "How readily this model is unloaded when another needs room. Higher means sooner.",
    advanced: true,
  },
  auto_evict: { label: "Unload automatically", kind: "toggle", advanced: true },
  auto_update: {
    label: "Check for updates",
    kind: "toggle",
    help: "MyRA leaves this off: an update check is a network call you did not ask for.",
    advanced: true,
  },
  merge_args: {
    label: "Merge with default arguments",
    kind: "toggle",
    help: "Off replaces the daemon's own arguments rather than adding to them.",
    advanced: true,
  },
};

/** Reported by the daemon but not a setting: it names the model, it is not about it. */
const NOT_A_SETTING = new Set(["model_name", "recipe"]);

/**
 * The editable fields for one model, in the order they should be shown.
 *
 * Built from the daemon's `defaults` rather than from `KNOWN`, so the set is
 * whatever this recipe actually accepts. Unknown keys are kept and given a
 * readable label -- dropping them would hide a setting that exists.
 */
export function fieldsFor(options: ModelOptions): OptionField[] {
  const keys = new Set([...Object.keys(options.defaults), ...Object.keys(options.saved)]);
  const fields: OptionField[] = [];
  for (const key of keys) {
    if (NOT_A_SETTING.has(key)) continue;
    const known = KNOWN[key];
    if (known) {
      fields.push({ key, label: known.label, kind: known.kind, advanced: known.advanced ?? false, ...(known.help ? { help: known.help } : {}) });
      continue;
    }
    const value = options.defaults[key] ?? options.saved[key];
    fields.push({
      key,
      label: humanise(key),
      kind: typeof value === "boolean" ? "toggle" : typeof value === "number" ? "number" : "text",
      advanced: true,
    });
  }
  // Everyday settings first, then alphabetical inside each half, so the order
  // does not shuffle when the daemon changes its key order.
  /* `indexOf` returns -1 for a key with no pinned position, which would sort
     it above the pinned ones; unlisted means "no opinion", so it goes last. */
  const rank = (key: string): number => {
    const at = ORDER.indexOf(key);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return fields.sort(
    (a, b) =>
      Number(a.advanced) - Number(b.advanced) ||
      rank(a.key) - rank(b.key) ||
      a.label.localeCompare(b.label),
  );
}

/** The few whose relative order is worth pinning; everything else sorts by name. */
const ORDER = ["ctx_size", "llamacpp_backend", "whispercpp_backend", "evict_idle_timeout"];

function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------ edits -- */

/** Whether this key has been overridden, which is what a reset would undo. */
export function isOverridden(options: ModelOptions, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options.saved, key);
}

/** The value in force for a key: the override if there is one, else the default. */
export function effectiveValue(options: ModelOptions, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(options.effective, key)
    ? options.effective[key]
    : options.defaults[key];
}

/**
 * The patch to send: only what differs from what is already saved.
 *
 * A POST of every field would turn every default into an override, and the
 * difference matters -- an override sticks when the daemon's own default
 * changes, so silently pinning a dozen of them is a way to inherit stale
 * settings forever.
 */
export function patchFrom(
  options: ModelOptions,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edited)) {
    if (NOT_A_SETTING.has(key)) continue;
    const current = effectiveValue(options, key);
    if (!same(current, value)) patch[key] = value;
  }
  return patch;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // The daemon reports absent booleans as null; a form gives back undefined.
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

/**
 * Read a context size from what someone typed.
 *
 * Returns `-1` for auto, a positive integer, or an error in the daemon's own
 * terms -- it rejects the same values, and two different sentences for one
 * rule is how a UI ends up disagreeing with the thing it configures.
 */
export function readContextSize(input: string): { value: number } | { error: string } {
  const text = input.trim().toLowerCase();
  if (text === "" || text === "auto" || text === "-1") return { value: -1 };
  /* `k` is 1024 here, because that is what it means everywhere else on this
     screen -- `formatTokens` prints 16384 as "16k", so typing "16k" back has
     to give 16384 and not 16000. */
  const bare = text.replace(/[, _]/g, "");
  const isK = bare.endsWith("k");
  const n = Number(isK ? bare.slice(0, -1) : bare) * (isK ? 1024 : 1);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: "Context must be a whole number of tokens, or “auto”." };
  }
  return { value: n };
}
