import { useState } from "react";
import type { Provider, Settings } from "../types.ts";
import {
  effectiveKind, kindWasOverridden, newProviderId, urlIsLocal,
} from "../../core/providers.ts";

/**
 * Where models can come from, besides the one Karen runs itself.
 *
 * The managed local runtime is not in this list and cannot be edited out of it:
 * it is what the app IS, and a list that could be emptied down to nothing would
 * be a way to break Karen from the settings screen. Everything here is an
 * addition to it.
 *
 * Two decisions get made per provider, and they are different questions:
 *
 *   - Where is it, which decides whether a conversation leaves this machine.
 *   - Which of its models you actually want, because an endpoint that serves
 *     two hundred of them turns the picker into a directory.
 *
 * The first is checked rather than trusted. Anyone can call an endpoint local;
 * only an endpoint on this machine is local, and Karen says so where the claim
 * is made rather than saving it and warning later.
 */
export function ProvidersPane({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const providers = settings.providers ?? [];

  const save = (next: Provider[]): Promise<void> => patch({ providers: next });

  const add = (): void => {
    void save([
      ...providers,
      {
        id: newProviderId(providers),
        label: "",
        /* External by default. The common reason to add one of these is a
           hosted API, and a default that has to be corrected downwards is a
           default that will sometimes not be. */
        kind: "external",
        baseUrl: "",
        models: [],
        enabled: true,
      },
    ]);
  };

  return (
    <div className="pane">
      <p className="pane-lead">
        Models Karen can use besides the ones it runs itself. A provider on this machine keeps
        conversations here; a hosted one sends them to whoever runs it, including anything already
        in the conversation. Karen checks the address rather than taking the label's word for it.
      </p>

      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onChange={(next) => void save(providers.map((p) => (p.id === next.id ? next : p)))}
          onRemove={() => void save(providers.filter((p) => p.id !== provider.id))}
        />
      ))}

      <button type="button" className="btn" onClick={add}>
        Add a provider
      </button>
    </div>
  );
}

function ProviderCard({
  provider,
  onChange,
  onRemove,
}: {
  provider: Provider;
  onChange: (next: Provider) => void;
  onRemove: () => void;
}) {
  const [key, setKey] = useState("");
  const [keyNote, setKeyNote] = useState("");
  const [found, setFound] = useState<string[] | undefined>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const real = effectiveKind(provider);
  const overridden = kindWasOverridden(provider);

  const fetchModels = (): void => {
    setBusy(true);
    setStatus("Asking the endpoint…");
    void window.karen
      .providerModels({ baseUrl: provider.baseUrl, id: provider.id, ...(key ? { apiKey: key } : {}) })
      .then((r) => {
        setFound(r.models ?? []);
        setStatus(
          r.ok
            ? `${(r.models ?? []).length} model(s) available. Tick the ones you want in the picker.`
            : (r.error ?? "The endpoint did not answer."),
        );
      })
      .finally(() => setBusy(false));
  };

  const toggleModel = (name: string): void => {
    const models = provider.models.includes(name)
      ? provider.models.filter((m) => m !== name)
      : [...provider.models, name];
    onChange({ ...provider, models });
  };

  /* What the endpoint offers, plus anything already ticked that it no longer
     lists. A model that vanished from the endpoint but is still selected is
     something the user needs to see and untick -- silently dropping it from
     this list would leave it in the picker with no way to remove it. */
  const rows = [...new Set([...(found ?? []), ...provider.models])].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <section className={provider.enabled ? "provider" : "provider off"}>
      <div className="provider-head">
        <input
          className="input-line provider-label"
          placeholder="Name — e.g. OpenAI, or the lab's server"
          value={provider.label}
          onChange={(e) => onChange({ ...provider, label: e.target.value })}
        />
        <label className="provider-toggle">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => onChange({ ...provider, enabled: e.target.checked })}
          />
          Enabled
        </label>
        <button type="button" className="btn-sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>

      <label className="field">
        <span>Base URL</span>
        <input
          className="input-line"
          /* An instruction, not an example URL.
             A host written here is a host in the source, and the destinations
             test reads the source to build the privacy report's list of places
             Karen can reach. That list has to stay exactly true, and a vendor
             named in a placeholder is not somewhere Karen goes until somebody
             types it. Saying what to type is no worse than showing it. */
          placeholder="The endpoint's base URL, usually ending in /v1"
          value={provider.baseUrl}
          onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })}
        />
      </label>

      <fieldset className="provider-kind">
        <legend>Where is it?</legend>
        {(["local", "external"] as const).map((kind) => (
          <label key={kind}>
            <input
              type="radio"
              name={`kind-${provider.id}`}
              checked={provider.kind === kind}
              onChange={() => onChange({ ...provider, kind })}
            />
            {kind === "local" ? "On this machine" : "External — data is sent there"}
          </label>
        ))}
      </fieldset>

      {/* Said at the moment the claim is made, not saved quietly and warned
          about later next to the model picker. */}
      {overridden ? (
        <p className="provider-note wrong" role="alert">
          <strong>This address is not on this machine,</strong> so Karen will treat it as external
          whatever this is set to. {provider.baseUrl.trim() ? "" : "Enter the base URL first. "}
          Conversations sent here leave your computer.
        </p>
      ) : real === "local" ? (
        <p className="provider-note local">Loopback — conversations sent here stay on this machine.</p>
      ) : provider.baseUrl.trim() && !urlIsLocal(provider.baseUrl) ? (
        <p className="provider-note">Conversations sent here leave your computer.</p>
      ) : null}

      <label className="field">
        <span>API key</span>
        <input
          className="input-line"
          type="password"
          placeholder={"Stored in your keyring; never shown again"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            if (!key) return;
            void window.karen.setProviderKey(provider.id, key).then(() => {
              setKey("");
              setKeyNote("Saved.");
            });
          }}
        />
      </label>
      {keyNote ? <p className="provider-note">{keyNote}</p> : null}

      <div className="provider-actions">
        <button type="button" className="btn-sm" disabled={busy || !provider.baseUrl.trim()} onClick={fetchModels}>
          {busy ? "Asking…" : "Fetch models"}
        </button>
        <span className="provider-count">
          {provider.models.length
            ? `${provider.models.length} chosen`
            : "None chosen — this provider adds nothing to the picker yet"}
        </span>
      </div>
      {status ? <p className="provider-note">{status}</p> : null}

      {rows.length ? (
        <ul className="provider-models">
          {rows.map((name) => (
            <li key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={provider.models.includes(name)}
                  onChange={() => toggleModel(name)}
                />
                <span>{name}</span>
                {found && !found.includes(name) ? (
                  <em className="gone"> — no longer served here</em>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
