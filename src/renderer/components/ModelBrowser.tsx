import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadProgress, HfFileChoice, HfSearchResult, ModelFit } from "../types.ts";

/**
 * Every model on HuggingFace, searchable.
 *
 * A curated shortlist is a good empty state and a bad filter: the moment
 * someone wants a model we did not think of, a shortlist is the reason they go
 * back to LM Studio. So the shortlist below is only what fills the box before
 * anything is typed.
 *
 * The thing this does that a file listing cannot: **say whether a model will
 * actually run here** before the download starts. Sizes come from the Hub, and
 * the fit comes from the GGUF header read over a single Range request, so
 * "needs about 19 GB" is measured rather than guessed.
 *
 * Model cards are text written by strangers, so nothing from the Hub is ever
 * rendered as markup or shown to the model.
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

export function ModelBrowser({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("downloads");
  const [results, setResults] = useState<HfSearchResult[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [files, setFiles] = useState<Record<string, HfFileChoice[] | { error: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [progress, setProgress] = useState<DownloadProgress | undefined>();
  const [downloaded, setDownloaded] = useState<string | undefined>();
  const [checking, setChecking] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    box.current?.focus();
    return window.karen.onRuntimeDownload((p) => setProgress(p as DownloadProgress | undefined));
  }, []);

  const search = useCallback(async (q: string, s: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(undefined);
    const result = (await window.karen.hfSearch(q.trim(), s)) as
      { ok: boolean; models?: HfSearchResult[]; error?: string };
    setBusy(false);
    if (result.ok) setResults(result.models ?? []);
    else setError(result.error);
  }, []);

  const expand = async (repo: string): Promise<void> => {
    setOpen(open === repo ? undefined : repo);
    if (files[repo]) return;
    const result = (await window.karen.hfFiles(repo)) as
      { ok: boolean; files?: HfFileChoice[]; error?: string };
    setFiles((prev) => ({ ...prev, [repo]: result.ok ? (result.files ?? []) : { error: result.error ?? "failed" } }));
  };

  /**
   * Check exactly, then download.
   *
   * The size shown while browsing is an estimate -- reading a GGUF header per
   * file would mean a Range request per row. At the moment someone commits to
   * a twenty-minute download it is worth one request to replace the estimate
   * with the real figure, because "this will not actually run" is much cheaper
   * to hear now than after the download finishes.
   */
  const download = async (repo: string, choice: HfFileChoice): Promise<void> => {
    setError(undefined);
    setDownloaded(undefined);
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
    const result = (await window.karen.hfDownload(repo, choice.parts)) as
      { ok: boolean; path?: string; error?: string };
    setProgress(undefined);
    if (result.ok) setDownloaded(result.path);
    else setError(result.error);
  };

  return (
    <div className="runs-backdrop" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <input
            ref={box}
            className="search-box"
            type="search"
            placeholder="Search every model on HuggingFace…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search(query, sort);
            }}
            aria-label="Search HuggingFace"
          />
          <button type="button" className="search-go" onClick={() => void search(query, sort)} disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {results ? (
          <div className="search-bar">
            <div className="seg">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={sort === s.id ? "active" : ""}
                  onClick={() => {
                    setSort(s.id);
                    void search(query, s.id);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="search-count">{results.length} models</span>
          </div>
        ) : null}

        <div className="search-results">
          {error ? <p className="run-error">{error}</p> : null}
          {downloaded ? (
            <p className="hint note">Downloaded. Close this to choose it in the Models list.</p>
          ) : null}
          {note ? <p className="hint note">{note}</p> : null}

          {progress ? (
            <div className="runtime-progress">
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

          {!results ? (
            <>
              <div className="search-intro">
                <p>Anything on HuggingFace in GGUF form can be run here.</p>
                <p className="dim">
                  If you are not sure where to start, these are safe choices. Karen will tell you
                  which sizes fit this machine before anything is downloaded.
                </p>
              </div>
              <ul className="results">
                {SHORTLIST.map((s) => (
                  <li key={s.repo}>
                    <button type="button" className="result-title" onClick={() => void expand(s.repo)}>
                      {s.repo}
                    </button>
                    <p className="result-meta">{s.why}</p>
                    {open === s.repo ? (
                      <Files repo={s.repo} files={files[s.repo]} onPick={download} checking={checking} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : results.length === 0 ? (
            <p className="runs-empty">
              Nothing matched “{query}”. Only repositories containing GGUF files are searched, since
              those are the ones Karen can run.
            </p>
          ) : (
            <ul className="results">
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="result-title"
                    onClick={() => void expand(m.id)}
                    aria-expanded={open === m.id}
                  >
                    {m.id}
                  </button>
                  <p className="result-links">
                    {m.downloads !== undefined ? (
                      <span className="pill">{m.downloads.toLocaleString()} downloads</span>
                    ) : null}
                    {m.likes !== undefined ? <span className="pill">{m.likes} likes</span> : null}
                    {m.gated ? <span className="pill open">licence required</span> : null}
                  </p>
                  {open === m.id ? (
                    <Files repo={m.id} files={files[m.id]} onPick={download} checking={checking} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Files({
  repo,
  files,
  onPick,
  checking,
}: {
  repo: string;
  files: HfFileChoice[] | { error: string } | undefined;
  onPick: (repo: string, choice: HfFileChoice) => Promise<void>;
  checking: string | undefined;
}) {
  if (!files) return <p className="hint">Looking at what this model offers…</p>;
  if ("error" in files) return <p className="run-error">{files.error}</p>;
  if (files.length === 0) return <p className="hint">This repository has no GGUF files.</p>;

  return (
    <ul className="quant-list">
      {files.map((f) => (
        <li key={f.entry}>
          <div className="model-row">
            <span className="model-name">{f.quant ?? f.label}</span>
            <span className="dim">{gb(f.size)}</span>
            {f.parts.length > 1 ? <span className="pill">{f.parts.length} files</span> : null}
          </div>
          <p className={`fit fit-${f.fit.verdict}`}>{f.fit.label}</p>
          <button
            type="button"
            disabled={f.fit.verdict === "too-large" || checking !== undefined}
            onClick={() => void onPick(repo, f)}
          >
            {f.fit.verdict === "too-large"
              ? "Too large for this machine"
              : checking === f.entry
                ? "Checking…"
                : "Download"}
          </button>
        </li>
      ))}
    </ul>
  );
}
