import { useEffect, useState } from "react";
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
  /*
   * The text fields are held here and committed on blur.
   *
   * They were bound straight to the stored provider, with every keystroke
   * writing settings and the reply setting the value back. That is a round
   * trip through the main process between one character and the next, so a URL
   * typed at speed came out with letters missing: each change was computed
   * from whatever had made it back, not from what was on screen.
   */
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  /* The ticks are held here for the same reason, and it is not only about
     speed. Each toggle was computed from the last list that had made it back
     from the main process, so ticking two boxes before the first save returned
     dropped one of them -- silently, and the box came back unticked a moment
     later. */
  const [models, setModels] = useState<string[]>(provider.models);
  const [key, setKey] = useState("");
  const [keyNote, setKeyNote] = useState("");
  /* Whether one is stored, never what it is. Without this a saved key and no
     key look identical, so the only way to deal with a provider that is
     refusing requests is to retype the key every time. */
  const [hasKey, setHasKey] = useState<boolean | undefined>();

  useEffect(() => {
    void window.karen.providerKeysPresent().then((all) => setHasKey(Boolean(all[provider.id])));
  }, [provider.id, keyNote]);
  const [found, setFound] = useState<string[] | undefined>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  /* Judged on what is in the box, so the answer appears as the URL is typed
     rather than after the field loses focus. */
  const asTyped: Provider = { ...provider, baseUrl };
  const real = effectiveKind(asTyped);
  const overridden = kindWasOverridden(asTyped);

  const fetchModels = (): void => {
    setBusy(true);
    setStatus("Asking the endpoint…");
    void window.karen
      .providerModels({ baseUrl, id: provider.id, ...(key ? { apiKey: key } : {}) })
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
    setModels((current) => {
      const next = current.includes(name)
        ? current.filter((m) => m !== name)
        : [...current, name];
      onChange({ ...provider, models: next });
      return next;
    });
  };

  /* What the endpoint offers, plus anything already ticked that it no longer
     lists. A model that vanished from the endpoint but is still selected is
     something the user needs to see and untick -- silently dropping it from
     this list would leave it in the picker with no way to remove it. */
  const rows = [...new Set([...(found ?? []), ...models])].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <section className={provider.enabled ? "provider" : "provider off"}>
      <div className="provider-head">
        <input
          className="input-line provider-label"
          placeholder="Name — e.g. the vendor, or the lab's server"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== provider.label && onChange({ ...provider, label })}
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
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => baseUrl !== provider.baseUrl && onChange({ ...provider, baseUrl })}
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
      ) : baseUrl.trim() && !urlIsLocal(baseUrl) ? (
        <p className="provider-note">Conversations sent here leave your computer.</p>
      ) : baseUrl.trim() ? (
        /* Loopback, marked external by choice. Saying nothing here left the one
           combination with no explanation on screen, which reads as the app not
           having noticed. */
        <p className="provider-note">
          This address is on this machine, but you have marked it external, so Karen will treat it
          that way and warn when it is in use.
        </p>
      ) : null}

      <label className="field">
        <span>API key</span>
        <input
          className="input-line"
          type="password"
          placeholder={
            hasKey
              ? "A key is stored. Type a new one to replace it."
              : "Not set. Encrypted into your login keyring when saved."
          }
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
      {hasKey ? (
        <button
          type="button"
          className="btn-sm"
          onClick={() =>
            void window.karen.setProviderKey(provider.id, "").then(() => setKeyNote("Key removed."))
          }
        >
          Remove the stored key
        </button>
      ) : null}

      <div className="provider-actions">
        <button type="button" className="btn-sm" disabled={busy || !baseUrl.trim()} onClick={fetchModels}>
          {busy ? "Asking…" : "Fetch models"}
        </button>
        <span className="provider-count">
          {models.length
            ? `${models.length} chosen`
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
                  checked={models.includes(name)}
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
