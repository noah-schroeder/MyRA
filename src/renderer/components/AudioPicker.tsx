import { useEffect, useRef, useState } from "react";
import type { AudioOption, AudioProgress, AudioRole, Settings } from "../types.ts";
import { shortModelName as shorten } from "../../core/runtime/foreign.ts";
import { modelNamer } from "../../core/models/roles.ts";
import { describeVoice } from "../../core/audio/voices.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { engineStates, type Runnable } from "../../core/runtime/runnable.ts";
import { choiceIsExternal, parseModelRef } from "../../core/providers.ts";

/**
 * Which model listens, and which one speaks.
 *
 * Built to be the same control as the chat model picker rather than a settings
 * row, because it answers the same question and people ask it at the same
 * moment: you find out you want a bigger Whisper while you are dictating, not
 * while you are in Settings. It borrows that picker's classes deliberately —
 * three dropdowns on one bar that looked like three different kinds of control
 * would be worse than any one of them.
 *
 * The list is not only what is downloaded. Lemonade will pull a model on the
 * first request that names it — measured at 19.7 s for Kokoro's 354 MB — so
 * hiding the catalogue would leave someone with no speech model looking at an
 * empty menu and no way out of it. What is here is marked, what is not shows
 * its size, and choosing the latter downloads it in front of you rather than in
 * the middle of your first sentence.
 */

/*
 * `empty` is the same words in every picker, matching the chat bar.
 *
 * Four bars sat side by side saying "No model yet", "No speech model yet",
 * "No voice yet" and "No image model yet", which reads as four different
 * states rather than one. Each picker's own `title` says which model it is
 * for, so the empty label does not have to.
 */
const ROLE_COPY: Record<AudioRole, { empty: string; none: string; title: string }> = {
  transcription: {
    empty: "None selected",
    none: "Nothing here can turn speech into text yet.",
    title: "Which model turns your voice into text",
  },
  voice: {
    empty: "None selected",
    none: "Nothing here can speak yet.",
    title: "Which model reads answers aloud",
  },
};

export function AudioPicker({
  role,
  settings,
  onSettingsChange,
  onOpenSettings,
}: {
  role: AudioRole;
  settings: Settings | undefined;
  onSettingsChange: (s: Settings) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AudioOption[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [progress, setProgress] = useState<AudioProgress | undefined>();
  /* Which engines are installed, asked alongside the options and for the same
     reason: a row that needs an engine nobody has installed should say so
     before it is chosen, not after a multi-gigabyte download. */
  const [engines, setEngines] = useState<Map<string, Runnable>>(new Map());
  const wrap = useRef<HTMLDivElement>(null);

  const chosen = role === "transcription"
    ? settings?.audio.transcriptionModel ?? ""
    : settings?.audio.voiceModel ?? "";

  useEffect(() => window.karen.onAudioProgress((p) => setProgress(p)), []);

  // Asked when the menu opens, like the chat picker: the answer changes as
  // models are downloaded, and polling for a dropdown nobody has opened is
  // work done on the chance it will be looked at.
  useEffect(() => {
    if (!open) return;
    void window.karen.audioModels(role).then((r) => {
      setOptions(r.options);
      setError(r.ok ? undefined : r.error);
    });
    /* Best effort, and silent when it fails: not knowing which engines are
       installed costs a warning, while blocking the menu on it would cost the
       menu. */
    void window.karen.lemonadeInfo().then((r) => {
      if (r.ok && r.info) setEngines(engineStates(r.info.engines));
    });
  }, [open, role]);

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
  /* Anything the daemon is actually holding for this role. Usually the chosen
     model, but not always: switch from Whisper-Large to Whisper-Base and the
     large one is still resident until something lets go of it. */
  const resident = options.filter((o) => o.where === "local" && o.loaded);

  /**
   * Let go of a loaded model without forgetting the choice.
   *
   * Deliberately does not clear the setting: "I want the memory back now" and
   * "I no longer want this model" are different intentions, and the second is
   * what the dropdown itself is for. The next dictation loads it again.
   */
  const eject = async (option: AudioOption): Promise<void> => {
    setBusy(option.ref);
    setError(undefined);
    const result = await window.karen.audioUnload(option.model);
    setBusy(undefined);
    if (!result.ok) setError(result.error);
    void window.karen.audioModels(role).then((r) => setOptions(r.options));
  };

  /**
   * Choose one, and put it in memory if it is a local one.
   *
   * The setting is saved BEFORE the load, and that order matters: a 3 GB
   * download that fails or is quit halfway through should still leave the
   * choice made, so the next attempt resumes rather than starting from a
   * dropdown that forgot what was asked for.
   */
  const choose = async (option: AudioOption): Promise<void> => {
    setError(undefined);
    /* Spread over the current block rather than sent as one field: the main
       process merges the audio settings, but a caller that sends a fragment is
       relying on that merge, and the types say the block is a block. */
    const audio = {
      ...settings!.audio,
      ...(role === "transcription" ? { transcriptionModel: option.ref } : { voiceModel: option.ref }),
    };
    onSettingsChange(await window.karen.updateSettings({ audio }));

    if (option.where !== "local") {
      setOpen(false);
      return;
    }

    setBusy(option.ref);
    setProgress(undefined);
    const result = await window.karen.audioLoad(option.model);
    setBusy(undefined);
    setProgress(undefined);
    if (!result.ok) setError(result.error);
    else setOpen(false);
  };

  /* `parseModelRef`, not a split on a separator written out by hand: the
     qualifier is "::" precisely because model ids contain "/" and ":" all the
     time, and a second copy of that rule here would be the place it drifts. */
  /* The same naming the menu uses, so the button cannot say "SD-Turbo" while
     the menu behind it shows that name is taken by two different downloads. */
  const named = modelNamer(options.map((o) => o.model), shorten);
  const label = chosen
    ? named(chosenOption?.model ?? parseModelRef(chosen).model)
    : ROLE_COPY[role].empty;
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

  const ejectRow = resident.length ? (
    <div className="modelmenu-eject">
      {resident.map((option) => (
        <button
          key={option.ref}
          type="button"
          role="menuitem"
          disabled={Boolean(busy)}
          onClick={() => void eject(option)}
        >
          Eject {option.model}
          <span className="dim"> — frees the memory it is holding</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="modelbar-wrap audiobar-wrap" ref={wrap}>
      <button
        type="button"
        className={`modelbar audiobar tone-${tone}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ROLE_COPY[role].title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="audiobar-icon" aria-hidden="true">
          {role === "transcription" ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 5 6 9H2v6h4l5 4V5Z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
            </svg>
          )}
        </span>
        <span className="modelbar-name">{label}</span>
        {busy ? <span className="modelbar-where">{progress?.bytesTotal ? `${Math.round(progress.percent)}%` : "…"}</span> : null}
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
          engines={engines}
          emptyText={ROLE_COPY[role].none}
          externalWarning={
            role === "transcription"
              ? "Recordings sent here leave your computer."
              : "Whatever Karen says aloud is sent here to be spoken."
          }
          onChoose={(option) => void choose(option)}
          footer={
            <>
              {/* Above the settings link, because it acts on what is loaded
                  right now and the link goes somewhere else. */}
              {ejectRow}
              {/* The voice itself is chosen in Settings, where it can be
                  previewed. Naming it here is what stops the chat bar looking
                  like it forgot about it. */}
              {role === "voice" && chosen ? (
                <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }}>
                  Voice: {describeVoice(settings?.audio.voice ?? "").name || "the model's default"}
                  <span className="dim"> — change it in Settings</span>
                </button>
              ) : (
                <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }}>
                  Audio settings…
                </button>
              )}
            </>
          }
        />
      ) : null}

      {external ? (
        <span className="modelbar-external" role="note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          {role === "transcription" ? "Recordings leave this machine" : "Replies are sent away to be spoken"}
        </span>
      ) : null}
    </div>
  );
}
