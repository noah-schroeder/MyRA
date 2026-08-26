import { useCallback, useEffect, useState } from "react";
import type { CacheType, LaunchPlan, LaunchSettings, RuntimeDevice } from "../types.ts";

/**
 * What this model will be given, and what that costs.
 *
 * The controls are secondary here. The primary thing is the bar: weights,
 * cache and overhead against the memory this machine actually has, recomputed
 * from the same function that builds the command line. Karen previously showed
 * a fit sized at 8192 tokens and then launched with `-c 0`, which llama.cpp
 * reads as the model's trained context *per slot* -- so a 128k model was
 * described by arithmetic for a context thirty-two times smaller than the one
 * it was about to be handed. A configurator whose numbers were decorative would
 * repeat that mistake with more knobs.
 *
 * So every control below states its consequence in memory before it is moved,
 * and the command line is shown verbatim underneath. Nothing here is reachable
 * by the model -- these are a person's settings for their own machine.
 */

const CACHE: { id: CacheType; label: string; hint: string }[] = [
  { id: "f16", label: "Full", hint: "What llama.cpp uses by default" },
  { id: "q8_0", label: "Half", hint: "About half the memory, no visible quality cost" },
  { id: "q4_0", label: "Quarter", hint: "About a quarter; long contexts start to drift" },
];

function gb(bytes: number): string {
  if (Math.abs(bytes) >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(Math.abs(bytes) / 1024 ** 2))} MB`;
}

/** 32768 reads as a number; "32k" reads as a length. */
function tokens(n: number): string {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  return String(n);
}

export function ModelConfig({
  path,
  choices,
  devices,
  onClose,
  onLoad,
}: {
  path: string;
  /** Context rungs this model supports, capped at its trained length. */
  choices: number[];
  devices: RuntimeDevice[];
  onClose: () => void;
  onLoad: (path: string) => void;
}) {
  const [plan, setPlan] = useState<LaunchPlan | undefined>();
  const [draft, setDraft] = useState<Partial<LaunchSettings>>({});
  const [saving, setSaving] = useState(false);
  const [showArgs, setShowArgs] = useState(false);

  const replan = useCallback(
    async (override: Partial<LaunchSettings>) => {
      setPlan(await window.karen.runtimePlan(path, override));
    },
    [path],
  );

  useEffect(() => {
    void replan({});
  }, [replan]);

  if (!plan) return <p className="hint">Reading the model…</p>;

  const { budget, settings } = plan;
  const change = (patch: Partial<LaunchSettings>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    void replan(next);
  };

  const save = async (andLoad: boolean): Promise<void> => {
    setSaving(true);
    await window.karen.runtimeSetLaunch(path, { ...settings, ...draft });
    setSaving(false);
    setDraft({});
    if (andLoad) onLoad(path);
    else onClose();
  };

  // Three segments of one bar. Percentages are of the budget, not of the
  // total, so a configuration that does not fit visibly runs past the end
  // rather than quietly rescaling to look the same as one that does.
  const pct = (n: number): string => `${Math.max(0, (n / budget.budgetBytes) * 100)}%`;
  const over = budget.headroomBytes < 0;
  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="cfg">
      <div className="cfg-budget">
        <div className={over ? "cfg-bar over" : "cfg-bar"}>
          <span className="seg-weights" style={{ width: pct(budget.weightsBytes) }} title="Weights" />
          <span className="seg-cache" style={{ width: pct(budget.cacheBytes) }} title="Context cache" />
          <span className="seg-over" style={{ width: pct(budget.overheadBytes) }} title="Working memory" />
        </div>
        <ul className="cfg-key">
          <li><i className="k-weights" />Weights {gb(budget.weightsBytes)}</li>
          <li><i className="k-cache" />Context cache {gb(budget.cacheBytes)}{budget.estimated ? " (estimated)" : ""}</li>
          <li><i className="k-over" />Working memory {gb(budget.overheadBytes)}</li>
          <li className={over ? "cfg-headroom over" : "cfg-headroom"}>
            {over
              ? `${gb(budget.headroomBytes)} over the ${gb(budget.budgetBytes)} available`
              : `${gb(budget.headroomBytes)} spare of ${gb(budget.budgetBytes)}`}
          </li>
        </ul>
        {budget.estimated ? (
          <p className="hint">
            This model&rsquo;s header could not be read, so the cache figure is a rule of thumb
            rather than its real attention shape.
          </p>
        ) : null}
      </div>

      <div className="cfg-grid">
        <label className="cfg-field">
          <span className="cfg-label">Conversation length</span>
          <select
            value={draft.context ?? settings.context ?? "auto"}
            onChange={(e) =>
              change({
                ...(e.target.value === "auto" ? { context: undefined } : { context: Number(e.target.value) }),
              })
            }
          >
            <option value="auto">As much as fits ({tokens(budget.context)})</option>
            {choices.map((c) => (
              <option key={c} value={c}>{tokens(c)} tokens</option>
            ))}
          </select>
          <span className="cfg-hint">
            How much of a conversation the model can see at once. The cache above is what it costs.
          </span>
        </label>

        <label className="cfg-field">
          <span className="cfg-label">Requests at once</span>
          <select
            value={draft.slots ?? settings.slots}
            onChange={(e) => change({ slots: Number(e.target.value) })}
          >
            {[1, 2, 4, 8].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          {/* True because of --kv-unified, which Karen always passes. Without
              it each slot gets its own cache and this control would multiply
              the figure above. */}
          <span className="cfg-hint">
            Research runs several stages at once. They share one cache, so this costs no extra
            memory.
          </span>
        </label>

        <div className="cfg-field">
          <span className="cfg-label">Cache precision</span>
          <div className="seg">
            {CACHE.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.hint}
                className={(draft.cacheType ?? settings.cacheType) === c.id ? "active" : ""}
                onClick={() => change({ cacheType: c.id })}
              >
                {c.label}
              </button>
            ))}
          </div>
          <span className="cfg-hint">
            {CACHE.find((c) => c.id === (draft.cacheType ?? settings.cacheType))?.hint}
          </span>
        </div>

        {devices.length ? (
          <label className="cfg-field">
            <span className="cfg-label">Layers on the GPU</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="Automatic"
              value={draft.gpuLayers ?? settings.gpuLayers ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                change(
                  e.target.value.trim() === "" || Number.isNaN(n)
                    ? { gpuLayers: undefined }
                    : { gpuLayers: n },
                );
              }}
            />
            <span className="cfg-hint">
              Leave empty unless a model fails to load. llama.cpp decides for itself, and is
              usually right.
            </span>
          </label>
        ) : null}
      </div>

      <label className="cfg-field">
        <span className="cfg-label">Extra arguments</span>
        <input
          type="text"
          placeholder="-t 8"
          value={draft.extraArgs ?? settings.extraArgs ?? ""}
          onChange={(e) => change({ extraArgs: e.target.value })}
        />
        <span className="cfg-hint">
          Passed to llama-server as typed. Karen sets the model, address and port itself, so those
          are refused.
        </span>
      </label>

      {plan.error ? <p className="cfg-error" role="alert">{plan.error}</p> : null}

      <button type="button" className="cfg-reveal" onClick={() => setShowArgs(!showArgs)}>
        {showArgs ? "Hide the command" : "Show the command"}
      </button>
      {showArgs ? <pre className="cfg-args">llama-server {plan.args.join(" ")}</pre> : null}

      <div className="cfg-actions">
        <button
          type="button"
          className="primary-sm"
          disabled={saving || Boolean(plan.error)}
          onClick={() => void save(true)}
        >
          Save and load
        </button>
        <button type="button" disabled={saving || Boolean(plan.error)} onClick={() => void save(false)}>
          Save
        </button>
        <button type="button" onClick={onClose}>{dirty ? "Discard" : "Close"}</button>
      </div>
    </div>
  );
}
