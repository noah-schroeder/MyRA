import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DownloadProgress, HfFileChoice, HfSearchResult, LocalModel, ModelFit, RuntimeState,
} from "../types.ts";

/**
 * Finding, sizing and choosing a model — a screen, not a dialog.
 *
 * This was a modal with an accordion in it, which is the wrong shape for the
 * job: choosing a model means comparing eight quantisations of one repository
 * against what this machine can actually hold, and an accordion shows you one
 * at a time while hiding the numbers you are comparing. A list on the left and
 * the model you are looking at on the right lets you move between candidates
 * without losing your place.
 *
 * Two things here that a file listing cannot do:
 *
 *   - **Say whether it will run**, before the download. Sizes come from the
 *     Hub; the fit comes from the GGUF header read over a single Range request,
 *     so "needs about 19 GB with your context" is measured, not guessed.
 *   - **Show what this machine has**, at the top, always. VRAM is the number
 *     every other decision on this screen is made against, and it came from
 *     probing the runtime rather than from a vendor id.
 *
 * Model cards are prose written by strangers. They are never rendered as
 * markup, never shown to the model, and the button opens the page in your own
 * browser instead — the sandbox is worth more than an inline README.
 */

const SHORTLIST: { repo: string; why: string }[] = [
  { repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", why: "Strong general and coding model" },
  { repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", why: "Small, fast, runs almost anywhere" },
  { repo: "bartowski/Mistral-Small-Instruct-2409-GGUF", why: "Good writing at a modest size" },
  { repo: "unsloth/gemma-3-12b-it-GGUF", why: "Capable mid-size model" },
];

const SORTS = [
  { id: "downloads", label: "Most used" },
  { id: "likes", label: "Most liked" },
  { id: "lastModified", label: "Newest" },
];

function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** `unsloth/Qwen3-…-GGUF` → owner and the part worth reading first. */
function split(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf("/");
  return slash < 0
    ? { owner: "", name: repo }
    : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

type Tab = "discover" | "local";

export function ModelHub({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("downloads");
  const [results, setResults] = useState<HfSearchResult[] | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [files, setFiles] = useState<Record<string, HfFileChoice[] | { error: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [progress, setProgress] = useState<DownloadProgress | undefined>();
  const [checking, setChecking] = useState<string | undefined>();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [state, setState] = useState<RuntimeState | undefined>();
  const box = useRef<HTMLInputElement>(null);

  const refreshModels = useCallback(async () => {
    setModels(await window.karen.runtimeModels());
  }, []);

  useEffect(() => {
    box.current?.focus();
    void window.karen.runtimeState().then(setState);
    void refreshModels();
    const offState = window.karen.onRuntime(setState);
    const offDl = window.karen.onRuntimeDownload(setProgress);
    return () => {
      offState();
      offDl();
    };
  }, [refreshModels]);

  const search = useCallback(async (q: string, s: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(undefined);
    setSelected(undefined);
    const result = await window.karen.hfSearch(q.trim(), s);
    setBusy(false);
    if (result.ok) setResults(result.models ?? []);
    else setError(result.error);
  }, []);

  const select = async (repo: string): Promise<void> => {
    setSelected(repo);
    if (files[repo]) return;
    const result = await window.karen.hfFiles(repo);
    setFiles((prev) => ({
      ...prev,
      [repo]: result.ok ? (result.files ?? []) : { error: result.error ?? "failed" },
    }));
  };

  /**
   * Check exactly, then download.
   *
   * The size shown while browsing is an estimate — reading a GGUF header for
   * every row would mean a Range request per row. At the moment someone commits
   * to a twenty-minute download it is worth one request to replace the estimate
   * with the real figure, because "this will not actually run" is much cheaper
   * to hear now than afterwards.
   */
  const download = async (repo: string, choice: HfFileChoice): Promise<void> => {
    setError(undefined);
    setNote(undefined);
    setChecking(choice.entry);

    const exact = (await window.karen.hfInspect(repo, choice.entry, choice.size)) as
      { fit: ModelFit; largestContext?: number };
    setChecking(undefined);

    if (exact.fit.verdict === "too-large") {
      setError(
        `${choice.quant ?? choice.label} will not run on this machine: ${exact.fit.label} ` +
          `Nothing was downloaded.`,
      );
      return;
    }
    if (exact.fit.verdict !== choice.fit.verdict) {
      // The estimate and the header disagreed; say so rather than quietly
      // changing the answer under the user.
      setNote(`Checked against the model's own header: ${exact.fit.label}`);
    }

    // Every part, with its hash. A sharded model is all or nothing.
    const result = await window.karen.hfDownload(repo, choice.parts);
    setProgress(undefined);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNote("Downloaded. It is on the “On this machine” tab, ready to use.");
    await refreshModels();
  };

  const use = async (path: string): Promise<void> => {
    setError(undefined);
    const result = await window.karen.runtimeStart(path);
    if (!result.ok && result.error) setError(result.error);
  };

  const machine = state?.machine;
  const server = state?.server;
  const rows = results ?? [];

  return (
    <section className="hub">
      <header className="hub-head">
        <div className="hub-title">
          <h1>Models</h1>
          <p>Find a model, check it fits, and run it on this machine.</p>
        </div>

        {/*
          * The numbers every decision on this screen is made against, kept in
          * view rather than in a settings tab. VRAM in particular: it is the
          * difference between a model that answers and one that swaps.
          */}
        <div className="hub-stats">
          {machine?.vramBytes ? (
            <Stat label="VRAM" value={gb(machine.vramBytes)} />
          ) : (
            <Stat label="GPU" value="none found" dim />
          )}
          {machine?.ramBytes ? <Stat label="RAM" value={gb(machine.ramBytes)} /> : null}
          <Stat label="Downloaded" value={String(models.length)} />
          <Stat
            label="Runtime"
            value={state?.activeBuild ? `${state.activeBuild.tag} ${state.activeBuild.backend}` : "not set up"}
            dim={!state?.activeBuild}
          />
        </div>

        <button type="button" className="hub-back" onClick={onClose}>
          Back to chat
        </button>
      </header>

      <div className="hub-controls">
        <div className="seg">
          <button
            type="button"
            className={tab === "discover" ? "active" : ""}
            onClick={() => setTab("discover")}
          >
            Discover
          </button>
          <button
            type="button"
            className={tab === "local" ? "active" : ""}
            onClick={() => setTab("local")}
          >
            On this machine{models.length ? ` (${models.length})` : ""}
          </button>
        </div>

        {tab === "discover" ? (
          <>
            <div className="hub-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={box}
                type="search"
                placeholder="Search every GGUF model on HuggingFace…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void search(query, sort);
                }}
                aria-label="Search HuggingFace"
              />
            </div>
            <select
              className="hub-sort"
              value={sort}
              aria-label="Sort by"
              onChange={(e) => {
                setSort(e.target.value);
                if (results) void search(query, e.target.value);
              }}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <button type="button" className="primary-sm" onClick={() => void search(query, sort)} disabled={busy}>
              {busy ? "Searching…" : "Search"}
            </button>
          </>
        ) : (
          <>
            <span className="hub-spacer" />
            <button type="button" onClick={() => void refreshModels()}>
              Rescan folders
            </button>
          </>
        )}
      </div>

      {error ? <p className="hub-alert error" role="alert">{error}</p> : null}
      {note ? <p className="hub-alert note">{note}</p> : null}

      {progress ? (
        <div className="hub-progress">
          <div className="bar">
            <span
              style={{
                width: progress.totalBytes
                  ? `${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%`
                  : "100%",
              }}
            />
          </div>
          <span className="dim">
            {progress.what} — {gb(progress.receivedBytes)}
            {progress.totalBytes ? ` of ${gb(progress.totalBytes)}` : ""}
          </span>
          <button type="button" onClick={() => void window.karen.runtimeCancel()}>
            Cancel
          </button>
        </div>
      ) : null}

      {tab === "local" ? (
        <LocalModels
          models={models}
          activePath={state?.config.activeModel}
          running={server?.state === "ready"}
          starting={server?.state === "starting"}
          onUse={(p) => void use(p)}
          onEject={() => void window.karen.runtimeStop()}
          onDelete={(p) => void window.karen.runtimeDeleteModel(p).then(refreshModels)}
          onDiscover={() => setTab("discover")}
        />
      ) : (
        <div className="hub-body">
          <ul className="hub-list">
            {!results ? (
              <>
                <li className="hub-list-head">Worth starting with</li>
                {SHORTLIST.map((s) => (
                  <ListRow
                    key={s.repo}
                    repo={s.repo}
                    hint={s.why}
                    active={selected === s.repo}
                    onClick={() => void select(s.repo)}
                  />
                ))}
              </>
            ) : rows.length === 0 ? (
              <li className="hub-empty">
                Nothing matched “{query}”. Only repositories containing GGUF files are searched,
                since those are the ones Karen can run.
              </li>
            ) : (
              <>
                <li className="hub-list-head">{rows.length} models</li>
                {rows.map((m) => (
                  <ListRow
                    key={m.id}
                    repo={m.id}
                    active={selected === m.id}
                    downloads={m.downloads}
                    likes={m.likes}
                    updated={m.lastModified}
                    gated={Boolean(m.gated)}
                    onClick={() => void select(m.id)}
                  />
                ))}
              </>
            )}
          </ul>

          <div className="hub-detail">
            {selected ? (
              <Detail
                repo={selected}
                meta={rows.find((r) => r.id === selected)}
                files={files[selected]}
                checking={checking}
                onPick={download}
              />
            ) : (
              <div className="hub-blank">
                <h2>Pick a model to see what it offers</h2>
                <p>
                  Every model is published in several quantisations — the same weights, stored at
                  different precision. Karen reads each one&rsquo;s header and tells you which will
                  fit in {machine?.vramBytes ? gb(machine.vramBytes) : "this machine"} before you
                  download anything.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className={dim ? "hub-stat dim" : "hub-stat"}>
      <span className="hub-stat-value">{value}</span>
      <span className="hub-stat-label">{label}</span>
    </div>
  );
}

function ListRow({
  repo, hint, active, downloads, likes, updated, gated, onClick,
}: {
  repo: string;
  /* Declared as `T | undefined` rather than `?: T`: exactOptionalPropertyTypes
     is on, so an optional prop will not accept an explicitly undefined value,
     and every one of these is a field the Hub may simply not have sent. */
  hint?: string | undefined;
  active: boolean;
  downloads?: number | undefined;
  likes?: number | undefined;
  updated?: string | undefined;
  gated?: boolean | undefined;
  onClick: () => void;
}) {
  const { owner, name } = split(repo);
  return (
    <li>
      <button type="button" className={active ? "hub-row active" : "hub-row"} onClick={onClick}>
        <span className="hub-row-main">
          <span className="hub-row-name">{name}</span>
          <span className="hub-row-owner">
            {owner}
            {gated ? <span className="pill warn">licence</span> : null}
          </span>
        </span>
        <span className="hub-row-stats">
          {downloads !== undefined ? <span>{compact(downloads)} ↓</span> : null}
          {likes !== undefined ? <span>{compact(likes)} ♥</span> : null}
          {updated ? <span className="dim">{ago(updated)}</span> : null}
          {hint ? <span className="dim">{hint}</span> : null}
        </span>
      </button>
    </li>
  );
}

function Detail({
  repo, meta, files, checking, onPick,
}: {
  repo: string;
  meta: HfSearchResult | undefined;
  files: HfFileChoice[] | { error: string } | undefined;
  checking: string | undefined;
  onPick: (repo: string, choice: HfFileChoice) => Promise<void>;
}) {
  const { owner, name } = split(repo);
  return (
    <>
      <header className="detail-head">
        <h2>{name}</h2>
        <p className="detail-owner">
          {owner}
          {meta?.lastModified ? <span className="dim"> · updated {ago(meta.lastModified)}</span> : null}
          {meta?.downloads !== undefined ? (
            <span className="dim"> · {compact(meta.downloads)} downloads</span>
          ) : null}
        </p>
        {meta?.tags?.length ? (
          <ul className="detail-tags">
            {meta.tags.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          className="detail-link"
          onClick={() => void window.karen.openExternal(`https://huggingface.co/${repo}`)}
        >
          Read the model card on huggingface.co →
        </button>
      </header>

      <h3 className="detail-section">Quantisations</h3>
      {!files ? (
        <p className="hint">Looking at what this model offers…</p>
      ) : "error" in files ? (
        <p className="hub-alert error">{files.error}</p>
      ) : files.length === 0 ? (
        <p className="hint">This repository has no GGUF files.</p>
      ) : (
        <table className="quant-table">
          <thead>
            <tr>
              <th>Quantisation</th>
              <th className="num">Size</th>
              <th>Will it run here</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.entry} className={f.fit.verdict === "too-large" ? "out" : ""}>
                <td>
                  <span className="quant-name">{f.quant ?? f.label}</span>
                  {f.parts.length > 1 ? <span className="pill">{f.parts.length} files</span> : null}
                </td>
                <td className="num">{gb(f.size)}</td>
                <td className={`fit fit-${f.fit.verdict}`}>{f.fit.label}</td>
                <td className="num">
                  <button
                    type="button"
                    className={f.fit.verdict === "too-large" ? "" : "primary-sm"}
                    disabled={f.fit.verdict === "too-large" || checking !== undefined}
                    onClick={() => void onPick(repo, f)}
                  >
                    {f.fit.verdict === "too-large"
                      ? "Too large"
                      : checking === f.entry
                        ? "Checking…"
                        : "Download"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Sizes are the Hub&rsquo;s. The verdict is read from each file&rsquo;s own header over a
        single range request, against your context setting — so it is measured rather than guessed.
      </p>
    </>
  );
}

function LocalModels({
  models, activePath, running, starting, onUse, onEject, onDelete, onDiscover,
}: {
  models: LocalModel[];
  activePath: string | undefined;
  running: boolean;
  starting: boolean;
  onUse: (path: string) => void;
  onEject: () => void;
  onDelete: (path: string) => void;
  onDiscover: () => void;
}) {
  if (models.length === 0) {
    return (
      <div className="hub-blank standalone">
        <h2>No models here yet</h2>
        <p>
          Karen looks in its own folder and in LM Studio&rsquo;s and llama.cpp&rsquo;s, so anything
          you have already downloaded shows up here without being fetched again.
        </p>
        <button type="button" className="primary-sm" onClick={onDiscover}>
          Find a model
        </button>
      </div>
    );
  }

  return (
    <ul className="local-list">
      {models.map((m) => {
        const active = m.path === activePath;
        return (
          <li key={m.path} className={active ? "active" : ""}>
            <div className="local-main">
              <span className="local-name">{m.name}</span>
              <span className="local-meta">
                <span className="pill">{m.source}</span>
                <span className="dim">{gb(m.size)}</span>
                {m.shape?.architecture ? <span className="dim">{m.shape.architecture}</span> : null}
                {active && running ? <span className="pill on">loaded</span> : null}
                {active && starting ? <span className="pill warn">loading</span> : null}
              </span>
              {m.fit ? <p className={`fit fit-${m.fit.verdict}`}>{m.fit.label}</p> : null}
              {m.shape?.hasChatTemplate === false ? (
                <p className="fit fit-too-large">
                  This file has no chat template, so it cannot hold a conversation.
                </p>
              ) : null}
            </div>
            <div className="local-actions">
              {active && running ? (
                <button type="button" onClick={onEject}>Eject</button>
              ) : (
                <button
                  type="button"
                  className="primary-sm"
                  disabled={starting}
                  onClick={() => onUse(m.path)}
                >
                  {starting ? "Loading…" : "Load"}
                </button>
              )}
              {/* Only ever our own files. Another application's models are
                  scanned, never managed. */}
              {m.source === "Karen" ? (
                <button type="button" className="danger" onClick={() => onDelete(m.path)}>
                  Delete
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
