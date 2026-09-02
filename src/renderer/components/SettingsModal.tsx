import { useEffect, useState } from "react";
import type { AudioSource, PrivacyReport, Settings, VaultStatus } from "../types.ts";
import { enumerate } from "../capture.ts";
import { RuntimePane } from "./RuntimePane.tsx";
import { ProvidersPane } from "./ProvidersPane.tsx";
import { EndpointField, TRANSCRIPTION } from "./EndpointField.tsx";

/**
 * Everything configurable, in one place.
 *
 * The product requirement is that the user never opens a JSON file, so anything
 * that can be set is set here. v1's pages for the bridge, the pairing code, the
 * GNOME keybinding and the network activity log are gone with the things they
 * configured.
 */

type Tab =
  | "providers" | "runtime" | "storage" | "audio" | "appearance"
  | "permissions" | "about";

/*
 * There was an "Endpoints" tab here, and Providers replaced it.
 *
 * It configured three things. The language model endpoint was the same job
 * Providers does and did it worse -- one endpoint, no model picking, no local
 * or external judgement, no key per vendor -- so two screens set where a
 * conversation goes and the one with fewer answers came first. The other two
 * were not endpoints in the same sense and have gone where they belong:
 * transcription is what the Audio tab is about, and embeddings only exist to
 * rank search results, which is a provider question.
 */
const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "runtime", label: "Runtime" },
  { id: "storage", label: "Folders" },
  { id: "audio", label: "Audio" },
  { id: "appearance", label: "Appearance" },
  { id: "permissions", label: "Permissions" },
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
    void window.karen.getSettings().then(setSettings);
    void window.karen.secretsBackend().then(setVault);
  }, []);

  const patch = async (changes: Partial<Settings>): Promise<void> => {
    const next = await window.karen.updateSettings(changes);
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
          {tab === "storage" ? <Folders settings={settings} patch={patch} /> : null}
          {tab === "audio" ? <Audio settings={settings} patch={patch} /> : null}
          {tab === "appearance" ? <Appearance settings={settings} patch={patch} /> : null}
          {tab === "permissions" ? <Permissions settings={settings} patch={patch} /> : null}
          {tab === "about" ? <About /> : null}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- folders */

const FOLDERS = [
  { key: "vaultRoot", label: "Vault", hint: "Where reports and notes are filed. Your Obsidian vault, if you have one." },
  { key: "workspaceRoot", label: "Documents", hint: "Where drafts and conversions are written." },
  { key: "meetingsRoot", label: "Recordings", hint: "Where meeting audio is kept until it is transcribed." },
] as const;

function Folders({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const choose = async (key: (typeof FOLDERS)[number]["key"], label: string): Promise<void> => {
    const picked = await window.karen.chooseDirectory({ title: label, current: settings[key] });
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
      {/* Transcription lives here now rather than on a tab of its own. It is
          the endpoint that turns this microphone's output into words, and it
          was previously two screens away from the device it applies to. */}
      <EndpointField which={TRANSCRIPTION} settings={settings} patch={patch} />

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
    void window.karen.trayAvailable().then(setTrayOk);
  }, []);

  return (
    <div className="pane">
      <p className="pane-lead">
        Karen follows the theme you pick here rather than the system one, so a desktop that
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
          <span>Keep Karen running when the window is closed</span>
        </label>
        <p className="hint">
          Karen stays in your tray with the model loaded and, if you are serving it, the API
          still answering. Quit from the tray icon. Turn this off and closing the window quits
          Karen as it used to.
        </p>
        {/* Said plainly rather than left as a checkbox that does nothing:
            GNOME shows no status area unless an AppIndicator extension is
            installed, and Karen closes normally when there is nowhere to go. */}
        {trayOk === false ? (
          <p className="hint note">
            Your desktop is not showing tray icons, so this has no effect and closing the window
            quits Karen — it will not vanish into a tray that is not there. GNOME, Pop!_OS
            included, needs an extension for this:{" "}
            <code>sudo apt install gnome-shell-extension-appindicator</code>, then log out and
            back in. Karen checks again each time it starts.
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
        Karen can only do what its tools allow — there is no shell, so &ldquo;run a command&rdquo; is
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

function About() {
  const [engines, setEngines] = useState<Awaited<ReturnType<typeof window.karen.engines>> | undefined>();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | undefined>();
  const [privacy, setPrivacy] = useState<PrivacyReport | undefined>();

  useEffect(() => {
    void window.karen.engines().then(setEngines);
    void window.karen.privacy().then(setPrivacy);
  }, []);

  return (
    <div className="pane">
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
          No endpoints are configured. If you are running a model through Karen&rsquo;s own runtime,
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
                className="btn-sm"
                disabled={installing}
                onClick={() => {
                  setInstalling(true);
                  setInstallError(undefined);
                  void window.karen.installPandoc().then((r) => {
                    setInstalling(false);
                    if (r.ok) void window.karen.engines().then(setEngines);
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
