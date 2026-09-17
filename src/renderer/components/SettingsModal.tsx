import { Fragment, useEffect, useState } from "react";
import type {
  AudioOption, AudioRole, AudioSource, PrivacyReport, Settings, UpdateCheckResult, VaultStatus,
} from "../types.ts";
import { enumerate } from "../capture.ts";
import { RuntimePane } from "./RuntimePane.tsx";
import { ProvidersPane } from "./ProvidersPane.tsx";
import { DatabaseKeysPane } from "./DatabaseKeysPane.tsx";
import { EndpointField } from "./EndpointField.tsx";
import { HotkeyField } from "./HotkeyField.tsx";
import { voicesFor } from "../../core/audio/voices.ts";
import { engineStates, runnable, type Runnable } from "../../core/runtime/runnable.ts";
import { modelIdOf } from "../../core/audio/models.ts";
import { DEFAULT_REVIEW_PROMPT, DEFAULT_STUDY_TYPES } from "../../core/review/prompt.ts";
import { DEFAULT_PERSONA } from "../../core/agent/systemPrompt.ts";

/**
 * Everything configurable, in one place.
 *
 * The product requirement is that the user never opens a JSON file, so anything
 * that can be set is set here. v1's pages for the bridge, the pairing code, the
 * GNOME keybinding and the network activity log are gone with the things they
 * configured.
 */

type Tab =
  | "providers" | "runtime" | "library" | "databases" | "storage" | "audio" | "appearance"
  | "permissions" | "persona" | "review" | "about";

/*
 * There was an "Endpoints" tab here, and Providers replaced it.
 *
 * It configured three things. The language model endpoint was the same job
 * Providers does and did it worse -- one endpoint, no model picking, no local
 * or external judgement, no key per vendor -- so two screens set where a
 * conversation goes and the one with fewer answers came first. The other two
 * have since gone the same way. Transcription is now a model chosen on the
 * Audio tab, from the same two sources every other model comes from, so nobody
 * has to know that the daemon on this machine answers at `/v1` and calls its
 * model `Whisper-Base`. Embeddings are the last one left, and they sit under
 * Providers because ranking search results is a provider question.
 */
const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "runtime", label: "Runtime" },
  { id: "library", label: "Zotero" },
  { id: "databases", label: "Database keys" },
  { id: "storage", label: "Folders" },
  { id: "audio", label: "Audio" },
  { id: "appearance", label: "Appearance" },
  { id: "permissions", label: "Permissions" },
  { id: "persona", label: "Persona" },
  { id: "review", label: "Peer review" },
  { id: "about", label: "About" },
];

export function SettingsModal({
  onClose,
  onChange,
  onOpenHub,
  initialTab,
}: {
  onClose: () => void;
  /* So the Models screen can send someone straight to Runtime when nothing
     there can run what they are about to download. */
  initialTab?: Tab;
  /* Models moved out of Settings and onto their own screen; the Runtime tab
   * points at it rather than keeping a second, drifting copy of the list. */
  onOpenHub?: () => void;
  /* Settings changed here have to reach the app, not just this dialog. The
   * theme made that obvious: the picker updated, and the window stayed dark. */
  onChange?: (s: Settings) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "providers");
  const [settings, setSettings] = useState<Settings | undefined>();
  const [vault, setVault] = useState<VaultStatus | undefined>();

  useEffect(() => {
    void window.myra.getSettings().then(setSettings);
    void window.myra.secretsBackend().then(setVault);
  }, []);

  const patch = async (changes: Partial<Settings>): Promise<void> => {
    const next = await window.myra.updateSettings(changes);
    setSettings(next);
    onChange?.(next);
  };

  if (!settings) return null;

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings">
        <header className="settings-head">
          <nav className="settings-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? "tab active" : "tab"}
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <div className="settings-body">
          {tab === "providers" ? (
            <ProvidersPane settings={settings} patch={patch} vault={vault} />
          ) : null}
          {tab === "runtime" ? <RuntimePane {...(onOpenHub ? { onOpenHub } : {})} /> : null}
          {tab === "library" ? <Library settings={settings} patch={patch} /> : null}
          {tab === "databases" ? <DatabaseKeysPane vault={vault} /> : null}
          {tab === "storage" ? <Folders settings={settings} patch={patch} /> : null}
          {tab === "audio" ? <Audio settings={settings} patch={patch} /> : null}
          {tab === "appearance" ? <Appearance settings={settings} patch={patch} /> : null}
          {tab === "permissions" ? <Permissions settings={settings} patch={patch} /> : null}
          {tab === "persona" ? <Persona settings={settings} patch={patch} /> : null}
          {tab === "review" ? <Review settings={settings} patch={patch} /> : null}
          {tab === "about" ? (
            <About
              onReplayTutorial={() => {
                // Closes the modal too -- the tour draws its own dim overlay,
                // and left open behind it, Settings would sit on top of that.
                void patch({ seenTutorial: false });
                onClose();
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- peer review */

/**
 * The reviewer's own standards, set up once.
 *
 * Editable in full, unlike the paper drafter's prompt, and that is a deliberate
 * difference rather than an inconsistency. The drafter's rules protect a reader
 * from a fabricated citation in a document that will carry the author's name;
 * they are not the author's to relax. A review is the reviewer's own writing
 * and their own judgement, journals ask for different things, and a reviewer
 * who cannot change the wording will paste it into something else instead.
 *
 * What the defaults still carry is the rule about not inventing literature,
 * stated in the text where it can be read rather than hidden where it cannot be
 * removed.
 */
function Review({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const types = settings.reviewStudyTypes ?? [];
  const [open, setOpen] = useState(types[0]?.id ?? "");

  const setReviewer = (typeId: string, reviewerId: string, instructions: string): void => {
    void patch({
      reviewStudyTypes: types.map((t) =>
        t.id === typeId
          ? {
              ...t,
              reviewers: t.reviewers.map((r) =>
                r.id === reviewerId ? { ...r, instructions } : r,
              ),
            }
          : t,
      ),
    });
  };

  return (
    <div className="pane">
      <p className="pane-note">
        What MyRA tells the model when it reviews a manuscript. Each study design has a panel of
        reviewers, and each reviewer is a separate request: the base instructions below are sent
        every time, that reviewer's own brief is added to them, and anything you type into the
        Peer review page is added after both.
      </p>

      <label className="field">
        <span className="field-label">Base instructions</span>
        <textarea
          rows={14}
          value={settings.reviewPrompt}
          onChange={(e) => void patch({ reviewPrompt: e.target.value })}
        />
      </label>
      <p className="pane-note">
        MyRA has not searched for anything at this point, so any reference the model produces
        here would be invented. The default text says so; if you rewrite it, keep that.
      </p>

      {/* One design at a time: five panels of three reviewers is fifteen
          thousand-word boxes, and a pane that opens on all of them is one
          nobody scrolls to the bottom of. */}
      <div className="review-types">
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.id === open ? "review-type on" : "review-type"}
            onClick={() => setOpen(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {types
        .filter((t) => t.id === open)
        .map((t) => (
          <Fragment key={t.id}>
            <p className="pane-note">
              {t.label} manuscripts are sent to these {t.reviewers.length} reviewers, each as a
              separate request carrying the whole manuscript.
            </p>
            {t.reviewers.map((r) => (
              <label className="field" key={r.id}>
                <span className="field-label">{r.label}</span>
                <textarea
                  rows={10}
                  value={r.instructions}
                  onChange={(e) => setReviewer(t.id, r.id, e.target.value)}
                />
              </label>
            ))}
          </Fragment>
        ))}

      <button
        type="button"
        className="ghost"
        onClick={() =>
          void patch({
            reviewPrompt: DEFAULT_REVIEW_PROMPT,
            reviewStudyTypes: DEFAULT_STUDY_TYPES.map((t) => ({ ...t })),
          })
        }
      >
        Restore the defaults
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- library */

/**
 * Zotero, and a straight answer about whether MyRA can read it.
 *
 * This tab exists because of one recurring report: "it says it cannot reach
 * Zotero", made by people whose Zotero is open in front of them. There are two
 * ways in and they fail for unrelated reasons — a switch inside Zotero for the
 * first, a folder MyRA has not looked in for the second — and a single line
 * saying the library is unreachable sends everybody to fix the wrong one.
 *
 * So both are shown, always, with what each of them found. The folder picker
 * is the fix for the second, and it is a picker rather than an environment
 * variable because the person who has moved their library to a second disk is
 * not going to be relaunching an app from a terminal to tell it so.
 */
function Library({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  type Status = Awaited<ReturnType<typeof window.myra.zoteroStatus>>;
  const [status, setStatus] = useState<Status | undefined>();
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await window.myra.zoteroStatus());
    } finally {
      setBusy(false);
    }
  };

  // Probed on open, because a panel whose whole job is to say what the state
  // is should not open saying nothing and wait to be asked.
  useEffect(() => void check(), []);

  const choose = async (): Promise<void> => {
    const picked = await window.myra.chooseDirectory({
      title: "The folder holding zotero.sqlite",
      current: settings.zoteroDataDir,
    });
    if (!picked) return;
    await patch({ zoteroDataDir: picked });
    await check();
  };

  const api = status?.api;
  const file = status?.file;

  return (
    <div className="pane">
      <p className="hint">
        MyRA reads your Zotero library two ways. It prefers Zotero&rsquo;s own local
        connection, which searches the text inside your attached PDFs. When that cannot be
        reached — a Flatpak or Snap Zotero keeps the port inside its sandbox, where nothing
        else on the machine can get at it — it reads the library file directly instead, which
        finds everything except the text inside PDFs.
      </p>

      <div className="zotero-routes">
        <div className={`zotero-route ${api?.ok ? "ok" : "bad"}`}>
          <strong>Zotero&rsquo;s local connection</strong>
          <span>{api?.message ?? (busy ? "Checking…" : "Not checked yet.")}</span>
        </div>
        <div className={`zotero-route ${file?.ok ? "ok" : "bad"}`}>
          <strong>The library file</strong>
          <span>{file?.message ?? (busy ? "Checking…" : "Not checked yet.")}</span>
          {file?.path ? (
            <span className="hint">
              {file.path} — {SOURCE_WORDS[file.source ?? ""] ?? "found"}
            </span>
          ) : null}
        </div>
      </div>

      <label className="folder">
        Zotero data folder
        <span className="hint">
          Leave this empty unless MyRA cannot find your library. Empty means it works the
          folder out itself, asking Zotero&rsquo;s own settings first. Set it to the folder that
          holds <code>zotero.sqlite</code> — Zotero shows the path under Settings → Advanced →
          Files and Folders.
        </span>
        <div className="folder-row">
          <input
            value={settings.zoteroDataDir}
            placeholder="Found automatically"
            onChange={(e) => void patch({ zoteroDataDir: e.target.value })}
          />
          <button type="button" onClick={() => void choose()}>
            Choose…
          </button>
        </div>
      </label>

      <div className="folder-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check again"}
        </button>
        {settings.zoteroDataDir ? (
          <button
            type="button"
            onClick={() => void patch({ zoteroDataDir: "" }).then(check)}
          >
            Clear, and find it automatically
          </button>
        ) : null}
      </div>

      {/* Every place that was looked, and what Zotero itself said. This is the
          part that turns "it failed again" into something anyone can act on,
          so it is shown rather than logged. */}
      {status?.looked?.tried?.length ? (
        <details className="zotero-looked">
          <summary>Where MyRA looked ({status.looked.tried.length})</summary>
          <ul>
            {status.looked.tried.map((dir) => (
              <li key={dir}>{dir}</li>
            ))}
          </ul>
          {status.looked.profiles.length ? (
            <p className="hint">
              Zotero profiles read:{" "}
              {status.looked.profiles
                .map((p) => (p.dataDir ? `${p.path} (library in ${p.dataDir})` : `${p.path} (default location)`))
                .join("; ")}
            </p>
          ) : (
            <p className="hint">
              No Zotero profile was found on this machine, so MyRA could not ask Zotero where
              its library is.
            </p>
          )}
        </details>
      ) : null}
    </div>
  );
}

/** How the folder was arrived at, in words rather than a field name. */
const SOURCE_WORDS: Record<string, string> = {
  setting: "the folder set here",
  environment: "MYRA_ZOTERO_DIR",
  profile: "where Zotero's own settings say the library is",
  default: "Zotero's usual location",
  search: "found by searching",
};

/* ----------------------------------------------------------------- folders */

const FOLDERS = [
  { key: "vaultRoot", label: "Vault", hint: "Where reports and notes are filed. Your Obsidian vault, if you have one." },
  { key: "workspaceRoot", label: "Documents", hint: "Where drafts and conversions are written." },
  { key: "meetingsRoot", label: "Recordings", hint: "Where meeting audio is kept until it is transcribed." },
  /* The images folder is settable for the same reason the other three are: the
     page invites you to open it in a file manager and keep what is in it, and a
     folder you are told to treat as yours that can only be moved by editing
     settings.json is not one. */
  { key: "imagesRoot", label: "Images", hint: "Where generated figures are filed, beside a note of what was asked for." },
  { key: "papersRoot", label: "Papers", hint: "Where the paper drafter keeps your notes and drafts, one file per paper." },
  { key: "reviewsRoot", label: "Peer reviews", hint: "Where finished reviews are kept. The manuscript itself is never written here." },
] as const;

function Folders({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const choose = async (key: (typeof FOLDERS)[number]["key"], label: string): Promise<void> => {
    const picked = await window.myra.chooseDirectory({ title: label, current: settings[key] });
    if (picked) await patch({ [key]: picked } as Partial<Settings>);
  };

  return (
    <div className="pane">
      {FOLDERS.map((f) => (
        <label key={f.key} className="folder">
          {f.label}
          <span className="hint">{f.hint}</span>
          <div className="folder-row">
            <input readOnly value={settings[f.key]} />
            <button type="button" onClick={() => void choose(f.key, f.label)}>
              Choose…
            </button>
          </div>
        </label>
      ))}

      <label className="folder">
        Report subfolder
        <span className="hint">
          Inside the vault. With no vault set, notes are filed in the meeting&rsquo;s own folder
          beside the recording.
        </span>
        <input
          value={settings.meetingReportDir}
          onChange={(e) => void patch({ meetingReportDir: e.target.value })}
        />
      </label>

      {/*
        * The steer, not the prompt.
        *
        * The extraction and composition prompts are long and carefully argued —
        * what counts as an action versus a status update, why an owner must not
        * be inferred — and handing a user a textarea over them would be a way
        * to make notes worse without meaning to. This is the paragraph that
        * says what *your* meetings are like, and it is appended to both stages.
        * Any single meeting can override it from the Meetings page.
        */}
      <label className="folder">
        Default note instructions
        <span className="hint">
          Added to every write-up. A single meeting can override this from its own row on the
          Meetings page.
        </span>
        <textarea
          className="settings-prose"
          rows={3}
          value={settings.meetingInstructions}
          placeholder="e.g. We are a research group. Keep methodological objections in full, and always list what I agreed to read."
          onChange={(e) => void patch({ meetingInstructions: e.target.value })}
        />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.deleteRawAudioAfterTranscription}
          onChange={(e) => void patch({ deleteRawAudioAfterTranscription: e.target.checked })}
        />
        Delete the recording once a transcript exists
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------- audio */

/**
 * One of the two audio models, chosen from what can actually run.
 *
 * A dropdown rather than the picker the chat bar uses, because the two screens
 * are for different moments: the bar is for switching mid-conversation, and this
 * is for setting the thing up once. What they share is the list, which comes
 * from the same place -- the local runtime's catalogue plus the user's
 * providers -- so neither can offer a model the other does not.
 */
function AudioModelField({
  role,
  settings,
  patch,
}: {
  role: AudioRole;
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [options, setOptions] = useState<AudioOption[]>([]);
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /* Which engines are installed. A speech model whose engine is not there
     downloads perfectly and then fails to load, which is what a user met at
     the end of a dictated sentence: "whisper-server failed to start or become
     ready". The list is where that is cheapest to say. */
  const [engines, setEngines] = useState<Map<string, Runnable>>(new Map());

  const chosen = role === "transcription"
    ? settings.audio.transcriptionModel
    : settings.audio.voiceModel;

  const refresh = (): void => {
    void window.myra.audioModels(role).then((r) => {
      setOptions(r.options);
      if (!r.ok) setStatus(r.error);
    });
    // Best effort: not knowing costs a warning, and waiting on it would cost
    // the list.
    void window.myra.lemonadeInfo().then((r) => {
      if (r.ok && r.info) setEngines(engineStates(r.info.engines));
    });
  };
  useEffect(refresh, [role]);
  useEffect(() => window.myra.onAudioProgress((p) =>
    setStatus(p.bytesTotal ? `downloading — ${Math.round(p.percent)}%` : "downloading…")), []);

  const current = options.find((o) => o.ref === chosen);
  const needsDownload = current?.where === "local" && current.downloaded === false;

  /* Only "installable but not installed". An engine this hardware cannot run
     at all belongs on the Models screen with the explanation; here it would be
     a verdict about somebody's GPU in a dropdown about dictation. */
  const needsEngine = (option: AudioOption): boolean =>
    Boolean(
      engines.size && option.where === "local" && option.recipe &&
        runnable(option.recipe, engines).state === "needs-engine",
    );

  const choose = (ref: string): void => {
    void patch({
      audio: {
        ...settings.audio,
        ...(role === "transcription" ? { transcriptionModel: ref } : { voiceModel: ref }),
      },
    });
    setStatus(undefined);
  };

  /**
   * Fetch it now, rather than on the first thing somebody says.
   *
   * Lemonade pulls a model the first time a request names it, which is correct
   * behaviour and a bad surprise: the download would happen in the middle of
   * someone's first dictation, with a spinner that says nothing about the 3.1 GB
   * arriving behind it.
   */
  const download = async (): Promise<void> => {
    if (!current) return;
    setBusy(true);
    setStatus("preparing…");
    const result = await window.myra.audioLoad(current.model);
    setBusy(false);
    setStatus(result.ok ? "ready" : result.error);
    refresh();
  };

  const local = options.filter((o) => o.where === "local");
  /*
   * A provider's models, split by whether they look like this job.
   *
   * A provider publishes ids and no capabilities, so the transcription list
   * offered `gpt-4o` and the voice list offered `whisper-1`. The rest are not
   * dropped — they go in a second group under the same provider, because a
   * guess about a name should never be what puts a model out of reach, and the
   * one already chosen always shows in the first group.
   */
  const byProvider = new Map<string, { fits: AudioOption[]; rest: AudioOption[] }>();
  for (const option of options.filter((o) => o.where === "provider")) {
    const key = option.providerLabel ?? "Provider";
    const group = byProvider.get(key) ?? { fits: [], rest: [] };
    (option.fits === false && option.ref !== chosen ? group.rest : group.fits).push(option);
    byProvider.set(key, group);
  }

  return (
    <fieldset className="endpoint">
      <legend>{role === "transcription" ? "Transcription" : "Voice"}</legend>
      <p className="hint">
        {role === "transcription"
          ? "Turns dictation and recorded meetings into text."
          : "Reads answers aloud in speech-to-speech mode. Leave it unset and MyRA stays silent."}
      </p>

      <label>
        Model
        <select value={chosen} onChange={(e) => choose(e.target.value)}>
          <option value="">
            {role === "voice" ? "None — do not speak" : "Choose a model…"}
          </option>
          {local.length ? (
            <optgroup label="On this machine">
              {local.map((o) => (
                <option key={o.ref} value={o.ref}>
                  {o.model}
                  {o.downloaded ? (o.loaded ? " — loaded" : "") : ` — ${sizeOf(o)} download`}
                  {needsEngine(o) ? ` — needs the ${o.recipe} engine` : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {[...byProvider].map(([provider, group]) => (
            <Fragment key={provider}>
              {group.fits.length ? (
                <optgroup label={provider}>
                  {group.fits.map((o) => (
                    <option key={o.ref} value={o.ref}>
                      {o.model}
                      {o.external ? " — leaves this machine" : ""}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {group.rest.length ? (
                <optgroup label={`${provider} — other models, probably not for this`}>
                  {group.rest.map((o) => (
                    <option key={o.ref} value={o.ref}>
                      {o.model}
                      {o.external ? " — leaves this machine" : ""}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Fragment>
          ))}
        </select>
      </label>

      {/*
        * Why the list is short, on the one install where it is empty.
        *
        * The catalogue of speech models is a file inside the model runtime, so
        * on a machine where that has not been installed there is nothing local
        * to offer -- which is every fresh install. The dropdown said nothing
        * about it: a new user opened this pane, found one greyed placeholder,
        * and had no way to tell a feature that needs setting up from one that
        * is broken. True whatever emptied the list, and it names the two ways
        * out.
        */}
      {local.length === 0 ? (
        <p className="hint">
          Nothing on this machine can {role === "transcription" ? "listen" : "speak"} yet. Local
          speech models come with the model runtime — install it under Settings → Runtime — or
          choose one from a provider you have added.
        </p>
      ) : null}

      {current && needsEngine(current) ? (
        <p className="warning" role="note">
          {current.model} runs on the {current.recipe} engine, which is not installed. Install it
          under Settings → Runtime — downloading the model alone is not enough, and the failure
          otherwise arrives at the end of the first thing you say.
        </p>
      ) : null}

      {needsDownload ? (
        <button type="button" className="ghost" disabled={busy} onClick={() => void download()}>
          {busy ? "Downloading…" : `Download it now (${sizeOf(current)})`}
        </button>
      ) : null}

      {current?.external ? (
        <p className="warning" role="note">
          {role === "transcription"
            ? "Recordings — dictation and whole meetings — are sent to this provider."
            : "Everything MyRA reads aloud is sent to this provider to be spoken."}
        </p>
      ) : null}

      {status ? <p className="hint">{status}</p> : null}
    </fieldset>
  );
}

function sizeOf(option: AudioOption | undefined): string {
  const bytes = option?.sizeBytes;
  if (!bytes) return "unknown size";
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * Which voice, and how fast.
 *
 * A dropdown when the voices are knowable and a text box when they are not,
 * which is not a fallback so much as an honest answer: Kokoro's forty voices
 * were established by asking a running daemon, and there is no endpoint that
 * would answer the same question for somebody's hosted provider. An empty
 * dropdown would be a control that cannot be used; a text box can be.
 */
function VoiceField({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [status, setStatus] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);
  const voices = voicesFor(modelIdOf(settings.audio.voiceModel));

  if (!settings.audio.voiceModel) return null;

  const preview = async (): Promise<void> => {
    setPlaying(true);
    setStatus(undefined);
    const result = await window.myra.previewVoice(settings.audio.voice);
    if (!result.ok || !result.audio) {
      setPlaying(false);
      setStatus(result.error ?? "Nothing came back.");
      return;
    }
    const type = result.mime ?? "audio/mpeg";
    const url = URL.createObjectURL(new Blob([new Uint8Array(result.audio)], { type }));
    /* Chromium's own words for a Blob it will not decode are "Failed to load
       because no supported source was found", which describes the page rather
       than the sound and sent somebody looking for a broken voice model when
       the synthesis had worked. The format is the missing half. */
    const cannotPlay = `That audio could not be played: the voice model returned ${type}.`;
    /* `window.Audio`, not `Audio`: the settings pane below is a component
       called Audio, which shadows the constructor in this module. */
    const audio = new window.Audio(url);
    /* Revoked on every path out, including the error one: a preview somebody
       clicks twenty times should not leave twenty MP3s in the page. */
    const done = (): void => {
      URL.revokeObjectURL(url);
      setPlaying(false);
    };
    audio.onended = done;
    audio.onerror = () => {
      done();
      setStatus(cannotPlay);
    };
    await audio.play().catch(() => {
      done();
      setStatus(cannotPlay);
    });
  };

  const byLanguage = new Map<string, typeof voices>();
  for (const voice of voices) {
    byLanguage.set(voice.language, [...(byLanguage.get(voice.language) ?? []), voice]);
  }

  return (
    <fieldset className="endpoint">
      <legend>Voice</legend>

      <label>
        {voices.length ? "Which voice" : "Voice name"}
        {voices.length ? (
          <select
            value={settings.audio.voice}
            onChange={(e) => void patch({ audio: { ...settings.audio, voice: e.target.value } })}
          >
            {[...byLanguage].map(([language, group]) => (
              <optgroup key={language} label={language || "Other"}>
                {group.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.gender}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input
            value={settings.audio.voice}
            placeholder="the model's default"
            onChange={(e) => void patch({ audio: { ...settings.audio, voice: e.target.value } })}
          />
        )}
      </label>
      {!voices.length ? (
        <p className="hint">
          MyRA cannot list this model’s voices — no speech server publishes them — so this is
          whatever name it expects. Leave it empty for its own default.
        </p>
      ) : null}

      <label>
        Pace
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={settings.audio.speed}
          onChange={(e) =>
            void patch({ audio: { ...settings.audio, speed: Number(e.target.value) } })}
        />
        <span className="unit">{settings.audio.speed.toFixed(2)}×</span>
      </label>

      <button type="button" className="ghost" disabled={playing} onClick={() => void preview()}>
        {playing ? "Playing…" : "Hear it"}
      </button>
      {status ? <p className="hint">{status}</p> : null}
    </fieldset>
  );
}

function Audio({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [devices, setDevices] = useState<AudioSource[]>([]);

  useEffect(() => {
    void enumerate().then(setDevices);
  }, []);

  return (
    <div className="pane">
      <p className="pane-lead">
        Two models: one that turns speech into text, and one that reads answers back. Both run on
        this machine unless you pick one from a provider you added.
      </p>

      {/* A picker, where there used to be a base URL, an API key and a model
          name typed by hand. Transcription was the last place in the app that
          asked someone to know the shape of a server's address, and the two
          things that could answer -- the local runtime and the providers -- were
          both already lists MyRA could offer. */}
      <AudioModelField role="transcription" settings={settings} patch={patch} />
      <AudioModelField role="voice" settings={settings} patch={patch} />

      <VoiceField settings={settings} patch={patch} />

      <label>
        Microphone
        <select
          value={settings.dictationSource}
          onChange={(e) => void patch({ dictationSource: e.target.value })}
        >
          <option value="">System default</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="endpoint">
        <legend>Keyboard shortcuts</legend>
        <p className="hint">
          These work while the MyRA window is focused. A shortcut that fires from anywhere else
          has to be registered with the desktop, and that is not something MyRA can do reliably
          on Linux — so it does not pretend to.
        </p>

        <HotkeyField
          label="Dictate"
          value={settings.hotkeys.dictation}
          onChange={(combo) => void patch({ hotkeys: { ...settings.hotkeys, dictation: combo } })}
        />

        <label className="checkbox">
          <input
            type="radio"
            name="dictation-hotkey-mode"
            checked={settings.hotkeys.dictationMode === "toggle"}
            disabled={!settings.hotkeys.dictation}
            onChange={() => void patch({ hotkeys: { ...settings.hotkeys, dictationMode: "toggle" } })}
          />
          Toggle — press once to start recording, again to stop.
        </label>
        <label className="checkbox">
          <input
            type="radio"
            name="dictation-hotkey-mode"
            checked={settings.hotkeys.dictationMode === "hold"}
            disabled={!settings.hotkeys.dictation}
            onChange={() => void patch({ hotkeys: { ...settings.hotkeys, dictationMode: "hold" } })}
          />
          Hold to talk — records while you hold the keys. Releasing them, or clicking away from
          MyRA, stops the recording and sends it to be transcribed.
        </label>

        <HotkeyField
          label="Speech-to-speech"
          value={settings.hotkeys.handsFree}
          hint="A toggle: it starts the listening loop and stops it. There is no hold option -- speech-to-speech is a mode that keeps going, not a single recording. Needs a voice model above."
          onChange={(combo) => void patch({ hotkeys: { ...settings.hotkeys, handsFree: combo } })}
        />
      </fieldset>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.meetingCaptureSystemAudio}
          onChange={(e) => void patch({ meetingCaptureSystemAudio: e.target.checked })}
        />
        Also record the system's output during meetings
      </label>
      <p className="hint">
        This is what separates the speakers. A microphone alone records the person wearing the
        headphones and nobody else, so a remote meeting transcribes to one side of the
        conversation. You will be asked which window or screen to share; the video is discarded
        immediately and only the audio is kept.
      </p>

      <label>
        Transcription language
        <input
          value={settings.dictationLanguage}
          placeholder="auto-detect"
          onChange={(e) => void patch({ dictationLanguage: e.target.value })}
        />
        <span className="unit">two-letter code, e.g. en</span>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------- permissions */

/* --------------------------------------------------------------- appearance */

const THEMES = [
  { value: "dark", label: "Dark", hint: "Warm near-black. The default." },
  { value: "light", label: "Light", hint: "Warm paper white, with a darker amber so text stays readable." },
] as const;

/**
 * Which palette to paint with.
 *
 * Both themes are defined as the same set of tokens, so this changes forty
 * variables and no component rules. It is a real second design rather than an
 * inversion: the accent that reads as a fill on near-black fails as text on
 * paper, so light mode darkens it.
 */
function Appearance({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [trayOk, setTrayOk] = useState<boolean | undefined>();
  useEffect(() => {
    void window.myra.trayAvailable().then(setTrayOk);
  }, []);

  return (
    <div className="pane">
      <p className="pane-lead">
        MyRA follows the theme you pick here rather than the system one, so a desktop that
        switches at sunset will not change the app underneath you mid-sentence.
      </p>

      {/* Window behaviour rather than colour, but this is the tab that already
          owns how the app presents itself, and a tab of its own for one
          checkbox would be worse. */}
      <fieldset className="endpoint">
        <legend>Window</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.keepRunningInTray}
            onChange={(e) => void patch({ keepRunningInTray: e.target.checked })}
          />
          <span>Keep MyRA running when the window is closed</span>
        </label>
        <p className="hint">
          MyRA stays in your tray with the model loaded and, if you are serving it, the API
          still answering. Quit from the tray icon. Turn this off and closing the window quits
          MyRA as it used to.
        </p>
        {/* Said plainly rather than left as a checkbox that does nothing:
            GNOME shows no status area unless an AppIndicator extension is
            installed, and MyRA closes normally when there is nowhere to go. */}
        {trayOk === false ? (
          <p className="hint note">
            Your desktop is not showing tray icons, so this has no effect and closing the window
            quits MyRA — it will not vanish into a tray that is not there. GNOME, Pop!_OS
            included, needs an extension for this:{" "}
            <code>sudo apt install gnome-shell-extension-appindicator</code>, then log out and
            back in. MyRA checks again each time it starts.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="endpoint">
        <legend>Theme</legend>
        <div className="theme-choices">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={settings.theme === t.value ? "theme-choice active" : "theme-choice"}
              aria-pressed={settings.theme === t.value}
              onClick={() => void patch({ theme: t.value })}
            >
              {/* A miniature of the app rather than a colour swatch: the point
                  is what the window will look like, not what colour it is. */}
              <span className={`theme-preview theme-preview-${t.value}`} aria-hidden="true">
                <span className="tp-rail" />
                <span className="tp-body">
                  <span className="tp-line" />
                  <span className="tp-line short" />
                  <span className="tp-card" />
                </span>
              </span>
              <span className="theme-name">{t.label}</span>
              <span className="hint">{t.hint}</span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

const MODES = [
  { value: "guarded", label: "Guarded", hint: "Reading is silent; writing a document is silent too, and every write is jailed to your documents folder. The default." },
  { value: "manual", label: "Ask every time", hint: "Confirm every tool call, searches included. Thorough, and noisy: a research run becomes a wall of prompts." },
  { value: "yolo", label: "Never ask", hint: "Nothing prompts. With this tool set that is the same as Guarded, and it stays honest if a riskier tool is ever added." },
] as const;

/**
 * Who MyRA is, in the user's own words.
 *
 * Only the persona: what follows it in the prompt is the tool discipline, the
 * citation rules and the untrusted-content rule, and those are not offered here
 * because a prompt that replaced them could produce a [1] pointing at nothing --
 * the app's one unbreakable promise, broken by a text box. The note below says
 * so rather than leaving it to be discovered.
 */
function Persona({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  return (
    <div className="pane">
      <p className="pane-lead">
        The first thing every conversation tells the model. Change it to give MyRA a different
        voice, a field of your own, or a house style — it applies to chat, and a single model can
        be given its own from the cog beside it in the model menu.
      </p>

      <label className="field">
        <span className="field-label">Persona</span>
        <textarea
          rows={6}
          value={settings.persona}
          onChange={(e) => void patch({ persona: e.target.value })}
        />
      </label>

      <p className="pane-note">
        This replaces the description of who MyRA is, and nothing else. MyRA&rsquo;s own rules
        follow it and cannot be edited from here: how to hold a tool, that a citation marker may
        only ever be one a tool actually returned, and that text inside untrusted-content markers
        is data rather than instruction. Those are what keep a reference from being invented, so
        they are not a setting.
      </p>

      <div className="pane-actions">
        <button
          type="button"
          className="ghost"
          disabled={settings.persona === DEFAULT_PERSONA}
          onClick={() => void patch({ persona: DEFAULT_PERSONA })}
        >
          Back to MyRA&rsquo;s own
        </button>
      </div>

      <h3>Models with their own</h3>
      {Object.keys(settings.systemPrompts).length ? (
        <ul className="persona-list">
          {Object.entries(settings.systemPrompts).map(([model, text]) => (
            <li key={model}>
              <span className="persona-model">{model}</span>
              <span className="persona-text">{text}</span>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const next = { ...settings.systemPrompts };
                  delete next[model];
                  void patch({ systemPrompts: next });
                }}
              >
                Clear
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pane-note">
          None yet. The cog beside a model in the model menu gives that one its own.
        </p>
      )}
    </div>
  );
}

function Permissions({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  return (
    <div className="pane">
      <p className="pane-lead">
        MyRA can only do what its tools allow — there is no shell, so &ldquo;run a command&rdquo; is
        not something it can express. These modes decide how much of the rest you want to see
        before it happens.
      </p>

      {MODES.map((m) => (
        <label key={m.value} className="checkbox">
          <input
            type="radio"
            name="permission-mode"
            checked={settings.permissionMode === m.value}
            onChange={() => void patch({ permissionMode: m.value })}
          />
          <span>
            {m.label}
            <span className="hint"> — {m.hint}</span>
          </span>
        </label>
      ))}

      <h3>What the tools can reach</h3>
      <ul className="plain">
        <li>Searching and reading sources: the open web, read-only.</li>
        <li>Reading and writing documents: your documents folder only, checked on every call.</li>
        <li>Nothing can send data anywhere. Every tool reads; none posts.</li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------- about */

function About({ onReplayTutorial }: { onReplayTutorial: () => void }) {
  const [engines, setEngines] = useState<Awaited<ReturnType<typeof window.myra.engines>> | undefined>();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | undefined>();
  const [privacy, setPrivacy] = useState<PrivacyReport | undefined>();
  const [version, setVersion] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | undefined>();

  useEffect(() => {
    void window.myra.engines().then(setEngines);
    void window.myra.privacy().then(setPrivacy);
    void window.myra.appVersion().then(setVersion);
  }, []);

  return (
    <div className="pane">
      <h3>MyRA</h3>
      <p className="pane-lead">
        {version ? `Version ${version}.` : "Checking version…"} MyRA has no auto-updater — this
        only asks GitHub when you press the button below.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          setUpdateCheck(undefined);
          void window.myra.checkUpdate().then((r) => {
            setChecking(false);
            setUpdateCheck(r);
          });
        }}
      >
        {checking ? "Asking GitHub…" : "Check for updates"}
      </button>
      {updateCheck ? (
        updateCheck.ok ? (
          updateCheck.newer ? (
            <p className="warning">
              {updateCheck.latest} is out; you have {updateCheck.current}.
              {updateCheck.url ? (
                <>
                  {" "}
                  <button type="button" onClick={() => void window.myra.openExternal(updateCheck.url!)}>
                    See what changed
                  </button>
                </>
              ) : null}
            </p>
          ) : (
            <p className="ok-line">You have the newest release, {updateCheck.current}.</p>
          )
        ) : (
          <p className="hint">Could not reach GitHub: {updateCheck.error}</p>
        )
      ) : null}

      <h3>The tour</h3>
      {/* The way back for anyone who skipped it the first time, or wants
          another look -- the same reasoning as the pandoc button below,
          for the screen this app opens with rather than the one it installs. */}
      <p className="pane-lead">
        A short walkthrough of where things live, shown once after setup.
      </p>
      <button type="button" className="btn btn-sm" onClick={onReplayTutorial}>
        Show the tutorial again
      </button>

      <h3>What leaves this machine</h3>
      <p className="pane-lead">
        This list is generated from the code that makes the requests, not written out by hand: a
        test fails the build if the app can reach a host that is not named here. Nothing below
        happens on a timer — every row names the thing you did.
      </p>

      <h4 className="pane-sub">Your endpoints</h4>
      {privacy?.endpoints.length ? (
        <ul className="plain">
          {privacy.endpoints.map((e) => (
            <li key={e.label}>
              {e.label}: <code>{e.url}</code>{" "}
              <span className={e.local ? "pill on" : "pill"}>
                {e.local ? "this machine" : "leaves this machine"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">
          No endpoints are configured. If you are running a model through MyRA&rsquo;s own runtime,
          prompts are not going anywhere.
        </p>
      )}

      <h4 className="pane-sub">Everything else</h4>
      <table className="privacy-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>When</th>
            <th>What it carries</th>
          </tr>
        </thead>
        <tbody>
          {(privacy?.destinations ?? []).map((d) => (
            <tr key={d.host}>
              <td><code>{d.host}</code></td>
              <td>{d.when}</td>
              <td>{d.sends}</td>
            </tr>
          ))}
          {/* Not a host, and the one entry that cannot be enumerated: reading
              the literature means fetching whatever the literature points at. */}
          <tr>
            <td className="dim">the page itself</td>
            <td>A research run reads a source it found</td>
            <td>Nothing but the request — those sites see this machine&rsquo;s address</td>
          </tr>
        </tbody>
      </table>

      <p className="hint">
        Files, transcripts, meeting audio and conversation history never cross the network at all.
        There is no telemetry, no crash reporting, and no update check that you did not press.
      </p>

      <h3>Blocked by the egress filter</h3>
      <p className="hint">
        The window itself is not allowed to reach the network — everything above runs in the main
        process, behind a checked boundary. Two things enforce that: a content policy that refuses
        the request inside the page, and a filter that cancels it at the network layer. The filter
        is the one that also covers the traffic Chromium starts on its own, which no page policy
        can see. Anything either of them stopped is listed here.
      </p>
      {privacy ? (
        privacy.blocked.length === 0 ? (
          <p className="ok-line">Nothing has been blocked this session, which is the expected result.</p>
        ) : (
          <ul className="plain">
            {privacy.blocked.map((b, i) => (
              <li key={i} className="warning">
                <code>{b.url}</code> — {new Date(b.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        )
      ) : null}

      <h3>Document tools</h3>
      {engines ? (
        <ul className="plain">
          <li>
            pandoc: {engines.pandoc ? engines.pandocVersion ?? "available" : "not found"}
            {engines.pandocPath ? <span className="hint"> — {engines.pandocPath}</span> : null}
          </li>
          <li>PDF text extraction: {engines.pdftotext ? "available" : "not found"}</li>
          {!engines.pandoc ? (
            <li className="warning">
              Without pandoc, documents can only be written as Markdown. Everything else —
              meetings, research, chat — works as normal.
              {/* The setup screen installs this on first run; this is the way back
                  for anyone who skipped it, or whose first attempt failed. */}
              <button
                type="button"
                className="btn btn-sm"
                disabled={installing}
                onClick={() => {
                  setInstalling(true);
                  setInstallError(undefined);
                  void window.myra.installPandoc().then((r) => {
                    setInstalling(false);
                    if (r.ok) void window.myra.engines().then(setEngines);
                    else setInstallError(r.error);
                  });
                }}
              >
                {installing ? "Installing…" : "Install pandoc"}
              </button>
              {installError ? <span className="hint"> {installError}</span> : null}
            </li>
          ) : null}
          {!engines.pdftotext ? (
            <li className="warning">
              Without poppler, PDFs cannot be read as text. Papers found by research will still
              be cited, but their full text will not be available.
            </li>
          ) : null}
        </ul>
      ) : (
        <p>checking…</p>
      )}
    </div>
  );
}
