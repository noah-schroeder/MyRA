/**
 * Tuning how one model loads.
 *
 * The settings are per model and live in the daemon, so this is a view onto
 * something Lemonade owns rather than a MyRA preference screen. Three things
 * follow from that and shape what is on screen:
 *
 *   - **The fields are whatever this model's recipe accepts**, read from the
 *     daemon rather than listed here. A chat model gets a context size; a
 *     transcription model does not have one, and offering it would produce a
 *     400 rather than a setting.
 *   - **A default and an override look different**, because they behave
 *     differently: an override sticks when the daemon's own default changes.
 *     Every changed field says so and can be put back on its own.
 *   - **Nothing here takes effect until the model is reloaded**, so the panel
 *     says that plainly and offers to do it, rather than leaving someone to
 *     wonder why a number they just typed changed nothing.
 *
 * The context size is the one people come here for. `auto` is the daemon's
 * default and resolves to something specific -- 4,096 on this machine for a
 * model whose ceiling is 131,072 -- so the resolved figure is shown next to
 * the word "auto", which is otherwise an answer that tells you nothing.
 *
 * It is also the whole per-model settings panel now, reached from the cog beside
 * a model in the menu as well as from the Models page, and `sections` is how one
 * panel serves both kinds of model. A hosted model has no load settings at all
 * -- Lemonade is not launching anything -- but it has samplers and a persona,
 * and until this it had no route to either.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CONTEXT_LADDER, knownMachine, memoryBudget, type AutoContext, type Machine, type ModelShape,
} from "../../core/runtime/fit.ts";
import { SamplingEditor } from "./SamplingEditor.tsx";
import { MemoryBar } from "./MemoryBar.tsx";
import { displayModelName } from "../../core/runtime/foreign.ts";
import {
  effectiveValue,
  fieldsFor,
  isOverridden,
  patchFrom,
  readContextSize,
  type ModelOptions,
  type OptionField,
} from "../../core/runtime/modelOptions.ts";
import { formatTokens } from "../../core/tokens.ts";
import {
  LLAMA_FLAGS, readFlags, validFlag, writeFlags, type FlagSpec,
} from "../../core/runtime/llamaArgs.ts";

/**
 * Form state is all strings, including the toggles, and that is deliberate.
 *
 * A checkbox has two states and these options have three: on, off, and never
 * set. The daemon reports "never set" as `null`, and rendering that as an
 * unticked box then saving it writes an explicit `false` -- which is a
 * different thing, and sticks. Measured the hard way: editing only the context
 * size wrote three overrides, because two untouched nulls came back as false.
 *
 * So `""` means untouched and is sent as `null`, which `patchFrom` then sees as
 * unchanged and omits.
 */
type Draft = Record<string, string>;

export type Section = "load" | "sampling" | "prompt";
const ALL_SECTIONS: readonly Section[] = ["load", "sampling", "prompt"];

function toDraft(options: ModelOptions, fields: OptionField[]): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const value = effectiveValue(options, field.key);
    if (value === null || value === undefined) {
      draft[field.key] = "";
      continue;
    }
    /* `-1` is how the daemon spells "work it out at load time", and printing
       it into the box undoes the work the hint underneath does to explain
       what auto means. "auto" reads back as -1 through `readContextSize`, so
       nothing is lost on the way out. */
    if (field.kind === "context" && value === -1) {
      draft[field.key] = "auto";
      continue;
    }
    draft[field.key] = field.kind === "toggle" ? (value === true ? "true" : "false") : String(value);
  }
  return draft;
}

export function ModelOptionsEditor({
  model,
  machine,
  loaded,
  sections = ALL_SECTIONS,
  onReload,
  onClose,
}: {
  /** The id the daemon knows, which is what the options are keyed by. */
  model: string;
  machine: Machine;
  /** Whether this model is the one currently loaded, so a reload is offered. */
  loaded: boolean;
  /**
   * Which halves to show.
   *
   * A local model gets all three. A hosted one gets everything except `load`:
   * asking the daemon for the load settings of a model it has never heard of
   * returns an error, and an empty "How it loads" box would be a worse answer
   * than not offering one.
   */
  sections?: readonly Section[];
  onReload: () => void | Promise<void>;
  onClose: () => void;
}) {
  const wantsLoad = sections.includes("load");
  const [options, setOptions] = useState<ModelOptions | undefined>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fields = useMemo(() => (options ? fieldsFor(options) : []), [options]);

  const load = useCallback(async (): Promise<void> => {
    if (!wantsLoad) return;
    const res = await window.myra.modelOptions(model);
    if (!res.ok || !res.options) {
      setError(res.error ?? "These settings could not be read.");
      return;
    }
    setOptions(res.options);
    setDraft(toDraft(res.options, fieldsFor(res.options)));
  }, [model, wantsLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  if (wantsLoad && error && !options) {
    return (
      <div className="mopt">
        <p className="run-error">{error}</p>
      </div>
    );
  }
  if (wantsLoad && !options) {
    return <div className="mopt"><p className="mopt-wait">Reading settings…</p></div>;
  }

  /* Typed text back into the daemon's types. Only the context field needs
     interpreting; the rest are numbers, booleans or free text. */
  const coerce = (field: OptionField, value: string): unknown | { error: string } => {
    const text = value.trim();
    // "" is "not set", which is not the same as off.
    if (field.kind === "toggle") return text === "" ? null : text === "true";
    if (field.kind === "context") {
      const read = readContextSize(text);
      return "error" in read ? read : read.value;
    }
    if (field.kind === "number" || field.kind === "seconds") {
      if (text === "") return null;
      const n = Number(text);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number.` };
      return n;
    }
    return text;
  };

  const save = async (): Promise<void> => {
    if (!options) return;
    const edited: Record<string, unknown> = {};
    for (const field of fields) {
      const value = coerce(field, draft[field.key] ?? "");
      if (value && typeof value === "object" && "error" in value) {
        setError((value as { error: string }).error);
        return;
      }
      edited[field.key] = value;
    }
    const patch = patchFrom(options, edited);
    if (!Object.keys(patch).length) {
      setNote("Nothing changed.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    const res = await window.myra.modelOptionsSet(model, patch);
    setBusy(false);
    if (!res.ok || !res.options) {
      // The daemon's own sentence, which is the one that matches what it refuses.
      setError(res.error ?? "Those settings were not accepted.");
      return;
    }
    setOptions(res.options);
    setDraft(toDraft(res.options, fieldsFor(res.options)));
    setNote(
      loaded
        ? "Saved. Reload the model for it to take effect."
        : "Saved. It will apply the next time this model loads.",
    );
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const res = await window.myra.modelOptionsReset(model);
    setBusy(false);
    if (!res.ok || !res.options) {
      setError(res.error ?? "Those settings could not be reset.");
      return;
    }
    setOptions(res.options);
    setDraft(toDraft(res.options, fieldsFor(res.options)));
    setNote("Back to the defaults.");
  };

  const overrides = options
    ? Object.keys(options.saved).filter((k) => k !== "model_name").length
    : 0;
  const shown = fields.filter((f) => showAdvanced || !f.advanced);

  return (
    <div className="mopt">
      <header className="mopt-head">
        <div>
          <h4>{displayModelName(model)}</h4>
          <p>
            {options?.recipe ? <>Run by {options.recipe}. </> : null}
            {wantsLoad
              ? overrides
                ? `${overrides} load setting${overrides === 1 ? "" : "s"} changed from the default.`
                : "Everything is at the default."
              : "A hosted model, so how it loads is not MyRA's to set."}
          </p>
        </div>
        <button type="button" className="lem-act" onClick={onClose}>
          Close
        </button>
      </header>

      {options ? (
        <>
          <h5 className="mopt-section">How it loads</h5>
          <div className="mopt-fields">
            {shown.map((field) => (
              <Field
                key={field.key}
                model={model}
                field={field}
                options={options}
                value={draft[field.key] ?? ""}
                machine={machine}
                onChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
                onOptionsChanged={load}
              />
            ))}
          </div>

          <button type="button" className="lem-more" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide the advanced settings" : "Show the advanced settings"}
          </button>
        </>
      ) : null}

      {/* The other half of tuning a model, and deliberately below the load
          settings: these take effect on the next message, while everything
          above costs a reload. */}
      {sections.includes("sampling") ? <SamplingEditor model={model} /> : null}

      {sections.includes("prompt") ? <PersonaField model={model} /> : null}

      {error ? <p className="run-error">{error}</p> : null}
      {note ? <p className="mopt-note">{note}</p> : null}

      {options ? (
        <div className="mopt-acts">
          <button type="button" className="lem-act get" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="lem-act" disabled={busy || !overrides} onClick={() => void reset()}>
            Reset to defaults
          </button>
          {/* Offered only when it would do something: reloading a model that is
              not loaded is a long operation with no visible result. */}
          {loaded ? (
            <button type="button" className="lem-act" disabled={busy} onClick={() => void onReload()}>
              Reload the model now
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What this model is told it is, before MyRA's rules.
 *
 * Saved on blur rather than on every keystroke, the way the sampler rows commit:
 * this is prose, and a write per character would be a settings file rewritten a
 * hundred times a sentence.
 *
 * The key is derived in the main process, not here. Three per-model records now
 * share it -- samplers, thinking effort, and this -- and a hosted choice is keyed
 * `provider::model` while a local one is keyed by the model that actually
 * answers. The window has been wrong about which is which before.
 */
function PersonaField({ model }: { model: string }) {
  const [text, setText] = useState("");
  const [fallback, setFallback] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.myra.modelPrompt(model).then((r) => {
      if (!alive) return;
      setText(r.text);
      setFallback(r.fallback);
    });
    return () => {
      alive = false;
    };
  }, [model]);

  const commit = (): void => {
    void window.myra.setModelPrompt(model, text.trim() || undefined).then(() => {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <div className="mopt-persona">
      <h5 className="mopt-section">Who it is</h5>
      <textarea
        rows={4}
        value={text}
        placeholder={fallback}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      <p className="sampling-note">
        Only for this model, and only the description of who it is. MyRA&rsquo;s own rules — how
        to hold a tool, that a citation marker may only be one a tool returned, and that untrusted
        text is data rather than instruction — follow it and cannot be replaced from here. Leave it
        empty to use the persona from Settings.
        {saved ? <strong> Saved.</strong> : null}
      </p>
    </div>
  );
}

function Field({
  model,
  field,
  options,
  value,
  machine,
  onChange,
  onOptionsChanged,
}: {
  model: string;
  field: OptionField;
  options: ModelOptions;
  value: string;
  machine: Machine;
  onChange: (v: string) => void;
  /** Re-read this model's options -- what "Recompute" needs after it writes. */
  onOptionsChanged: () => void;
}) {
  const overridden = isOverridden(options, field.key);
  const fallback = options.defaults[field.key];

  return (
    <div className={overridden ? "mopt-field changed" : "mopt-field"}>
      <div className="mopt-label">
        <span>{field.label}</span>
        {overridden ? <span className="lem-chip accent">changed</span> : null}
      </div>

      {field.kind === "toggle" ? (
        <label className="mopt-toggle">
          <input
            type="checkbox"
            checked={value === "true"}
            /* An untouched null reads as unticked, which is honest -- the
               label says it is unset rather than off, and it stays unset
               until someone actually touches it. */
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          <span>{value === "" ? "Not set — the daemon decides" : value === "true" ? "On" : "Off"}</span>
        </label>
      ) : field.key === "llamacpp_args" ? (
        /* The one option whose value is a whole command line. Everything people
           come to this panel for lives inside it, and the daemon accepts any
           nonsense in it with a 200 -- so the controls, and the checking, are
           here. */
        <FlagsField model={model} value={value} onChange={onChange} />
      ) : (
        <input
          type="text"
          className="mopt-input"
          value={value}
          spellCheck={false}
          placeholder={
            field.kind === "context"
              ? "auto"
              : fallback === null || fallback === undefined || fallback === ""
                ? "not set"
                : String(fallback)
          }
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {/* What "auto" actually means on this machine, and what the number costs.
          Auto-tune resolving a 128k model down to 4k is invisible otherwise. */}
      {field.kind === "context" ? (
        <ContextHint
          model={model}
          options={options}
          value={value}
          machine={machine}
          onChange={onChange}
          onOptionsChanged={onOptionsChanged}
        />
      ) : null}
      {/* A bare "300" in a box labelled "Unload after idle" is a number with
          no unit, and the two plausible readings -- five minutes or five
          hours -- are an hour apart. */}
      {field.kind === "seconds" ? <Seconds value={value} /> : null}
      {field.help ? <p className="mopt-help">{field.help}</p> : null}
    </div>
  );
}

/**
 * The llama.cpp flags, as controls, over the string that holds them.
 *
 * Every edit goes through `writeFlags`, which rewrites only the flags it owns
 * and leaves every other token exactly where it was -- including the daemon's
 * own `--parallel 1`, and including anything hand-tuned before this panel
 * existed. The resulting string is shown underneath rather than hidden, because
 * it is what actually reaches `llama-server` and somebody who knows these flags
 * should be able to check the panel's work.
 */
function FlagsField({
  model,
  value,
  onChange,
}: {
  model: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [raw, setRaw] = useState(false);
  /**
   * The GPU-layers and MoE-CPU sliders' real bound, and whether this model
   * routes between experts at all.
   *
   * Fetched independently rather than lifted from `SamplingEditor`, which asks
   * for the same record for a different reason -- the pattern `PersonaField`
   * above already uses. `layers` absent (an imported model, an offline
   * download, a fetch that failed) is not an error: the fields fall back to a
   * plain number box, same as every other integer flag without a measured
   * model.
   */
  const [shape, setShape] = useState<{ layers?: number; experts?: number }>({});

  useEffect(() => {
    let alive = true;
    void window.myra.modelFacts(model).then((r) => {
      if (!alive) return;
      setShape({ ...(r.layers ? { layers: r.layers } : {}), ...(r.experts ? { experts: r.experts } : {}) });
    });
    return () => {
      alive = false;
    };
  }, [model]);

  const { values, unknown } = readFlags(value);

  const set = (spec: FlagSpec, next: string): void => {
    const problem = validFlag(spec, next);
    setError(problem);
    if (problem) return;
    onChange(writeFlags(value, { ...values, [spec.flag]: next }));
  };

  const shown = LLAMA_FLAGS.filter((f) => {
    /* Offloading MoE experts to the CPU does nothing on a model that has none
       -- a control that does nothing is worse than an absent one. */
    if (f.flag === "--n-cpu-moe" && !shape.experts) return false;
    return showAll || !f.advanced || values[f.flag] !== undefined;
  });

  return (
    <div className="mopt-flags">
      {shown.map((spec) => (
        <div key={spec.flag} className="mopt-flag">
          <span className="mopt-flag-label">
            {spec.label}
            <code>{spec.flag}</code>
          </span>

          {spec.sliderMax === "layers" && shape.layers ? (
            <LayerSlider
              layers={shape.layers}
              value={values[spec.flag] ?? ""}
              /* Where the slider starts the moment "Auto" is unchecked: all of
                 them on the GPU for -ngl, none offloaded to the CPU for
                 -ncmoe -- both read as "nothing has changed yet" from where
                 llama.cpp's own default already sits. */
              startAt={spec.flag === "--n-gpu-layers" ? shape.layers : 0}
              onChange={(v) => set(spec, v)}
            />
          ) : spec.kind === "toggle" ? (
            <input
              type="checkbox"
              checked={values[spec.flag] === "true"}
              onChange={(e) => set(spec, e.target.checked ? "true" : "")}
            />
          ) : spec.kind === "enum" ? (
            <select
              className="mopt-input"
              value={values[spec.flag] ?? ""}
              onChange={(e) => set(spec, e.target.value)}
            >
              <option value="">not set</option>
              {spec.values?.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              /* Keyed by its own parsed value, not just the flag: this box is
                 uncontrolled so typing feels normal, but that means React never
                 refreshes it from a value edited elsewhere -- e.g. through "Show
                 what is sent" below. Without the key, blurring this box after
                 such an edit would resubmit the value it was last drawn with and
                 silently undo the other edit. */
              key={`${spec.flag}:${values[spec.flag] ?? ""}`}
              type="text"
              className="mopt-input"
              inputMode={spec.kind === "text" ? "text" : "numeric"}
              defaultValue={values[spec.flag] ?? ""}
              spellCheck={false}
              placeholder="not set"
              onBlur={(e) => set(spec, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") set(spec, (e.target as HTMLInputElement).value);
              }}
            />
          )}

          <p className="mopt-help">
            {spec.help}
            {spec.warn ? <strong className="mopt-flag-warn"> {spec.warn}</strong> : null}
          </p>
        </div>
      ))}

      {error ? <p className="mopt-hint bad">{error}</p> : null}

      <div className="mopt-flag-acts">
        <button type="button" className="lem-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Fewer flags" : "Every flag MyRA knows"}
        </button>
        <button type="button" className="lem-more" onClick={() => setRaw((v) => !v)}>
          {raw ? "Hide what is sent" : "Show what is sent"}
        </button>
      </div>

      {raw ? (
        <input
          type="text"
          className="mopt-input"
          value={value}
          spellCheck={false}
          placeholder="not set"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}

      {/* Said, not silently preserved: somebody who typed a flag MyRA has never
          heard of should know it is still there and still being sent. */}
      {unknown.length ? (
        <p className="mopt-hint">
          MyRA does not know {unknown.filter((t) => t.startsWith("-")).join(", ") || "some of these"},
          so {unknown.length === 1 ? "it is" : "they are"} passed through unchanged. The daemon
          accepts anything here and only fails later, at load.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A GPU-layers or MoE-CPU-layers control, bounded by the model's own layer
 * count rather than the made-up 999 the plain number box used to allow.
 *
 * Blank (`value === ""`) is "Auto" -- the flag stays unset, and llama.cpp's own
 * `--fit` (default on) is what actually places layers, redoing it every time
 * the context changes. Unchecking "Auto" writes an explicit number and hands
 * that one setting to the user from then on; it does not turn `--fit` off,
 * which keeps adjusting whatever is still unset.
 */
function LayerSlider({
  layers,
  value,
  startAt,
  onChange,
}: {
  layers: number;
  value: string;
  startAt: number;
  onChange: (v: string) => void;
}) {
  const auto = value.trim() === "";
  const current = auto ? startAt : Math.min(layers, Math.max(0, Math.round(Number(value)) || 0));

  return (
    <div className="mopt-slider">
      <label className="mopt-slider-auto">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => onChange(e.target.checked ? "" : String(current))}
        />
        <span>Auto — llama.cpp decides</span>
      </label>
      <div className="mopt-slider-row">
        <input
          type="range"
          min={0}
          max={layers}
          step={1}
          value={current}
          disabled={auto}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="mopt-slider-value">{auto ? "Auto" : `${current} of ${layers}`}</span>
      </div>
    </div>
  );
}

/** The same number in the units a person thinks in. */
function Seconds({ value }: { value: string }) {
  const n = Number(value.trim());
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return null;
  const words =
    n < 90
      ? `${n} seconds`
      : n < 5400
        ? `${round(n / 60)} minutes`
        : `${round(n / 3600)} hours`;
  return <p className="mopt-hint">Seconds — {words}.</p>;
}

const round = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * What a context size costs, and a way to pick one that stays on the card.
 *
 * The refusal to invent a number used to be unconditional: the daemon does
 * not report a model's layer and KV-head counts, so a figure here would not
 * move with the setting it is describing, and a cost estimate that does not
 * move is worse than none. That premise died the day MyRA started reading a
 * model's own GGUF header (`core/runtime/gguf.ts`) -- once a real shape is on
 * hand, `memoryBudget` computes an exact figure for whatever is in the box,
 * and it is the same arithmetic a load is sized by. The refusal survives for
 * exactly the case it was written for: no shape yet, where the only cache
 * figure available is a flat fraction of the file size and would print the
 * same number at 4k and at 128k.
 */
function ContextHint({
  model,
  options,
  value,
  machine,
  onChange,
  onOptionsChanged,
}: {
  model: string;
  options: ModelOptions;
  value: string;
  machine: Machine;
  onChange: (v: string) => void;
  onOptionsChanged: () => void;
}) {
  const [facts, setFacts] = useState<{
    shape?: ModelShape;
    sizeBytes?: number;
    autoCtxSize?: number;
    allowOffload?: boolean;
  }>({});
  const [proposal, setProposal] = useState<AutoContext | undefined>();
  const [applying, setApplying] = useState(false);
  /* `facts` starts `{}` on every model change, which reads exactly like "no
     autoCtxSize on record" until the fetch below actually answers -- the
     recompute effect needs to tell those two apart, or it probes a model MyRA
     sized itself the instant it is opened. */
  const [factsLoaded, setFactsLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setFactsLoaded(false);
    void window.myra.modelFacts(model).then((r) => {
      if (!alive) return;
      setFacts({
        ...(r.shape ? { shape: r.shape } : {}),
        ...(r.sizeBytes ? { sizeBytes: r.sizeBytes } : {}),
        ...(r.autoCtxSize !== undefined ? { autoCtxSize: r.autoCtxSize } : {}),
        ...(r.allowOffload ? { allowOffload: true } : {}),
      });
      setFactsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [model]);

  /* The "Recompute" offer, checked once per model: a saved value that is
     overridden but that MyRA never recorded writing is the state a model is
     left in forever once a shape arrives after the fact -- `#autoTuneLoad`
     will never touch it on its own, by design (`ctxIsOurs`). Only worth
     asking the daemon about in that exact case, not on every render. */
  const savedCtx = options.saved["ctx_size"];
  const savedIsRealNumber = typeof savedCtx === "number" && savedCtx > 0;
  useEffect(() => {
    let alive = true;
    /* Gated on the fetch above having actually answered, not merely on
       `facts.autoCtxSize` being undefined -- `facts` resets to `{}` on every
       model change, which is indistinguishable from "MyRA measured this and
       recorded nothing" until the real answer arrives. Without this gate, a
       model MyRA sized itself got probed the moment its panel opened: the
       probe writes `modelFacts.json` (see `recomputeContext`'s own doc
       comment), and the "MyRA now measures this model" line briefly appeared
       and then vanished again the instant the real facts landed and this
       effect re-ran with the true `autoCtxSize` in hand.

       Deliberately NOT keyed on the whole `facts` object: `toggleAllowOffload`
       replaces it wholesale on every flip of the offload checkbox, which would
       re-fire this probe for a reason that has nothing to do with it. */
    if (factsLoaded && savedIsRealNumber && facts.autoCtxSize === undefined) {
      /* Only for a saved, positive number -- a saved "auto" (-1) is a
         deliberate choice to hand this back to the daemon, not the
         stuck-at-the-floor case this offer exists for, and there is no sane
         way to print "-1 tokens". */
      void window.myra.modelContextPreview(model).then((r) => {
        if (alive && r.ok) setProposal(r.auto);
      });
    } else {
      setProposal(undefined);
    }
    return () => {
      alive = false;
    };
  }, [model, factsLoaded, savedIsRealNumber, savedCtx, facts.autoCtxSize]);

  const applyRecompute = async (): Promise<void> => {
    setApplying(true);
    const res = await window.myra.modelContextApply(model);
    setApplying(false);
    if (res.ok) {
      setProposal(undefined);
      onOptionsChanged();
    }
  };

  const toggleAllowOffload = async (allow: boolean): Promise<void> => {
    setFacts((f) => ({ ...f, allowOffload: allow }));
    await window.myra.setAllowOffload(model, allow);
    onOptionsChanged();
  };

  const read = readContextSize(value);
  const recompute =
    proposal?.tokens && savedIsRealNumber && proposal.tokens !== savedCtx ? (
      <p className="mopt-hint">
        MyRA now measures this model: {formatTokens(Number(savedCtx))} {"→"} <strong>{formatTokens(proposal.tokens)}</strong>.{" "}
        <button type="button" className="cfg-reveal" disabled={applying} onClick={() => void applyRecompute()}>
          {applying ? "Recomputing…" : "Recompute"}
        </button>
      </p>
    ) : null;

  if ("error" in read) return <p className="mopt-hint bad">{read.error}</p>;

  // In "Auto" the box has no number of its own -- the bar is drawn against
  // what the daemon last resolved it to, so it still means something on
  // screen rather than sitting blank until the next load.
  const context = read.value === -1 ? options.resolvedCtxSize : read.value;
  /* Also gated on the machine actually being known: without it, every rung
     button below renders disabled -- "does not fit" -- against a budget of
     zero, for a machine `lemonadeInfo()` simply has not answered about yet. */
  const bar =
    facts.shape && facts.sizeBytes && context && knownMachine(machine) ? (
      <ContextBudget
        sizeBytes={facts.sizeBytes}
        shape={facts.shape}
        machine={machine}
        context={context}
        allowOffload={facts.allowOffload ?? false}
        ceiling={facts.shape.contextLength}
        onPick={onChange}
        onAllowOffloadChange={(v) => void toggleAllowOffload(v)}
      />
    ) : null;

  if (read.value === -1) {
    return (
      <>
        <p className="mopt-hint">
          Auto — Lemonade works out a size when the model loads
          {options.resolvedCtxSize ? (
            <>
              , currently <strong>{formatTokens(options.resolvedCtxSize)}</strong> (
              {options.resolvedCtxSize.toLocaleString("en-GB")} tokens)
            </>
          ) : null}
          .
        </p>
        {bar}
        {recompute}
      </>
    );
  }

  if (!facts.shape || !facts.sizeBytes) {
    /* No measurement yet, not "never possible" -- a model MyRA has not shaped
       (an import, or one still being downloaded) genuinely has no honest
       figure to show. Memory reserved at load time still grows roughly in
       proportion to this, in whichever pool ends up holding it. */
    const ceiling = machine.vramBytes ? "graphics memory" : "system memory";
    return (
      <p className="mopt-hint">
        <strong>{formatTokens(read.value)}</strong> ({read.value.toLocaleString("en-GB")} tokens).
        MyRA has not measured this model yet, so memory reserved at load time can only be said to
        grow roughly in proportion to this, in {ceiling}. If a size is too large the model fails to
        load and Lemonade says so — nothing is damaged by trying.
      </p>
    );
  }

  return (
    <>
      <p className="mopt-hint">
        <strong>{formatTokens(read.value)}</strong> ({read.value.toLocaleString("en-GB")} tokens).
      </p>
      {bar}
      {recompute}
    </>
  );
}

/**
 * The bar, the rungs, and the one control that changes what the bar is drawn
 * against: whether this model is allowed to spill off the card for a longer
 * window. Split out of `ContextHint` because it needs its own memo over the
 * budget arithmetic, and `ContextHint` already has enough state of its own.
 */
function ContextBudget({
  sizeBytes,
  shape,
  machine,
  context,
  allowOffload,
  ceiling,
  onPick,
  onAllowOffloadChange,
}: {
  sizeBytes: number;
  shape: ModelShape;
  machine: Machine;
  context: number;
  allowOffload: boolean;
  /** The model's own trained length, when this is a typed value rather than Auto. */
  ceiling: number | undefined;
  onPick: (value: string) => void;
  onAllowOffloadChange: (v: boolean) => void;
}) {
  const budget = useMemo(
    () => memoryBudget(sizeBytes, machine, { shape, context, allowOffload }),
    [sizeBytes, machine, shape, context, allowOffload],
  );

  const rungs = useMemo(
    () => CONTEXT_LADDER.filter((c) => (ceiling ? c <= ceiling : true)),
    [ceiling],
  );

  /* Not "your graphics card" while offload is allowed: `memoryBudget` widens
     `budgetBytes` to VRAM+RAM the moment `allowOffload` is set, so the figure
     the bar is drawn against is no longer the card alone, and saying so would
     name the wrong ceiling. */
  const against = machine.vramBytes && !allowOffload ? "your graphics card" : "this machine";

  return (
    <div className="cfg-context">
      <MemoryBar budget={budget} against={against} />
      {rungs.length ? (
        <div className="seg" role="group" aria-label="Context size">
          {rungs.map((c) => {
            const fits = memoryBudget(sizeBytes, machine, { shape, context: c, allowOffload }).headroomBytes >= 0;
            return (
              <button
                key={c}
                type="button"
                className={c === context ? "active" : ""}
                disabled={!fits}
                title={fits ? `${formatTokens(c)} tokens` : `${formatTokens(c)} tokens — does not fit`}
                onClick={() => onPick(String(c))}
              >
                {formatTokens(c)}
              </button>
            );
          })}
        </div>
      ) : null}
      {machine.vramBytes ? (
        <label className="check">
          <input
            type="checkbox"
            checked={allowOffload}
            onChange={(e) => onAllowOffloadChange(e.target.checked)}
          />
          <span>Allow this model to spill off the graphics card for a longer window</span>
        </label>
      ) : null}
    </div>
  );
}
