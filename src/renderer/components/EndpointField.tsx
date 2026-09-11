import { useState } from "react";
import type { Settings } from "../types.ts";

/**
 * One service MyRA talks to that is not a chat model.
 *
 * This used to be a tab of its own, "Endpoints", listing three of these. The
 * language model one is gone: Providers does that job properly, with a model
 * list, a key per vendor and a judgement about whether the address is on this
 * machine, and having both meant two screens decided where a conversation went.
 *
 * Transcription has since gone the same way, and this is now down to one.
 * Speech is a MODEL, chosen from a list of what the local runtime holds and
 * what the providers offer, rather than a URL somebody has to know the shape
 * of -- so it belongs on the Audio tab as a picker and not here as a form.
 * Embeddings stay, because ranking search results is a provider question and
 * this is where a provider's endpoint is configured.
 */
export interface EndpointKind {
  key: "embeddings";
  label: string;
  secret: "embedKey";
  hint: string;
}

export const EMBEDDINGS: EndpointKind = {
  key: "embeddings",
  label: "Embeddings",
  secret: "embedKey",
  hint: "Optional. Ranks search results by meaning rather than by keyword.",
};

export function EndpointField({
  which,
  settings,
  patch,
}: {
  which: EndpointKind;
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const value = settings[which.key];
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const update = (changes: Partial<typeof value>): void => {
    void patch({ [which.key]: { ...value, ...changes } } as Partial<Settings>);
  };

  const test = async (): Promise<void> => {
    setStatus("testing…");
    const result = await window.myra.testEndpoint(which.key);
    setStatus(result.ok ? "reachable" : `unreachable — ${result.error}`);
  };

  const discover = async (): Promise<void> => {
    setStatus("asking…");
    const result = await window.myra.discoverModels(which.key);
    if (result.ok) {
      setModels(result.models ?? []);
      setStatus(`${result.models?.length ?? 0} model(s)`);
    } else {
      setStatus(`could not list models — ${result.error}`);
    }
  };

  return (
    <fieldset className="endpoint">
      <legend>{which.label}</legend>
      <p className="hint">{which.hint}</p>

      <label>
        Base URL
        <input
          value={value.baseUrl}
          placeholder="http://127.0.0.1:8080/v1"
          onChange={(e) => update({ baseUrl: e.target.value })}
        />
      </label>

      <label>
        API key
        <input
          type="password"
          value={key}
          placeholder={"leave blank to keep the stored key"}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            if (key) {
              void window.myra.setSecret(which.secret, key);
              setKey("");
              setStatus("key saved");
            }
          }}
        />
      </label>

      <label>
        Model
        {models ? (
          <select value={value.model ?? ""} onChange={(e) => update({ model: e.target.value })}>
            <option value="">(server default)</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input value={value.model ?? ""} onChange={(e) => update({ model: e.target.value })} />
        )}
      </label>

      {/* Named for what it now measures. It used to be a total deadline, which
          cut off long answers that were arriving perfectly well; it counts
          silence instead, so only a stalled server hits it. */}
      <label>
        Give up after
        <input
          type="number"
          min={5}
          max={3600}
          value={Math.round(value.timeoutMs / 1000)}
          onChange={(e) => update({ timeoutMs: Math.max(5, Number(e.target.value)) * 1000 })}
        />
        <span className="unit">seconds of silence</span>
      </label>

      <div className="endpoint-actions">
        <button type="button" onClick={() => void test()}>
          Test connection
        </button>
        <button type="button" onClick={() => void discover()}>
          Discover models
        </button>
        {status ? <span className="status">{status}</span> : null}
      </div>
    </fieldset>
  );
}

