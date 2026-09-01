import { useEffect, useRef, useState } from "react";
import type { LocalModel, RuntimeState, Settings } from "../types.ts";
import {
  displayModelName, filterModels, shortModelName as shorten, SOURCE_LABELS, sourceOfModel,
} from "../../core/runtime/foreign.ts";
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
  /* Cleared every time the menu opens. A filter left over from last time would
     hide most of the list with no obvious reason why. */
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.karen.runtimeState().then(setRuntime);
    return window.karen.onRuntime(setRuntime);
  }, []);

  // Only when the menu opens. Lemonade answers from what it has registered,
  // which is cheap, but there is no reason to ask on every render of the bar.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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

  const defaultModel = runtime?.config.defaultModel;

  /**
   * Set or clear the model that loads at startup.
   *
   * A toggle rather than a one-way choice: someone who set a default six months
   * ago and has since deleted that model needs a way out that is not editing
   * runtime.json.
   */
  const makeDefault = async (path: string): Promise<void> => {
    const next = defaultModel === path ? undefined : path;
    setRuntime(await window.karen.runtimeConfig({ defaultModel: next }).then(
      (config) => (runtime ? { ...runtime, config } : runtime),
    ));
  };

  const shown = filterModels(models, query);

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
                /* States the ceiling without claiming how the current size was
                   arrived at: it may be Lemonade's auto-tune or a size set by
                   hand under Models → Tune, and this cannot tell which. */
                active.maxContextTokens && active.maxContextTokens > active.contextTokens
                  ? `This model supports up to ${active.maxContextTokens.toLocaleString("en-GB")}.`
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

          {/* Shown once there are enough models that scrolling is the slow way
              to find one. Below that it is a box to ignore. */}
          {models.length > 6 ? (
            <input
              className="modelmenu-search"
              type="search"
              value={query}
              autoFocus
              placeholder="Filter by name or publisher"
              aria-label="Filter models"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter loads the only thing left, which is what filtering down
                // to one thing is for.
                if (e.key === "Enter" && shown[0]) void load(shown[0].path);
              }}
            />
          ) : null}

          {models.length === 0 ? (
            <p className="modelmenu-empty">
              {runtime?.lemonade.state === "ready"
                ? "No models downloaded yet."
                : "The local engine is not running yet, so nothing can run here."}
            </p>
          ) : shown.length === 0 ? (
            <p className="modelmenu-empty">
              Nothing here matches “{query.trim()}”. {models.length} models downloaded.
            </p>
          ) : (
            <ul className="modelmenu-list">
              {shown.map((m) => {
                const isActive = m.path === activePath;
                const isDefault = m.path === defaultModel;
                return (
                  <li key={m.path} className="modelmenu-row">
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
                    {/* A sibling, not a child: a button inside a button is
                        invalid, and clicking "make this the default" must not
                        also load several gigabytes. */}
                    <button
                      type="button"
                      className={isDefault ? "modelmenu-default on" : "modelmenu-default"}
                      aria-pressed={isDefault}
                      title={
                        isDefault
                          ? "Loads when Karen starts. Click to stop."
                          : "Load this one when Karen starts"
                      }
                      onClick={() => void makeDefault(m.path)}
                    >
                      {isDefault ? "★" : "☆"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Said once, under the list, rather than repeated on every starred
              row -- and only when it would otherwise be a lie. */}
          {defaultModel && !runtime?.config.startOnLaunch ? (
            <p className="modelmenu-note">
              A starred model loads at startup only while “Start the local engine when Karen
              opens” is on, under Endpoints and runtime.
            </p>
          ) : null}

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
