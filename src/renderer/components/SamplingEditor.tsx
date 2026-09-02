import { useEffect, useState } from "react";
import type { Settings } from "../types.ts";
import {
  droppedForExternal, SAMPLING_FIELDS, type Sampling, type SamplingField,
} from "../../core/llm/sampling.ts";

/**
 * How the model chooses its words, as opposed to how it loads.
 *
 * These sit beside the load settings and are a different kind of thing, which
 * the heading says out loud: a load setting means reloading several gigabytes,
 * and one of these changes the next reply and nothing else. Keeping them in one
 * window is right — "tune this model" is one intention — but presenting them as
 * one list would suggest they cost the same to change, and they do not.
 *
 * Blank means "do not send it", not "send zero". That distinction is the whole
 * design: an unset field lets the server's own default stand, which is not the
 * same as Karen guessing what that default is and sending its guess. It is also
 * why every control here has a Clear rather than a "reset to default" that
 * would have to invent the value it resets to.
 */
export function SamplingEditor({ model }: { model: string }) {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    void window.karen.getSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const current: Sampling = settings.sampling?.[model] ?? {};

  const set = (key: string, value: number | undefined): void => {
    const next: Sampling = { ...current };
    if (value === undefined) delete next[key];
    else next[key] = value;
    const all = { ...(settings.sampling ?? {}) };
    // An empty entry is not an entry: leaving `{}` behind would make "has this
    // model been tuned?" answer yes forever after the last field was cleared.
    if (Object.keys(next).length) all[model] = next;
    else delete all[model];
    void window.karen.updateSettings({ sampling: all }).then(setSettings);
  };

  const shown = SAMPLING_FIELDS.filter((f) => showAdvanced || !f.advanced || current[f.key] !== undefined);
  const dropped = droppedForExternal(current);
  const tuned = Object.keys(current).length;

  return (
    <section className="sampling">
      <header className="sampling-head">
        <h4>How it answers</h4>
        <p>
          {tuned
            ? `${tuned} setting${tuned === 1 ? "" : "s"} set. These apply to the next reply — nothing reloads.`
            : "Everything is left to the server's own defaults. Blank means Karen does not send that setting at all."}
        </p>
      </header>

      <div className="sampling-fields">
        {shown.map((field) => (
          <SamplingRow
            key={field.key}
            field={field}
            value={current[field.key]}
            onChange={(v) => set(field.key, v)}
          />
        ))}
      </div>

      <button type="button" className="lem-more" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Hide the rarely-used samplers" : "Show every sampler"}
      </button>

      {/* Said here, where the setting is made, rather than discovered as a 400
          from a hosted endpoint that names nothing useful. */}
      {dropped.length ? (
        <p className="sampling-note">
          {dropped.join(", ")} {dropped.length === 1 ? "is" : "are"} specific to llama.cpp. If this
          model is served by an external provider, {dropped.length === 1 ? "it is" : "they are"} not
          sent — hosted APIs reject the whole request rather than ignoring a field they do not know.
        </p>
      ) : null}
    </section>
  );
}

function SamplingRow({
  field,
  value,
  onChange,
}: {
  field: SamplingField;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  /* The text is held locally so a half-typed number stays typeable. Committing
     on every keystroke would turn "0.05" into 0 the moment the dot was typed,
     and then reformat the box under the cursor. */
  const [text, setText] = useState(value === undefined ? "" : String(value));

  useEffect(() => {
    setText(value === undefined ? "" : String(value));
  }, [value]);

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange(undefined);
      return;
    }
    const n = Number(trimmed);
    // Out of range is refused rather than clamped: a clamp would turn somebody's
    // typo into a plausible number and leave the reply strange for no visible
    // reason. The box simply reverts to what was actually stored.
    if (!Number.isFinite(n) || n < field.min || n > field.max) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    if (field.kind === "integer" && !Number.isInteger(n)) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    onChange(n);
  };

  return (
    <label className="sampling-row">
      <span className="sampling-label">
        {field.label}
        {!field.standard ? <em className="sampling-tag" title="llama.cpp only; not sent to hosted providers">llama.cpp</em> : null}
      </span>
      <input
        className="input-line sampling-input"
        inputMode="decimal"
        value={text}
        placeholder="server default"
        aria-label={field.label}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
        }}
      />
      <span className="sampling-range">
        {field.min}–{field.max}
      </span>
      <button
        type="button"
        className="sampling-clear"
        disabled={value === undefined}
        title="Leave this to the server"
        onClick={() => onChange(undefined)}
      >
        Clear
      </button>
      <span className="sampling-help">{field.help}</span>
    </label>
  );
}
