/**
 * Serving Karen's model to other apps.
 *
 * The job this page has to do well is narrow and concrete: **get an address
 * and a key into another program in thirty seconds.** So the address and the
 * switch are the largest things on it, the setup snippets are paste-ready
 * rather than described, and everything else is below.
 *
 * The second job is to be honest about what was just turned on. This is the
 * only socket in Karen that listens, so the page says in plain words what is
 * reachable, by whom, and — when the network switch is on — at what address.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ROUTES, type Dialect } from "../../core/api/routes.ts";
import { tokensPerSecond, type RequestRecord } from "../../core/api/log.ts";
import type { ApiState } from "../types.ts";

const DIALECT_LABELS: Record<Dialect, string> = {
  openai: "OpenAI",
  ollama: "Ollama",
  anthropic: "Anthropic",
  karen: "Karen",
};

type Tab = "serving" | "requests" | "keys";

const TABS: { id: Tab; label: string }[] = [
  { id: "serving", label: "Serving" },
  { id: "requests", label: "Requests" },
  { id: "keys", label: "Keys" },
];

export function ApiPage() {
  const [state, setState] = useState<ApiState | undefined>();
  const [entries, setEntries] = useState<RequestRecord[]>([]);
  const [tab, setTab] = useState<Tab>("serving");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /* Shown once, then gone: Karen stores only a hash and genuinely cannot
     produce this value again. The UI says so rather than implying a policy. */
  const [newSecret, setNewSecret] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.karen.apiState());
    const log = await window.karen.apiRequests();
    if (log.ok) setEntries(log.entries);
  }, []);

  useEffect(() => {
    void refresh();
    const offState = window.karen.onApi((s) => setState(s));
    const offLog = window.karen.onApiLog((e) => setEntries(e));
    return () => {
      offState();
      offLog();
    };
  }, [refresh]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const res = await fn();
    setBusy(false);
    if (!res.ok && res.error) setError(res.error);
    await refresh();
  };

  if (!state) return <div className="api-page"><p className="lem-waiting">Loading…</p></div>;

  const serving = state.status.listening;
  const noKeys = state.keys.length === 0;

  return (
    <div className="api-page">
      <header className="lem-head">
        <h3>API</h3>
        <p>
          Let another app use the model Karen is running — Obsidian, a notebook, a script.
          Everything stays on this machine.
        </p>
      </header>

      {error ? <div className="lem-status bad"><p className="lem-status-line">{error}</p></div> : null}
      {state.status.error && !error ? (
        <div className="lem-status bad"><p className="lem-status-line">{state.status.error}</p></div>
      ) : null}

      <div className="lem-browser-bar">
        <div className="lem-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "lem-tab on" : "lem-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "requests" && entries.length ? (
                <span className="lem-tab-count">{entries.length}</span>
              ) : null}
              {t.id === "keys" ? <span className="lem-tab-count">{state.keys.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {tab === "serving" ? (
        <Serving state={state} busy={busy} noKeys={noKeys} serving={serving} run={run} onKeys={() => setTab("keys")} />
      ) : null}

      {tab === "requests" ? <Requests entries={entries} onRefresh={refresh} /> : null}

      {tab === "keys" ? (
        <Keys
          state={state}
          busy={busy}
          run={run}
          secret={newSecret}
          onSecret={setNewSecret}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ serving -- */

function Serving({
  state, busy, noKeys, serving, run, onKeys,
}: {
  state: ApiState;
  busy: boolean;
  noKeys: boolean;
  serving: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<void>;
  onKeys: () => void;
}) {
  const url = state.status.url ?? `http://127.0.0.1:${String(state.config.port)}`;

  return (
    <section className="lem-section">
      <div className={serving ? "api-address on" : "api-address"}>
        <div className="api-address-row">
          <span className={serving ? "api-dot on" : "api-dot"} aria-hidden="true" />
          <span className="api-state">{serving ? "Serving" : "Not serving"}</span>
          <code className="api-url">{url}</code>
          <Copy value={url} label="Copy address" />
          <span className="build-spacer" />
          <button
            type="button"
            className={serving ? "lem-act" : "lem-act get"}
            disabled={busy || (noKeys && !serving)}
            onClick={() => void run(() => (serving ? window.karen.apiStop() : window.karen.apiStart()))}
          >
            {serving ? "Stop" : "Start serving"}
          </button>
        </div>
        {noKeys ? (
          <p className="api-note">
            Karen will not serve without a key.{" "}
            <button type="button" className="link" onClick={onKeys}>Create one first</button>.
          </p>
        ) : null}
        {state.lanUrl ? (
          <p className="api-note warn">
            Reachable from your network at <code>{state.lanUrl}</code>. Anyone on this network who
            has a key can use it.
          </p>
        ) : null}
      </div>

      <div className="api-settings">
        <label className="api-port">
          <span>Port</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={state.config.port}
            onChange={(e) => void run(() => window.karen.apiConfig({ port: Number(e.target.value) }))}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.config.lan}
            disabled={noKeys}
            onChange={(e) => void run(() => window.karen.apiConfig({ lan: e.target.checked }))}
          />
          <span>Also serve on the local network</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.config.cors}
            onChange={(e) => void run(() => window.karen.apiConfig({ cors: e.target.checked }))}
          />
          <span>Allow browser apps (CORS)</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.config.startOnLaunch}
            onChange={(e) => void run(() => window.karen.apiConfig({ startOnLaunch: e.target.checked }))}
          />
          <span>Start serving when Karen opens</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.config.logBodies}
            onChange={(e) => void run(() => window.karen.apiConfig({ logBodies: e.target.checked }))}
          />
          <span title="Kept in memory only, never written to disk.">
            Record prompts in the request log
          </span>
        </label>
      </div>

      <Setup url={url} />
      <Surface />
    </section>
  );
}

/**
 * Paste-ready setup, per dialect.
 *
 * Split by dialect because the dialect is the thing a person has to match to
 * the app in front of them: someone configuring Obsidian needs a base URL,
 * someone pointing an Anthropic SDK at Karen needs an environment variable,
 * and neither wants to read the other's block.
 */
function Setup({ url }: { url: string }) {
  const [which, setWhich] = useState<Dialect>("openai");
  const snippets: Record<string, { hint: string; code: string }> = {
    openai: {
      hint: "Most tools with a “custom endpoint” or “OpenAI-compatible” setting.",
      code: `Base URL:  ${url}/v1
API key:   your Karen key

curl ${url}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KAREN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"MODEL","messages":[{"role":"user","content":"hello"}]}'

from openai import OpenAI
client = OpenAI(base_url="${url}/v1", api_key="YOUR_KAREN_KEY")`,
    },
    anthropic: {
      hint: "Anything built on the Anthropic SDK.",
      code: `export ANTHROPIC_BASE_URL=${url}
export ANTHROPIC_API_KEY=YOUR_KAREN_KEY

curl ${url}/v1/messages \\
  -H "x-api-key: YOUR_KAREN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"MODEL","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'`,
    },
    ollama: {
      hint: "Anything that expects Ollama. Point it at Karen instead of 11434.",
      code: `Host:  ${url}

curl ${url}/api/chat \\
  -H "Authorization: Bearer YOUR_KAREN_KEY" \\
  -d '{"model":"MODEL","messages":[{"role":"user","content":"hello"}],"stream":false}'`,
    },
  };
  const chosen = snippets[which] ?? snippets["openai"]!;

  return (
    <div className="api-setup">
      <header className="lem-head sub">
        <h4>Point an app at Karen</h4>
        <p>Karen answers three dialects, so most tools work without a plugin.</p>
      </header>
      <div className="lem-tabs">
        {(["openai", "anthropic", "ollama"] as Dialect[]).map((d) => (
          <button
            key={d}
            type="button"
            className={which === d ? "lem-tab on" : "lem-tab"}
            onClick={() => setWhich(d)}
          >
            {DIALECT_LABELS[d]}
          </button>
        ))}
      </div>
      <p className="lem-group-hint">{chosen.hint}</p>
      <div className="api-code">
        <pre>{chosen.code}</pre>
        <Copy value={chosen.code} label="Copy" />
      </div>
    </div>
  );
}

/**
 * What is reachable, stated rather than implied.
 *
 * This exists because the interesting fact about the gateway is what it does
 * NOT forward. Lemonade's own key would let a client install runtimes and
 * delete models; a Karen key reaches this list and nothing else, and someone
 * deciding whether to publish this on their network deserves to see it.
 */
function Surface() {
  const [open, setOpen] = useState(false);
  return (
    <div className="api-surface">
      <button type="button" className="lem-more" onClick={() => setOpen(!open)}>
        {open ? "Hide what apps can reach" : "See exactly what apps can reach"}
      </button>
      {open ? (
        <>
          <ul className="api-routes">
            {ROUTES.filter((r) => r.dialect !== "karen").map((r) => (
              <li key={`${r.method} ${r.path}`}>
                <span className="lem-chip">{DIALECT_LABELS[r.dialect]}</span>
                <code>{r.method} {r.path}</code>
                <span className="api-route-what">{r.what}</span>
              </li>
            ))}
          </ul>
          <p className="api-note">
            Nothing else. An app using this cannot install runtimes, download or delete models,
            read what this machine is, change any setting, or see your conversations — those
            requests are refused before they reach anything.
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- requests -- */

function Requests({ entries, onRefresh }: { entries: RequestRecord[]; onRefresh: () => Promise<void> }) {
  const open = entries.filter((e) => e.state === "open");
  const done = entries.filter((e) => e.state !== "open");

  return (
    <section className="lem-section">
      {open.length ? (
        <>
          <header className="lem-head sub"><h4>In flight</h4></header>
          <ul className="lem-models">
            {open.map((e) => (
              <li key={e.id} className="lem-model loaded">
                <div className="lem-model-id">
                  <span className="lem-chip accent">{e.keyLabel}</span>
                  <span className="lem-model-name">{e.model ?? e.path}</span>
                </div>
                <span className="lem-model-size">{elapsed(e)}</span>
                <button
                  type="button"
                  className="lem-act"
                  onClick={() => void window.karen.apiCancel(e.id).then(onRefresh)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <header className="lem-head sub">
        <h4>Recent</h4>
        <p>Metadata only, kept in memory, and cleared when Karen closes.</p>
      </header>

      {done.length ? (
        <>
          <ul className="lem-models">
            {done.map((e) => <Row key={e.id} record={e} />)}
          </ul>
          <button
            type="button"
            className="lem-more"
            onClick={() => void window.karen.apiClearLog().then(onRefresh)}
          >
            Clear this list
          </button>
        </>
      ) : (
        <p className="lem-none">
          {open.length ? "Nothing finished yet." : "Nothing has asked Karen for anything yet."}
        </p>
      )}
    </section>
  );
}

function Row({ record }: { record: RequestRecord }) {
  const [open, setOpen] = useState(false);
  const speed = tokensPerSecond(record);
  const tone =
    record.state === "error" ? "bad" : record.state === "cancelled" ? "warn" : "good";
  return (
    <li className="lem-model api-row">
      <button type="button" className="api-row-head" onClick={() => setOpen(!open)}>
        <span className="lem-chip">{record.keyLabel}</span>
        <span className="lem-model-name">{record.model ?? record.path}</span>
        <span className="build-spacer" />
        <span className={`lem-chip ${tone}`}>{record.status ?? record.state}</span>
        <span className="api-figure">{record.durationMs ? `${(record.durationMs / 1000).toFixed(1)}s` : "—"}</span>
      </button>
      {open ? (
        <dl className="api-detail">
          <div><dt>Started</dt><dd>{new Date(record.startedAt).toLocaleTimeString()}</dd></div>
          <div><dt>Route</dt><dd><code>{record.method} {record.path}</code></dd></div>
          <div><dt>Dialect</dt><dd>{DIALECT_LABELS[record.dialect as Dialect] ?? record.dialect}</dd></div>
          {record.firstTokenMs !== undefined ? (
            <div><dt>First token</dt><dd>{record.firstTokenMs} ms</dd></div>
          ) : null}
          {record.promptTokens !== undefined ? (
            <div><dt>Prompt</dt><dd>{record.promptTokens} tokens</dd></div>
          ) : null}
          {record.completionTokens !== undefined ? (
            <div><dt>Reply</dt><dd>{record.completionTokens} tokens</dd></div>
          ) : null}
          {speed ? <div><dt>Speed</dt><dd>{speed} tokens/sec</dd></div> : null}
          {record.error ? <div><dt>Error</dt><dd>{record.error}</dd></div> : null}
          {record.body ? (
            <div className="api-detail-body"><dt>Body</dt><dd><pre>{record.body}</pre></dd></div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

function elapsed(record: RequestRecord): string {
  const ms = Date.now() - new Date(record.startedAt).getTime();
  return `${(ms / 1000).toFixed(0)}s`;
}

/* --------------------------------------------------------------------- keys -- */

function Keys({
  state, busy, run, secret, onSecret,
}: {
  state: ApiState;
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<void>;
  secret: string | undefined;
  onSecret: (s: string | undefined) => void;
}) {
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>();

  const create = async (): Promise<void> => {
    const res = await window.karen.apiKeyCreate(label || "Unnamed key");
    if (res.ok && res.secret) {
      onSecret(res.secret);
      setLabel("");
    }
  };

  return (
    <section className="lem-section">
      <header className="lem-head sub">
        <h4>Keys</h4>
        <p>
          One per app, so you can take away one app&apos;s access without touching the others.
          Karen stores only a hash — a key is shown once and cannot be shown again.
        </p>
      </header>

      {secret ? (
        <div className="api-secret">
          <p className="api-secret-title">Copy this now. It will not be shown again.</p>
          <div className="api-code">
            <pre>{secret}</pre>
            <Copy value={secret} label="Copy" />
          </div>
          <button type="button" className="lem-more" onClick={() => onSecret(undefined)}>
            I have saved it
          </button>
        </div>
      ) : null}

      <div className="api-newkey">
        <input
          type="text"
          className="lem-search"
          placeholder="What is it for? e.g. Obsidian"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
        />
        <button type="button" className="lem-act get" disabled={busy} onClick={() => void create()}>
          Create key
        </button>
      </div>

      <ul className="lem-models">
        {state.keys.map((k) => (
          <li key={k.id} className="lem-model">
            <div className="lem-model-id">
              <span className="lem-model-name">{k.label}</span>
              <span className="lem-chip">sk-karen-…{k.tail}</span>
            </div>
            <span className="api-figure">
              {k.requests} request{k.requests === 1 ? "" : "s"}
              {k.lastUsedAt ? ` · last ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
            </span>
            {confirming === k.id ? (
              <>
                <button type="button" className="lem-act" onClick={() => setConfirming(undefined)}>
                  Keep
                </button>
                <button
                  type="button"
                  className="lem-act api-danger"
                  onClick={() => { setConfirming(undefined); void run(() => window.karen.apiKeyRevoke(k.id)); }}
                >
                  Revoke
                </button>
              </>
            ) : (
              <button type="button" className="lem-act" onClick={() => setConfirming(k.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
        {state.keys.length === 0 ? <li className="lem-none">No keys yet.</li> : null}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------- shared -- */

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className="lem-act"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          timer.current = setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
