import { useEffect, useRef, useState } from "react";
import type { LocalModel, Provider, RuntimeState, Settings } from "../types.ts";
import {
  displayModelName, filterModels, shortModelName as shorten, SOURCE_LABELS, sourceOfModel,
} from "../../core/runtime/foreign.ts";
import { formatTokens } from "../../core/tokens.ts";
import { fitsRole, localFitsChat } from "../../core/models/roles.ts";
import { choiceIsExternal, isExternal, parseModelRef, qualify } from "../../core/providers.ts";
import { priceLabel, priceTitle } from "../../core/pricing.ts";

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
  onSettingsChange,
}: {
  settings: Settings | undefined;
  onOpenSettings: () => void;
  onOpenHub: () => void;
  /* Choosing a hosted model is a settings change made from the chat screen, so
     the change has to reach the app and not only this menu. */
  onSettingsChange: (s: Settings) => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeState | undefined>();
  const [models, setModels] = useState<LocalModel[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /* Cleared every time the menu opens. A filter left over from last time would
     hide most of the list with no obvious reason why. */
  const [query, setQuery] = useState("");
  /*
   * Which tab is showing: "local", or a provider's id.
   *
   * It was "local" or "external", which put OpenRouter and Anthropic behind one
   * word that names neither of them. Somebody who has connected two providers
   * is choosing between those two providers, not between here and away -- and
   * "External" also has to cover a provider on 127.0.0.1, which is not external
   * at all. One tab per place answers the question actually being asked.
   */
  const [pane, setPane] = useState<string>("local");
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

  /*
   * Open on the tab the current model actually came from.
   *
   * Always opening on "local" meant that someone using Claude opened the picker
   * onto a list their choice was not in, with no indication that the row saying
   * "in use" was one tab across. Reading it from the stored ref rather than from
   * a remembered tab is what keeps it right after the model is changed from
   * somewhere else -- Settings, or the first-run flow.
   */
  useEffect(() => {
    if (!open) return;
    /* `||`, not `??`: parseModelRef returns an empty string for an unqualified
       ref rather than undefined, and `?? "local"` left the pane set to "" --
       which matches no tab, so the menu opened with none of them lit. */
    setPane(parseModelRef(settings?.llm.model ?? "").providerId || "local");
  }, [open, settings?.llm.model]);

  useEffect(() => {
    if (open) {
      void window.karen.lemonadeModels().then((r) =>
        setModels(
          r.models
            /* Chat models only. Karen serves speech, voice and diffusion
               models through the same daemon and the same /models listing, so
               without this the conversation picker offered Whisper and Kokoro
               as things to talk to -- and picking one produces a request the
               engine answers with an error, if it answers at all. The labels
               are the daemon's own; MEDIA_LABELS is what they are checked
               against. */
            .filter((m) => localFitsChat(m.id, m.labels))
            /* `path` stays the real id -- it is what `load` is called with --
               while `name` is what a person recognises. */
            .map((m) => ({ path: m.id, name: displayModelName(m.id) })),
        ));
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

  const providers = (settings?.providers ?? []).filter((p) => p.enabled && p.models.length);
  /* Which of a provider's models are offered as things to talk to, and which
     wait behind a click. Same guess, same escape hatch, as every other picker:
     a provider publishes ids and no capabilities, so `whisper-1` and `tts-1`
     were being offered as models to hold a conversation with. */
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const shownModels = (provider: Provider): string[] =>
    showAll.has(provider.id)
      ? provider.models
      : provider.models.filter(
          (m) => fitsRole(m, "chat") || settings?.llm.model === qualify(provider.id, m),
        );
  const hiddenCount = (provider: Provider): number =>
    provider.models.length - shownModels(provider).length;

  /* The provider whose tab is open, if it is still there. A provider removed or
     switched off while the menu was up leaves the pane naming nothing, and
     falling back to the local list is better than an empty panel. */
  const shownProvider = providers.find((p) => p.id === pane);

  const chosenExternal = choiceIsExternal(settings?.providers ?? [], settings?.llm.model ?? "");
  /*
   * Whether a PROVIDER model is chosen at all, which is not the same question.
   *
   * The bar used to branch on "is the choice external", and a provider on
   * 127.0.0.1 -- somebody's own llama.cpp or LM Studio, registered here rather
   * than run by Karen -- is deliberately not external: destinations.ts calls an
   * address on this machine local whatever the provider's label says. So the
   * external branch was skipped, the local branch wanted a model Karen had
   * loaded itself, and the bar said "No model yet" while every message went to
   * that provider and came back answered.
   */
  const chosenProvider = Boolean(parseModelRef(settings?.llm.model ?? "").providerId);

  /**
   * Choose a hosted model.
   *
   * Stored provider-qualified, which is what lets the main process route it
   * without guessing, and what makes "the provider this came from was deleted"
   * a question with an answer.
   */
  const pick = async (providerId: string, model: string): Promise<void> => {
    setOpen(false);
    onSettingsChange(
      await window.karen.updateSettings({ llm: { ...settings!.llm, model: qualify(providerId, model) } }),
    );
  };

  const backend = runtime?.lemonade;
  const usingLocal = runtime?.config.useForChat === true;
  /* `chat` rather than `loaded`: the latter is `model_loaded`, the model the
     daemon touched LAST, which is a speech model for most of a session that
     uses dictation -- and is empty on a daemon that has never been asked for
     anything, even while holding a chat model. */
  const local = usingLocal && backend?.state === "ready" && Boolean(backend.chat);
  const loading = usingLocal && backend?.state === "starting";
  /*
   * The model chat would actually use, decided by the main process.
   *
   * Not `config.activeModel`, which is a record of what was last loaded: a
   * dictation or a voice reply left Whisper and Kokoro sitting in the
   * conversation's picker as though they were the model answering. This field
   * comes from the same call that builds the chat request, so the bar cannot
   * name one thing while messages go to another -- and when it is empty,
   * "None selected" is the truth.
   */
  const activePath = backend?.chat?.id;
  const resident = backend?.resident ?? [];
  const active = backend?.active;

  let label: string;
  let tone: "local" | "remote" | "loading" | "none";

  if (loadingModel) {
    label = `Loading ${shorten(loadingModel)}…`;
    tone = "loading";
  } else if (loading) {
    label = "Starting the local engine…";
    tone = "loading";
  } else if (chosenProvider) {
    /* Ahead of the loaded local model, matching how the request is actually
       routed: a provider choice wins, so the bar must not keep naming whatever
       happens to be resident. The tone still follows where the request goes,
       so a provider on this machine reads as local. */
    label = shorten(parseModelRef(settings?.llm.model ?? "").model);
    tone = chosenExternal ? "remote" : "local";
  } else if (local && activePath) {
    label = shorten(activePath);
    tone = "local";
  } else if (settings?.llm.baseUrl) {
    // Someone else's server. Name the model when one is pinned, the host when
    // it is not — "(server default)" is true and tells you nothing.
    label = settings.llm.model?.trim() || new URL(settings.llm.baseUrl).host;
    tone = "remote";
  } else {
    label = "None selected";
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
          {/* Only when there is a second place to look. With no providers set
              up the tabs would be a control with one option, which teaches the
              user nothing and costs a row of the menu. */}
          {providers.length ? (
            <div className="modelmenu-tabs" role="tablist" aria-label="Where models come from">
              <button
                type="button"
                role="tab"
                aria-selected={pane === "local"}
                className={pane === "local" ? "modelmenu-tab on" : "modelmenu-tab"}
                onClick={() => setPane("local")}
              >
                Local
              </button>
              {/* Named, one each. A person who has connected OpenRouter and
                  Anthropic picks between OpenRouter and Anthropic; "External"
                  was a word for neither of them, and one they would have had to
                  open to find out which was behind it. */}
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={pane === provider.id}
                  className={pane === provider.id ? "modelmenu-tab on" : "modelmenu-tab"}
                  title={provider.baseUrl}
                  onClick={() => setPane(provider.id)}
                >
                  {provider.label || provider.id}
                </button>
              ))}
            </div>
          ) : null}

          {shownProvider ? (
            <div className="modelmenu-external">
              {/* Said for this provider, not for all of them at once: a
                  provider on 127.0.0.1 -- somebody's own llama.cpp or LM Studio
                  -- sends nothing anywhere, and warning about it would teach
                  people to ignore the warning that matters. */}
              {isExternal(shownProvider) ? (
                <p className="modelmenu-warn" role="note">
                  Anything you send to {shownProvider.label || "this provider"} leaves your
                  computer, including whatever is already in the conversation.
                </p>
              ) : (
                <p className="modelmenu-here" role="note">
                  {shownProvider.label || "This provider"} is served from this machine, so nothing
                  you send it leaves.
                </p>
              )}
              <ul className="modelmenu-list">
                {shownModels(shownProvider).map((model) => {
                  const on = settings?.llm.model === qualify(shownProvider.id, model);
                  return (
                    <li key={model} className="modelmenu-row">
                      <button
                        type="button"
                        role="menuitem"
                        className={on ? "modelmenu-item active" : "modelmenu-item"}
                        onClick={() => void pick(shownProvider.id, model)}
                      >
                        <span className="modelmenu-name">{model}</span>
                        <span className="modelmenu-meta">
                          {/* The provider's own figure, from the last time
                              its models were fetched. Absent for the many
                              endpoints that publish no prices, because the
                              alternative would be a number Karen made up. */}
                          {shownProvider.prices?.[model] ? (
                            <span
                              className="modelmenu-price"
                              title={priceTitle(shownProvider.prices[model])}
                            >
                              {priceLabel(shownProvider.prices[model])}
                            </span>
                          ) : null}
                          {on ? <span className="pill on">in use</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {shownModels(shownProvider).length === 0 && !hiddenCount(shownProvider) ? (
                <p className="modelmenu-empty">
                  This provider published no models the last time it was asked. Check it under
                  Settings → Providers.
                </p>
              ) : null}
              {hiddenCount(shownProvider) && !showAll.has(shownProvider.id) ? (
                <button
                  type="button"
                  className="modelmenu-more"
                  onClick={() => setShowAll((seen) => new Set(seen).add(shownProvider.id))}
                >
                  {shownModels(shownProvider).length
                    ? `Show ${hiddenCount(shownProvider)} more from this provider`
                    : `Nothing here looks right for a conversation — show all ${hiddenCount(shownProvider)}`}
                </button>
              ) : null}
              <div className="modelmenu-foot">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  Manage providers…
                </button>
              </div>
            </div>
          ) : (
          <>
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
              opens” is on, under Settings → Runtime.
            </p>
          ) : null}

          <div className="modelmenu-foot">
            {/*
              * One row per model the daemon is holding, each naming what it
              * frees.
              *
              * It was a single "Eject model" that called unload with no
              * argument -- so on a daemon holding a chat model, a Whisper and
              * a Kokoro it was a button whose effect you could not predict,
              * and it disappeared entirely while a hosted model was chosen,
              * which is exactly when a local one is sitting in memory doing
              * nothing. Naming each one is the same answer the speech menus
              * already give.
              */}
            {resident.map((model) => (
              <button
                key={model}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void window.karen.unloadModel(model);
                }}
              >
                Eject {shorten(model)}
                <span className="dim"> — frees the memory it is holding</span>
              </button>
            ))}
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
                : "Providers and runtime…"}
            </button>
          </div>
          </>
          )}
        </div>
      ) : null}

      {/*
        * Beside the picker, not inside the menu.
        *
        * The menu is where the choice is made; this is where it is LIVED WITH.
        * Someone who picked a hosted model twenty minutes ago and is now
        * pasting an interview transcript into the composer is exactly the
        * person this is for, and they are not looking at the menu.
        *
        * Drawn from the same function the main process routes with, so it
        * cannot say "local" about a request that is about to leave.
        */}
      {chosenExternal ? (
        <span className="modelbar-external" role="note" title="Change this in the model picker, or under Settings → Providers.">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          External model — what you send goes to another system
        </span>
      ) : null}

      {error ? <span className="modelbar-error">{error}</span> : null}
    </div>
  );
}
