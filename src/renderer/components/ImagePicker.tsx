import { useEffect, useRef, useState } from "react";
import type { AudioProgress, ModelOption, Settings } from "../types.ts";
import { shortModelName as shorten } from "../../core/runtime/foreign.ts";
import { modelNamer } from "../../core/models/roles.ts";
import { choiceIsExternal, parseModelRef } from "../../core/providers.ts";
import { ModelMenu } from "./ModelMenu.tsx";

/**
 * Which model draws.
 *
 * The same control as the chat and audio pickers, sharing their classes and
 * their menu, because it answers the same kind of question. It differs from
 * them in one way that is deliberate: it appears only on the Images page. The
 * top bar says which model is doing the thing on this screen, and a picker for
 * a model that nothing on the current screen would call is a control that does
 * nothing sitting next to one that does.
 *
 * The list is not only what is downloaded, for the reason the audio picker
 * gives: Lemonade pulls a model on the first request that names it, so hiding
 * the catalogue would leave someone with no image model looking at an empty
 * menu and no way out of it. A diffusion model additionally needs the `sd-cpp`
 * engine, which the model hub installs -- so the footer goes there rather than
 * to Settings.
 */

export function ImagePicker({
  settings,
  onSettingsChange,
  onOpenHub,
}: {
  settings: Settings | undefined;
  onSettingsChange: (s: Settings) => void;
  onOpenHub: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<AudioProgress | undefined>();
  const wrap = useRef<HTMLDivElement>(null);

  const chosen = settings?.image.model ?? "";

  useEffect(() => window.karen.onImageProgress((p) => setProgress(p)), []);

  // Asked when the menu opens, like the other pickers: the answer changes as
  // models are downloaded, and polling for a dropdown nobody has opened is
  // work done on the chance it will be looked at.
  useEffect(() => {
    if (!open) return;
    void window.karen.imageModels().then((r) => {
      setOptions(r.options);
      setError(r.ok ? undefined : r.error);
    });
  }, [open]);

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

  const chosenOption = options.find((o) => o.ref === chosen);

  /**
   * Choose one, and put it in memory if it is a local one.
   *
   * The setting is saved BEFORE the load, and that order matters: a multi-
   * gigabyte download that fails or is quit halfway through should still leave
   * the choice made, so the next attempt resumes rather than starting from a
   * dropdown that forgot what was asked for.
   */
  const choose = async (option: ModelOption): Promise<void> => {
    setError(undefined);
    onSettingsChange(await window.karen.updateSettings({ image: { ...settings!.image, model: option.ref } }));

    if (option.where !== "local") {
      setOpen(false);
      return;
    }

    setBusy(option.ref);
    setProgress(undefined);
    const result = await window.karen.imageLoad(option.model);
    setBusy(undefined);
    setProgress(undefined);
    if (!result.ok) setError(result.error);
    else setOpen(false);
  };

  /* The same naming the menu uses, so the button cannot say "SD-Turbo" while
     the menu behind it shows that name is taken by two different downloads. */
  const named = modelNamer(options.map((o) => o.model), shorten);
  const label = chosen
    ? named(chosenOption?.model ?? parseModelRef(chosen).model)
    : "No image model yet";
  /*
   * Asked of the settings, not of the fetched options.
   *
   * The options list is only fetched when the menu OPENS, so before anyone has
   * opened it `chosenOption` is undefined -- and reading externality off it
   * made the bar say "local", in the app's own colour for "this stays on your
   * machine", about a model every prompt is being sent to a provider for.
   * `choiceIsExternal` answers from the providers already in hand, needs no
   * request, and is the same function the chat bar uses, so the two cannot
   * disagree about the only claim this app really makes.
   */
  const external = choiceIsExternal(settings?.providers ?? [], chosen);
  const tone = !chosen ? "none" : external ? "remote" : "local";

  return (
    <div className="modelbar-wrap audiobar-wrap" ref={wrap}>
      <button
        type="button"
        className={`modelbar audiobar tone-${tone}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Which model draws the pictures"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="audiobar-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m4 17 5-5 4 4 2.5-2.5L20 17" />
          </svg>
        </span>
        <span className="modelbar-name">{label}</span>
        {busy ? (
          <span className="modelbar-where">
            {progress?.bytesTotal ? `${Math.round(progress.percent)}%` : "…"}
          </span>
        ) : null}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {busy ? (
        <div className="modelbar-progress" role="progressbar" aria-label="Preparing the model">
          <span className="modelbar-progress-run" />
        </div>
      ) : null}

      {open ? (
        <ModelMenu
          options={options}
          chosen={chosen}
          busy={busy}
          progress={progress}
          error={error}
          emptyText="Nothing here can make pictures yet."
          externalWarning="Prompts sent here leave your computer."
          onChoose={(option) => void choose(option)}
          footer={
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenHub(); }}>
              Find image models…
              <span className="dim"> — these need the Stable Diffusion engine</span>
            </button>
          }
        />
      ) : null}

      {external ? (
        <span className="modelbar-external" role="note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          Prompts leave this machine
        </span>
      ) : null}
    </div>
  );
}
