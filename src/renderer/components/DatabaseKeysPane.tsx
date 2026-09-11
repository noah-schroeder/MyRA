import { useEffect, useState } from "react";
import { DATABASES } from "../../core/research/databases.ts";
import type { VaultStatus } from "../types.ts";

/**
 * API keys for the two literature databases that require one — CORE on
 * every request, PubMed's own free tier being tight enough on a multi-query
 * deep run that it is offered under the same rule (see databases.ts).
 *
 * No new IPC channel: `myra:set-secret` and `myra:secrets-backend` already
 * carry everything this pane needs, because `ncbiKey` and `coreKey` are named
 * secrets like every other one the vault already handles. This mirrors
 * `ProviderCard`'s key field in ProvidersPane.tsx exactly — write-only input,
 * a presence probe, save on blur, an empty string deletes — because that is
 * already the pattern users see for every other key in this app, and a
 * second pattern for these two would be a difference with no reason behind
 * it.
 *
 * OpenAlex and arXiv need no key at all and are not shown here — this tab is
 * only for the databases that need one.
 */
export function DatabaseKeysPane({
  vault,
}: {
  vault?: VaultStatus | undefined;
}) {
  const keyed = DATABASES.filter((d) => d.secret);

  return (
    <div className="pane">
      <p className="pane-lead">
        Two of the four literature databases need a key of your own — free, and yours alone. MyRA
        never ships a shared key: every user supplies theirs, encrypted into this machine's own
        keyring, never written to a settings file a repository or a cloud sync could pick up.
      </p>

      {/* Same warning ProvidersPane shows, and for the same reason: it is the
          visible half of "refuse to persist rather than offer a false
          guarantee", and a screen that takes keys must not omit it. */}
      {vault && !vault.usable ? (
        <p className="warning" role="alert">
          <strong>Keys cannot be stored securely here.</strong> {vault.reason} Keys will be kept
          for this session only rather than written to disk with a password that is not a secret.
        </p>
      ) : null}

      {keyed.map((db) => (
        <DatabaseKeyCard key={db.id} secret={db.secret!} label={db.label} covers={db.covers} signup={db.signup} />
      ))}
    </div>
  );
}

function DatabaseKeyCard({
  secret,
  label,
  covers,
  signup,
}: {
  secret: "ncbiKey" | "coreKey";
  label: string;
  covers: string;
  signup?: string | undefined;
}) {
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  /* Whether one is stored, never what it is — the same reason a provider's
     key field never shows the key back. */
  const [hasKey, setHasKey] = useState<boolean | undefined>();

  useEffect(() => {
    void window.myra.secretsBackend().then((v) => setHasKey(Boolean(v.present?.[secret])));
  }, [secret, note]);

  return (
    <section className="provider">
      <div className="provider-head">
        <span className="provider-label">{label}</span>
      </div>
      <p className="provider-note">
        {covers}
        {secret === "ncbiKey"
          ? " Works without a key at 3 requests a second; a free NCBI key raises that to 10 — useful on a deep run, which fires several queries in a row."
          : " CORE requires a key for every request; there is no keyless tier."}
        {signup ? (
          <>
            {" "}
            <a className="linkish" href={signup} target="_blank" rel="noreferrer">
              Get a free key
            </a>
            .
          </>
        ) : null}
      </p>

      <label className="field">
        <span>API key</span>
        <input
          className="input-line"
          type="password"
          placeholder={
            hasKey ? "A key is stored. Type a new one to replace it." : "Not set. Encrypted into your login keyring when saved."
          }
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            if (!key) return;
            void window.myra.setSecret(secret, key).then(() => {
              setKey("");
              setNote("Saved.");
            });
          }}
        />
      </label>
      {note ? <p className="provider-note">{note}</p> : null}
      {hasKey ? (
        <button
          type="button"
          className="btn-sm"
          onClick={() => void window.myra.setSecret(secret, "").then(() => setNote("Key removed."))}
        >
          Remove the stored key
        </button>
      ) : null}
    </section>
  );
}
