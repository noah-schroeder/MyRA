/**
 * Tuning how one model loads.
 *
 * The settings are per model and live in the daemon, so this is a view onto
 * something Lemonade owns rather than a Karen preference screen. Three things
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
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Machine } from "../../core/runtime/fit.ts";
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
  onReload,
  onClose,
}: {
  /** The id the daemon knows, which is what the options are keyed by. */
  model: string;
  machine: Machine;
  /** Whether this model is the one currently loaded, so a reload is offered. */
  loaded: boolean;
  onReload: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<ModelOptions | undefined>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fields = useMemo(() => (options ? fieldsFor(options) : []), [options]);

  const load = useCallback(async (): Promise<void> => {
    const res = await window.karen.modelOptions(model);
    if (!res.ok || !res.options) {
      setError(res.error ?? "These settings could not be read.");
      return;
    }
    setOptions(res.options);
    setDraft(toDraft(res.options, fieldsFor(res.options)));
  }, [model]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !options) {
    return (
      <div className="mopt">
        <p className="run-error">{error}</p>
      </div>
    );
  }
  if (!options) return <div className="mopt"><p className="mopt-wait">Reading settings…</p></div>;

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
    const res = await window.karen.modelOptionsSet(model, patch);
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
    const res = await window.karen.modelOptionsReset(model);
    setBusy(false);
    if (!res.ok || !res.options) {
      setError(res.error ?? "Those settings could not be reset.");
      return;
    }
    setOptions(res.options);
    setDraft(toDraft(res.options, fieldsFor(res.options)));
    setNote("Back to the defaults.");
  };

  const overrides = Object.keys(options.saved).filter((k) => k !== "model_name").length;
  const shown = fields.filter((f) => showAdvanced || !f.advanced);

  return (
    <div className="mopt">
      <header className="mopt-head">
        <div>
          <h4>How {displayModelName(model)} loads</h4>
          <p>
            {options.recipe ? <>Run by {options.recipe}. </> : null}
            {overrides
              ? `${overrides} setting${overrides === 1 ? "" : "s"} changed from the default.`
              : "Everything is at the default."}
          </p>
        </div>
        <button type="button" className="lem-act" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="mopt-fields">
        {shown.map((field) => (
          <Field
            key={field.key}
            field={field}
            options={options}
            value={draft[field.key] ?? ""}
            machine={machine}
            onChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
          />
        ))}
      </div>

      <button type="button" className="lem-more" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Hide the advanced settings" : "Show the advanced settings"}
      </button>

      {error ? <p className="run-error">{error}</p> : null}
      {note ? <p className="mopt-note">{note}</p> : null}

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
    </div>
  );
}

function Field({
  field,
  options,
  value,
  machine,
  onChange,
}: {
  field: OptionField;
  options: ModelOptions;
  value: string;
  machine: Machine;
  onChange: (v: string) => void;
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
      {field.kind === "context" ? <ContextHint options={options} value={value} machine={machine} /> : null}
      {/* A bare "300" in a box labelled "Unload after idle" is a number with
          no unit, and the two plausible readings -- five minutes or five
          hours -- are an hour apart. */}
      {field.kind === "seconds" ? <Seconds value={value} /> : null}
      {field.help ? <p className="mopt-help">{field.help}</p> : null}
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

function ContextHint({
  options,
  value,
  machine,
}: {
  options: ModelOptions;
  value: string;
  machine: Machine;
}) {
  const read = readContextSize(value);
  if ("error" in read) return <p className="mopt-hint bad">{read.error}</p>;

  if (read.value === -1) {
    return (
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
    );
  }

  /*
   * No invented number here.
   *
   * The KV cache is what a bigger window costs, and its size needs the model's
   * layer and KV-head counts -- which the daemon does not report, so
   * `fit.ts` would fall back to a rule of thumb that ignores context entirely
   * and produce the same figure for 4k and 128k. A cost estimate that does not
   * move with the setting it is describing is worse than none, so this states
   * the relationship and leaves the number to the load, where it is real.
   */
  const ceiling = machine.vramBytes ? "graphics memory" : "system memory";
  return (
    <p className="mopt-hint">
      <strong>{formatTokens(read.value)}</strong> ({read.value.toLocaleString("en-GB")} tokens).
      Memory reserved at load time grows roughly in proportion to this, in {ceiling}. If a size is
      too large the model fails to load and Lemonade says so — nothing is damaged by trying.
    </p>
  );
}
