/**
 * The llama.cpp flags worth setting, over the one string that holds them.
 *
 * `modelOptions.ts` is a view onto the daemon's own option keys and stays that
 * way -- a key Karen has never seen still renders. But the flags people actually
 * come here for are not option keys at all: Lemonade passes a single free-text
 * `llamacpp_args` string to `llama-server`, and everything from `-ngl` to
 * `--cache-type-k` lives inside it, unvalidated. Measured against lemond 11.8.0:
 * `llamacpp_args: "--parallel 1 --karen-nonsense 3"` is accepted with a 200 and
 * only fails later, at load, from inside a process the user is not watching. So
 * the checking is ours to do or it does not happen.
 *
 * **Every token this does not own is preserved exactly where it was.** The
 * daemon's own default is `--parallel 1`, and a panel that silently dropped a
 * flag it did not recognise would be data loss wearing a form. That is the
 * property to keep, and the one the test pins hardest.
 *
 * On the rule in registry.ts about never splicing a chosen string into a command
 * line: that rule is about **model**-chosen strings, and these are the user's
 * own -- typed into a settings panel that already passed them through verbatim.
 * A structured editor narrows what can reach the command line rather than
 * widening it. It is still enforced below: a value carrying whitespace, a quote,
 * a semicolon, a backtick or a `$` is refused unless its field is free text, and
 * no code path brings a model-produced string here. There must never be one.
 */

export interface FlagSpec {
  /** The canonical spelling, which is what gets written. */
  flag: string;
  /** A shorter spelling that means the same thing, read but never written. */
  alias?: string;
  label: string;
  kind: "toggle" | "enum" | "integer" | "number" | "text";
  values?: readonly string[];
  min?: number;
  max?: number;
  /**
   * This field's real ceiling comes from the model, not from `max` above.
   *
   * `"layers"` is the only value today: the number of transformer layers, once
   * Karen has learned it. Kept out of `max` because that field is a static
   * fact about the flag and this one is a fact about whichever model is
   * currently open -- `llamaArgs.ts` stays free of any dependency on where a
   * layer count comes from, and the renderer decides what to show when it does
   * not have one.
   */
  sliderMax?: "layers";
  help: string;
  advanced: boolean;
  /** Shown in red: this one interacts with something else Karen relies on. */
  warn?: string;
}

export const LLAMA_FLAGS: readonly FlagSpec[] = [
  {
    flag: "--n-gpu-layers",
    alias: "-ngl",
    label: "Layers on the GPU",
    kind: "integer",
    min: 0,
    max: 999,
    sliderMax: "layers",
    help:
      "How many of the model's layers the graphics card holds. Fewer means slower but smaller. " +
      "Left unset, llama.cpp places them itself and keeps redoing so whenever the context changes.",
    advanced: false,
  },
  {
    /* llama.cpp's own granularity is layers, not individual experts -- "keep
       the MoE weights of the first N layers in the CPU" -- so the label says
       layers rather than promising a per-expert dial the flag does not have. */
    flag: "--n-cpu-moe",
    alias: "-ncmoe",
    label: "MoE layers kept on the CPU",
    kind: "integer",
    min: 0,
    max: 999,
    sliderMax: "layers",
    help:
      "Keeps this many layers' worth of mixture-of-experts weights off the graphics card, to free " +
      "VRAM. Only does anything on a MoE model. Left unset, llama.cpp decides this together with " +
      "the GPU layers above whenever the context changes.",
    advanced: false,
  },
  {
    flag: "--fit",
    label: "Fit unset settings to memory",
    kind: "enum",
    values: ["on", "off"],
    help:
      "llama.cpp's own default: adjusts the GPU layers and MoE-CPU settings above, whenever they " +
      "are left unset, to fit this machine every time the context changes.",
    advanced: true,
    warn:
      "Turning this off is what stops the GPU-layers and MoE sliders above from re-fitting " +
      "themselves when you change the context.",
  },
  {
    /* Not a toggle: measured against the bundled binary, `--flash-attn` takes a
       required value now -- `llama-server --flash-attn` alone refuses to start
       ("expected value for argument"). Writing the bare flag was exactly what
       the old toggle-kind spec did the moment anyone turned it on. */
    flag: "--flash-attn",
    label: "Flash attention",
    kind: "enum",
    values: ["auto", "on", "off"],
    help:
      "Faster attention where the backend supports it, and a smaller peak memory spike. " +
      "Karen turns this on by itself on a CUDA card; \"auto\" is the daemon's own default elsewhere.",
    advanced: false,
  },
  {
    flag: "--cache-type-k",
    label: "Key cache type",
    kind: "enum",
    values: ["f16", "q8_0", "q4_0"],
    help: "Quantising the KV cache roughly halves what a long context costs, for a little quality.",
    advanced: false,
    warn: "Karen sizes the context window from this. Change it and the suggested window changes too.",
  },
  {
    flag: "--cache-type-v",
    label: "Value cache type",
    kind: "enum",
    values: ["f16", "q8_0", "q4_0"],
    help: "As above, for the value half of the cache. Usually set to match.",
    advanced: false,
  },
  {
    flag: "--threads",
    alias: "-t",
    label: "Threads",
    kind: "integer",
    min: 1,
    max: 512,
    help: "Processor threads for the layers that are not on the card.",
    advanced: false,
  },
  {
    flag: "--parallel",
    alias: "-np",
    label: "Parallel slots",
    kind: "integer",
    min: 1,
    max: 64,
    help: "How many requests the server handles at once.",
    advanced: true,
    warn:
      "llama-server divides the context window between slots, so 2 halves every " +
      "conversation's window. Karen reads the per-slot figure, so the context meter follows it down.",
  },
  {
    flag: "--batch-size",
    alias: "-b",
    label: "Batch size",
    kind: "integer",
    min: 1,
    max: 1_048_576,
    help: "Tokens per evaluation batch while reading a prompt.",
    advanced: true,
  },
  {
    flag: "--ubatch-size",
    alias: "-ub",
    label: "Micro-batch size",
    kind: "integer",
    min: 1,
    max: 1_048_576,
    help: "The physical batch the backend actually runs. Lower it if a long prompt runs out of memory.",
    advanced: true,
  },
  {
    flag: "--mlock",
    label: "Lock in memory",
    kind: "toggle",
    help: "Keeps the weights resident rather than letting the system page them out.",
    advanced: true,
  },
  {
    flag: "--no-mmap",
    label: "Do not memory-map",
    kind: "toggle",
    help: "Reads the whole file up front. Slower to start, and sometimes steadier on network storage.",
    advanced: true,
  },
  {
    flag: "--no-kv-offload",
    label: "Keep the cache off the GPU",
    kind: "toggle",
    help: "Puts the KV cache in system memory, which frees graphics memory for layers.",
    advanced: true,
  },
  {
    flag: "--split-mode",
    alias: "-sm",
    label: "Split across GPUs",
    kind: "enum",
    values: ["none", "layer", "row"],
    help: "How to divide a model over more than one card.",
    advanced: true,
  },
  {
    flag: "--tensor-split",
    alias: "-ts",
    label: "Split proportions",
    kind: "text",
    help: "How much goes to each card, e.g. 3,1 for a 24 GB card beside an 8 GB one.",
    advanced: true,
  },
  {
    flag: "--main-gpu",
    alias: "-mg",
    label: "Main GPU",
    kind: "integer",
    min: 0,
    max: 64,
    help: "Which card holds the small tensors that are not split.",
    advanced: true,
  },
  {
    flag: "--rope-scaling",
    label: "RoPE scaling",
    kind: "enum",
    values: ["none", "linear", "yarn"],
    help: "Stretches a model past the context length it was trained for, at some cost to quality.",
    advanced: true,
  },
  {
    flag: "--rope-freq-base",
    label: "RoPE base frequency",
    kind: "number",
    min: 0,
    max: 10_000_000,
    help: "The base the positions are encoded against. Only with a scaling mode set.",
    advanced: true,
  },
  {
    flag: "--yarn-orig-ctx",
    label: "YaRN original context",
    kind: "integer",
    min: 0,
    max: 10_485_760,
    help: "The context the model was actually trained for, for YaRN to scale from.",
    advanced: true,
  },
];

const BY_FLAG = new Map<string, FlagSpec>();
for (const spec of LLAMA_FLAGS) {
  BY_FLAG.set(spec.flag, spec);
  if (spec.alias) BY_FLAG.set(spec.alias, spec);
}

/** Anything that could end one argument and begin another. */
const UNSAFE = /[\s"'`;$&|<>\\]/;

/**
 * Split on whitespace, keeping quoted runs together.
 *
 * Not a shell: no expansion, no substitution, no escapes beyond the quotes
 * themselves. `--tensor-split "3, 1"` has to survive a round trip, and that is
 * the whole reason quotes are understood at all.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

function quoteIfNeeded(value: string): string {
  return UNSAFE.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

export interface ReadFlags {
  /** Canonical flag -> its value; a toggle's value is `"true"`. */
  values: Record<string, string>;
  /** Every token this module does not own, in the order it found them. */
  unknown: string[];
}

/**
 * Pull the known flags out of an argument string.
 *
 * An alias is read and reported under the canonical spelling, so the editor has
 * one box per setting however the string happened to spell it.
 */
export function readFlags(text: string): ReadFlags {
  const tokens = tokenize(text);
  const values: Record<string, string> = {};
  const unknown: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const spec = BY_FLAG.get(token);
    if (!spec) {
      unknown.push(token);
      continue;
    }
    if (spec.kind === "toggle") {
      values[spec.flag] = "true";
      continue;
    }
    const next = tokens[i + 1];
    /* A flag whose value is missing, or is plainly the next flag: kept as an
       unknown token rather than swallowing the flag after it. */
    if (next === undefined || next.startsWith("-")) {
      unknown.push(token);
      continue;
    }
    values[spec.flag] = next;
    i += 1;
  }
  return { values, unknown };
}

/** Whether a value is one this field could hold. */
export function validFlag(spec: FlagSpec, value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (spec.kind !== "text" && UNSAFE.test(text)) {
    return `${spec.label} cannot contain spaces or quotes.`;
  }
  if (spec.kind === "enum") {
    return spec.values?.includes(text) ? undefined : `${spec.label} must be one of ${spec.values?.join(", ")}.`;
  }
  if (spec.kind === "integer" || spec.kind === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return `${spec.label} must be a number.`;
    if (spec.kind === "integer" && !Number.isInteger(n)) return `${spec.label} must be a whole number.`;
    if (spec.min !== undefined && n < spec.min) return `${spec.label} must be at least ${spec.min}.`;
    if (spec.max !== undefined && n > spec.max) return `${spec.label} must be at most ${spec.max}.`;
  }
  return undefined;
}

/**
 * Write the known flags back into the string, leaving everything else alone.
 *
 * Rebuilt from the original tokens rather than from scratch: a flag that was
 * already there is replaced where it stood, one that has been cleared is removed
 * with its value, and a newly set one goes on the end. Anything unrecognised
 * keeps its position, which is what makes this safe to run over a string
 * somebody hand-tuned before this panel existed.
 */
export function writeFlags(text: string, values: Record<string, string>): string {
  const tokens = tokenize(text);
  const out: string[] = [];
  const written = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const spec = BY_FLAG.get(token);
    if (!spec) {
      out.push(token);
      continue;
    }
    /* Step over the old value now, whatever happens to the flag: leaving it
       behind would turn `--threads 8` into a bare `8`. */
    const hadValue = spec.kind !== "toggle" && tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith("-");
    if (hadValue) i += 1;

    const wanted = values[spec.flag]?.trim();
    if (written.has(spec.flag) || !wanted) continue;
    written.add(spec.flag);
    /* Written under the canonical spelling, so the string settles into one form
       instead of keeping whichever alias it was typed with. */
    if (spec.kind === "toggle") out.push(spec.flag);
    else out.push(spec.flag, quoteIfNeeded(wanted));
  }

  for (const [flag, value] of Object.entries(values)) {
    const spec = BY_FLAG.get(flag);
    const wanted = value.trim();
    if (!spec || written.has(flag) || !wanted) continue;
    if (spec.kind === "toggle") out.push(spec.flag);
    else out.push(spec.flag, quoteIfNeeded(wanted));
  }

  return out.join(" ");
}

/**
 * What one element of the KV cache costs, given these arguments.
 *
 * The sizer needs it because quantising the cache is the one flag that changes
 * how long a window fits: `q8_0` halves it against `f16`, `q4_0` quarters it. So
 * a user who sets this and then asks Karen to size the context must be sized
 * against what they set, not against the default.
 *
 * The key half decides, because it is the half `kvCacheBytes` counts twice when
 * the value length is not given separately.
 */
export function kvBytesPerElement(args: string): number | undefined {
  const type = readFlags(args).values["--cache-type-k"];
  if (!type) return undefined;
  const sizes: Record<string, number> = { f16: 2, bf16: 2, f32: 4, q8_0: 1, q4_0: 0.5 };
  return sizes[type];
}
