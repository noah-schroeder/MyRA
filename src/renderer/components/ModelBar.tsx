import { useEffect, useRef, useState } from "react";
import type { LocalModel, RuntimeState, Settings } from "../types.ts";
import { displayModelName, SOURCE_LABELS, sourceOfModel } from "../../core/runtime/foreign.ts";
import { formatTokens } from "../../core/tokens.ts";

/**
 * Which model is answering — and, now, which one answers next.
 *
 * It began as a label, because nothing on screen said where answers came from:
 * Karen will happily talk to a model served from this machine, a box on the
 * LAN, or a hosted API, and the only way to find out which was to open
 * Settings. That made "why is this slow" and "why does this sound different
 * today" questions with no visible answer.
 *
 * Switching models is the same question asked forward, so it belongs in the
 * same control rather than three clicks away in a settings tab. Ejecting is
 * here for the reason it exists at all: a loaded model is several gigabytes of
 * resident memory, and someone who has stopped chatting should be able to have
 * that back without quitting the app.
 */

function shorten(model: string): string {
  // Repository paths, index prefixes and quantisation suffixes are most of the
  // length and least of the meaning: `lmstudio__LFM2.5-8B-A1B` is "LFM2.5-8B-A1B",
  // and unsloth/Qwen3-Coder-30B-…-GGUF is "Qwen3-Coder-30B".
  const named = displayModelName(model);
  const base = named.slice(named.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
  return base.replace(/-(GGUF|(?:IQ|TQ|Q)\d+[\w.]*|BF16|F16|F32)$/i, "");
}

function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function ModelBar({
  settings,
  onOpenSettings,
  onOpenHub,
}: {
  settings: Settings | undefined;
  onOpenSettings: () => void;
  onOpenHub: () => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | undefined>();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.karen.runtimeState().then(setRuntime);
    return window.karen.onRuntime(setRuntime);
  }, []);

  // Only when the menu opens. Lemonade answers from what it has registered,
  // which is cheap, but there is no reason to ask on every render of the bar.
  useEffect(() => {
    if (open) {
      void window.karen.lemonadeModels().then((r) =>
        /* `path` stays the real id -- it is what `load` is called with --
           while `name` is what a person recognises. */
        setModels(r.models.map((m) => ({ path: m.id, name: displayModelName(m.id) }))));
    }
  }, [open]);

  /* Close on a click anywhere else, and on Escape -- a popover that can only be
     dismissed by hitting the button again is a popover people leave open. */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  /* Ticks only while a load is in flight. A bar with no numbers on it looks
     the same at two seconds and at ninety, and the difference is the whole
     question a person has while waiting. */
  const [elapsed, setElapsed] = useState(0);
  const loadingModel = runtime?.lemonade.loading;
  useEffect(() => {
    if (!loadingModel) {
      setElapsed(0);
      return undefined;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [loadingModel]);

  const backend = runtime?.lemonade;
  const usingLocal = runtime?.config.useForChat === true;
  const local = usingLocal && backend?.state === "ready" && Boolean(backend.loaded);
  const loading = usingLocal && backend?.state === "starting";
  const activePath = runtime?.config.activeModel;
  const active = backend?.active;

  let label: string;
  let tone: "local" | "remote" | "loading" | "none";

  if (loadingModel) {
    label = `Loading ${shorten(loadingModel)}…`;
    tone = "loading";
  } else if (loading) {
    label = "Starting the local engine…";
    tone = "loading";
  } else if (local && activePath) {
    label = shorten(activePath);
    tone = "local";
  } else if (settings?.llm.baseUrl) {
    // Someone else's server. Name the model when one is pinned, the host when
    // it is not — "(server default)" is true and tells you nothing.
    label = settings.llm.model?.trim() || new URL(settings.llm.baseUrl).host;
    tone = "remote";
  } else {
    label = "No model yet";
    tone = "none";
  }

  const load = async (path: string): Promise<void> => {
    setError(undefined);
    setOpen(false);
    const result = await window.karen.lemonadeLoad(path);
    if (!result.ok && result.error) setError(result.error);
  };

  return (
    <div className="modelbar-wrap" ref={wrap}>
      <button
        type="button"
        className={`modelbar tone-${tone}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          tone === "local"
            ? `Running on this machine. ${runtime?.lemonade.loaded ?? ""}`.trim()
            : tone === "remote"
              ? `Answering from ${settings?.llm.baseUrl}`
              : "Choose where Karen gets its answers"
        }
      >
        <span className={`dot dot-${tone === "local" ? "ready" : tone === "loading" ? "starting" : "idle"}`} />
        <span className="modelbar-name">{label}</span>
        {tone === "loading" ? <span className="modelbar-where">{elapsed}s</span> : null}
        {/* The proof that it loaded, and how much room there is. `ctx_size` is
            what llama.cpp was actually started with; the model's own ceiling is
            usually far larger, so both are shown rather than the flattering
            one. */}
        {tone === "local" && active?.contextTokens ? (
          <span
            className="modelbar-ctx"
            title={
              [
                /* The exact figure, always -- the chip abbreviates only when
                   the abbreviation is exact, and this says it in full either
                   way. */
                `${active.contextTokens.toLocaleString("en-GB")} tokens of context, ` +
                  (active.contextFrom === "server"
                    ? "measured from the running server."
                    : "as reported by Lemonade."),
                active.maxContextTokens && active.maxContextTokens > active.contextTokens
                  ? `This model supports up to ${active.maxContextTokens.toLocaleString("en-GB")}; Lemonade auto-tuned it down.`
                  : "",
                active.device ? `Running on the ${active.device === "gpu" ? "GPU" : "processor"}.` : "",
              ]
                .filter(Boolean)
                .join(" ")
            }
          >
            {formatTokens(active.contextTokens)} context
            {active.device ? ` · ${active.device === "gpu" ? "GPU" : "CPU"}` : ""}
          </span>
        ) : null}
        {tone === "local" && !active?.contextTokens ? (
          <span className="modelbar-where">on this machine</span>
        ) : null}
        {tone === "none" ? <span className="modelbar-where">set one up</span> : null}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Indeterminate on purpose. `/load` reports nothing until it returns, so
          a filling bar would be an invented number; this says "still working"
          and the seconds beside it say how long. */}
      {tone === "loading" ? (
        <div className="modelbar-progress" role="progressbar" aria-label="Loading the model">
          <span className="modelbar-progress-run" />
        </div>
      ) : null}

      {open ? (
        <div className="modelmenu" role="menu">
          <p className="modelmenu-head">On this machine</p>

          {models.length === 0 ? (
            <p className="modelmenu-empty">
              {runtime?.lemonade.state === "ready"
                ? "No models downloaded yet."
                : "The local engine is not running yet, so nothing can run here."}
            </p>
          ) : (
            <ul className="modelmenu-list">
              {models.map((m) => {
                const isActive = m.path === activePath;
                return (
                  <li key={m.path}>
                    <button
                      type="button"
                      role="menuitem"
                      className={isActive ? "modelmenu-item active" : "modelmenu-item"}
                      onClick={() => void load(m.path)}
                      /* A model whose header says it will not fit is still
                         offered: the fit is an estimate of speed, not a lock,
                         and refusing to try is not ours to decide. */
                      title={m.fit?.label}
                    >
                      <span className="modelmenu-name">{shorten(m.name)}</span>
                      <span className="modelmenu-meta">
                        {m.size ? gb(m.size) : null}
                        {isActive && local ? <span className="pill on">loaded</span> : null}
                        {isActive && loading ? <span className="pill warn">loading</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="modelmenu-foot">
            {local || loading ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void window.karen.lemonadeUnload();
                }}
              >
                Eject model
                <span className="dim"> — frees the memory it is holding</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenHub();
              }}
            >
              Find and download models…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              {settings?.llm.baseUrl && !local
                ? `Endpoint: ${new URL(settings.llm.baseUrl).host}`
                : "Endpoints and runtime…"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <span className="modelbar-error">{error}</span> : null}
    </div>
  );
}
