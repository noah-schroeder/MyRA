import { useEffect, useRef, useState } from "react";
import type { AudioSource, HotkeyState, Settings, Status } from "../types.ts";

/**
 * One page per thing you configure.
 *
 * "endpoints" used to be a single page holding the language model, embeddings
 * and transcription together, with the transcription model missing entirely and
 * model selection living out in the main window — so neither endpoint could be
 * set up without going somewhere else. Each is now self-contained: URL, key,
 * model and a way to prove it works, on one page.
 */
type Tab = "model" | "transcription" | "paths" | "dictation" | "pairing" | "privacy";

const TAB_LABEL: Record<Tab, string> = {
  model: "Language model",
  transcription: "Transcription",
  paths: "Folders",
  dictation: "Dictation",
  pairing: "Pairing",
  privacy: "Privacy",
};

/**
 * Settings is for CONNECTION setup only: where the endpoints are, what keys
 * they need, and proof that they answer. Choosing which model to talk to is the
 * dropdown's job in the main window -- keeping selection in one place is what
 * stops the config file and the active model drifting apart.
 */
/**
 * A path, with a real folder picker beside it.
 *
 * Typing a path by hand is how you end up pointing at a vault one character
 * from the real one, which then sits there silently empty. The dialog also
 * guarantees the folder exists before it is saved.
 */
function PathField({
  label, value, placeholder, help, onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  help?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row">
        <input
          className="input"
          style={{ flex: 1 }}
          {...(placeholder ? { placeholder } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          className="btn"
          onClick={async () => {
            const result = await window.karen.chooseDirectory({
              title: label,
              ...(value ? { current: value } : {}),
            });
            if (result.path) onChange(result.path);
          }}
        >
          Browse…
        </button>
      </div>
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export function SettingsModal({
  status,
  onClose,
  onSessionsCleared,
}: {
  status: Status;
  onClose: () => void;
  /** Deleting chats here changes state the rest of the app is showing. */
  onSessionsCleared: () => void;
}) {
  const [tab, setTab] = useState<Tab>("model");
  const [s, setS] = useState<Settings>(status.settings);
  const [llmKey, setLlmKey] = useState("");
  const [sttKey, setSttKey] = useState("");
  const [sttTesting, setSttTesting] = useState(false);
  const [sttMsg, setSttMsg] = useState<string | undefined>();
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [embedKey, setEmbedKey] = useState("");
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<string | undefined>();
  const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [activity, setActivity] = useState<{ url: string; allowed: boolean; reason: string }[]>([]);
  const [pairing, setPairing] = useState<{ token: string; port: number } | undefined>();
  const [hotkey, setHotkey] = useState<HotkeyState | undefined>();
  const [mics, setMics] = useState<AudioSource[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [hotkeyMsg, setHotkeyMsg] = useState<string | undefined>();
  const [reveal, setReveal] = useState(false);

  useEffect(() => setS(status.settings), [status.settings]);
  useEffect(() => {
    if (tab === "dictation") {
      void window.karen.hotkeyState().then(setHotkey);
      void window.karen.audioSources().then((r) => setMics(r.sources));
    }
    if (tab === "privacy") void window.karen.networkActivity().then(setActivity);
    if (tab === "pairing") void window.karen.getPairing().then(setPairing);
  }, [tab]);

  /**
   * Autosave the selection.
   *
   * Debounced so ticking several boxes in a row writes once rather than once
   * per click; each write restarts nothing, but it does hit the VM over the
   * socket, and a burst of them would race each other.
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const updatePicked = (next: Set<string>) => {
    setPicked(next);
    setMsg("Saving…");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistSelection(next); }, 400);
  };

  const visible = found.filter((m) =>
    filter.trim() === "" || `${m.name} ${m.id}`.toLowerCase().includes(filter.toLowerCase()),
  );

  const save = async (patch: Partial<Settings>) => setS(await window.karen.updateSettings(patch));

  /**
   * Save the endpoint, prove it answers, and register everything it offers.
   *
   * Every model the server lists is written to pi's catalogue, so the dropdown
   * can offer all of them. There is nothing to tick: the endpoint decides what
   * exists, you decide what to use.
   */
  /**
   * Prove the transcription endpoint works, from here.
   *
   * The app performs this itself rather than asking the VM, because the app is
   * what uploads the audio — a success from the wrong process would prove
   * nothing about the path dictation actually takes.
   */
  const testTranscription = async () => {
    setSttTesting(true);
    setSttMsg("Contacting the endpoint…");
    setSttModels([]);
    try {
      if (sttKey) await window.karen.setSecret("transcriptionKey", sttKey);
      await save({ transcription: s.transcription });
      const result = await window.karen.testTranscription();
      if (!result.ok) {
        setSttMsg(`Could not reach it: ${result.error}`);
        return;
      }
      const models = result.models ?? [];
      setSttModels(models);
      setSttMsg(
        models.length
          ? `Connected. It serves ${models.length} model${models.length === 1 ? "" : "s"}.`
          : "Connected, but it listed no models. That is fine — some servers do not implement /models.",
      );
    } catch (err) {
      setSttMsg((err as Error).message);
    } finally {
      setSttTesting(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setMsg("Contacting the endpoint from the VM…");
    let note = "";
    try {
      if (llmKey) {
        const r = (await window.karen.setSecret("llmKey", llmKey)) as unknown as { persisted?: boolean };
        if (r && r.persisted === false) {
          note = " Key held for this session only — no system keyring available.";
        }
      }
      await save({ llm: s.llm });

      const probe = await window.karen.probeModels();
      const models = probe.models ?? [];
      setFound(models);

      if (models.length === 0) {
        setMsg("Connected, but the endpoint listed no models." + note);
        return;
      }

      // Pre-tick whatever is already configured, so re-testing never silently
      // drops a model the user had chosen.
      try {
        const cfg = (await window.karen.getModels()) as { models?: { id: string }[] };
        const already = new Set((cfg?.models ?? []).map((m) => m.id));
        if (already.size) setPicked(already); // already persisted; no write needed
      } catch { /* nothing configured yet */ }

      setMsg(
        `Connected — ${models.length} model${models.length === 1 ? "" : "s"} offered. ` +
          `Tick the ones you want available, then Save.` + note,
      );
    } catch (err) {
      setMsg(`Failed: ${(err as Error).message}${note}`);
    } finally {
      setTesting(false);
    }
  };

  /**
   * Write the chosen subset to pi's catalogue.
   *
   * This defines what is AVAILABLE; it does not choose what is active -- that
   * stays with the dropdown in the main window. The one exception is
   * reconciliation: if the model pi is currently using has just been removed
   * from the list, something has to move it somewhere valid.
   */
  const persistSelection = async (next: Set<string>) => {
    const ids = [...next];
    if (ids.length === 0) {
      // An empty catalogue is invalid, so there is nothing to write yet.
      setMsg("Tick at least one model — the dropdown needs something to offer.");
      return;
    }
    setSaving(true);
    try {
      await window.karen.writeModels({
        providers: {
          local: {
            baseUrl: s.llm.baseUrl,
            api: "openai-completions",
            // An env reference, never the key itself.
            apiKey: `$${s.llm.envVar}`,
            models: ids.map((id) => ({
              id,
              name: found.find((f) => f.id === id)?.name || id,
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 32000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          },
        },
      });

      let moved = "";
      try {
        const st = (await window.karen.getModelState()) as { model?: { id: string } };
        const active = st?.model?.id;
        if (!active || !ids.includes(active)) {
          await window.karen.rpc({ type: "set_model", provider: "local", modelId: ids[0]! });
          moved = ` Active model was no longer available, so it moved to ${ids[0]}.`;
        }
      } catch { /* the dropdown will reconcile on next refresh */ }

      setMsg(`Saved — ${ids.length} model${ids.length === 1 ? "" : "s"} available in the dropdown.${moved}`);
    } catch (err) {
      setMsg(`Could not save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-head">
          <span className="modal-title">Settings</span>
          <div className="spacer" />
          {(["model", "transcription", "paths", "dictation", "pairing", "privacy"] as Tab[]).map((t) => (
            <button key={t} className={`btn ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {!status.vault.usable ? (
            <div className="warn"><strong>Secrets cannot be stored at rest.</strong> {status.vault.reason}</div>
          ) : null}

          {tab === "model" ? (
            <>
              <div className="section">
                <div className="section-title">Language model</div>
                <div className="help">
                  Any OpenAI-compatible endpoint. It is contacted only from the VM — the desktop
                  app never connects to it. Model selection lives in the main window.
                </div>
                <div className="field">
                  <span className="label">Base URL</span>
                  <input className="input" placeholder="http://10.0.2.2:8080/v1"
                    value={s.llm.baseUrl}
                    onChange={(e) => setS({ ...s, llm: { ...s.llm, baseUrl: e.target.value } })} />
                  <span className="help">
                    pi runs inside the VM, so a server on your main machine is <code>10.0.2.2</code>, not localhost.
                  </span>
                </div>
                <div className="field">
                  <span className="label">API key {status.vault.usable ? "" : "(session only)"}</span>
                  <input className="input" type="password" placeholder="leave blank if the server needs none"
                    value={llmKey} onChange={(e) => setLlmKey(e.target.value)} />
                </div>
                <div className="row">
                  <button className="btn btn-primary" onClick={testConnection} disabled={testing || !s.llm.baseUrl}>
                    {testing ? "Testing…" : "Test connection"}
                  </button>
                </div>
                {msg ? <div className="help">{msg}</div> : null}

                {found.length ? (
                  <div className="field">
                    <span className="label">
                      Available models — {picked.size} of {found.length} selected
                    </span>
                    <div className="row">
                      <input className="input" placeholder="filter…" value={filter}
                        onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
                      <button className="btn" onClick={() => updatePicked(new Set(visible.map((m) => m.id)))}>
                        All shown
                      </button>
                      <button className="btn" onClick={() => updatePicked(new Set())}>None</button>
                    </div>
                    <div className="code-block" style={{ maxHeight: 230 }}>
                      {visible.length === 0 ? "No models match that filter." : visible.map((m) => (
                        <label key={m.id} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                          <input type="checkbox" checked={picked.has(m.id)}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(m.id); else next.delete(m.id);
                              updatePicked(next);
                            }} />
                          <span>{m.name && m.name !== m.id ? `${m.name}` : m.id}</span>
                        </label>
                      ))}
                    </div>
                    <span className="help">
                      Changes save automatically. Only ticked models appear in the main dropdown —
                      embedding and image models (embeddinggemma, FLUX, LTX…) cannot chat, so leave
                      those unticked.
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="section">
                <div className="section-title">Embeddings</div>
                <div className="field">
                  <span className="label">Base URL</span>
                  <input className="input" placeholder="http://10.0.2.2:8890/v1"
                    value={s.embeddings.baseUrl}
                    onChange={(e) => setS({ ...s, embeddings: { ...s.embeddings, baseUrl: e.target.value } })}
                    onBlur={() => save({ embeddings: s.embeddings })} />
                  <span className="help">
                    Usually a different server from the chat endpoint — llama.cpp serves one model
                    per process — and it answers <code>/embeddings</code>, not{" "}
                    <code>/chat/completions</code>. Contacted from the VM, so it is not on the
                    app's egress allowlist. Leave blank to skip similarity ranking: deep research
                    then screens the first candidates it finds rather than the best-matching ones.
                  </span>
                </div>
                <div className="field">
                  <span className="label">Model</span>
                  <input className="input" placeholder="nomic-embed-text-v1.5"
                    value={s.embeddings.model ?? ""}
                    onChange={(e) => setS({ ...s, embeddings: { ...s.embeddings, model: e.target.value } })}
                    onBlur={() => save({ embeddings: s.embeddings })} />
                  <span className="help">
                    The id the endpoint serves it under. Deep research sends every candidate
                    abstract here, so it wants to be a small, fast model.
                  </span>
                </div>
                <div className="field">
                  <span className="label">API key</span>
                  <input className="input" type="password" value={embedKey}
                    onChange={(e) => setEmbedKey(e.target.value)}
                    onBlur={() => embedKey && window.karen.setSecret("embedKey", embedKey)} />
                  <span className="help">
                    Stored in the keyring and injected into the agent's environment as{" "}
                    <code>KAREN_EMBED_KEY</code>. Never written to disk in the VM.
                  </span>
                </div>
              </div>

            </>
          ) : null}

          {tab === "transcription" ? (
            <div className="section">
              <div className="section-title">Transcription</div>
              <div className="help">
                Used by dictation and by meeting notes. Unlike the language model, this one
                <em> is</em> contacted by the app itself, because the audio is captured here —
                saving a URL adds its origin to the egress allowlist automatically, and nothing
                else is added.
              </div>
              <div className="field">
                <span className="label">Base URL</span>
                <input className="input" placeholder="http://127.0.0.1:8000/v1"
                  value={s.transcription.baseUrl}
                  onChange={(e) => setS({ ...s, transcription: { ...s.transcription, baseUrl: e.target.value } })}
                  onBlur={() => save({ transcription: s.transcription })} />
                <span className="help">
                  This runs on <em>this</em> machine, so <code>127.0.0.1</code> — not{" "}
                  <code>10.0.2.2</code>, which is how the VM reaches the language model.
                </span>
              </div>
              <div className="field">
                <span className="label">Model</span>
                <input className="input" placeholder="Systran/faster-whisper-large-v3"
                  value={s.transcription.model ?? ""}
                  onChange={(e) => setS({ ...s, transcription: { ...s.transcription, model: e.target.value } })}
                  onBlur={() => save({ transcription: s.transcription })} />
                <span className="help">
                  The id the endpoint serves it under. Meeting notes live or die on how well
                  names and jargon transcribe, so this is worth the larger model.
                </span>
              </div>
              <div className="field">
                <span className="label">API key {status.vault.usable ? "" : "(session only)"}</span>
                <input className="input" type="password" placeholder="leave blank if the server needs none"
                  value={sttKey} onChange={(e) => setSttKey(e.target.value)}
                  onBlur={() => sttKey && window.karen.setSecret("transcriptionKey", sttKey)} />
              </div>
              <div className="row">
                <button className="btn btn-primary" disabled={sttTesting || !s.transcription.baseUrl}
                  onClick={testTranscription}>
                  {sttTesting ? "Testing…" : "Test connection"}
                </button>
              </div>
              {sttMsg ? <div className="help">{sttMsg}</div> : null}
              {sttModels.length ? (
                <div className="field">
                  <span className="label">Models this endpoint serves</span>
                  <div className="code-block" style={{ maxHeight: 180 }}>
                    {sttModels.map((m) => (
                      <div key={m} className="pick-row" onClick={() => {
                        const next = { ...s.transcription, model: m };
                        setS({ ...s, transcription: next });
                        void save({ transcription: next });
                      }}>
                        {m}
                      </div>
                    ))}
                  </div>
                  <span className="help">Click one to use it.</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "dictation" ? (
            <div className="section">
              <div className="section-title">Hotkey</div>

              {hotkey?.supported === false ? (
                <div className="warn">
                  This desktop cannot register a global shortcut from the app
                  {hotkey.reason ? `: ${hotkey.reason}` : ""}. You can still bind a key by hand in
                  your desktop's keyboard settings, pointing it at <code>karen-ctl dictate-toggle</code>.
                </div>
              ) : (
                <>
                  <div className="field">
                    <span className="label">Key combination</span>
                    <div className="row">
                      <input
                        className="input"
                        placeholder="&lt;Super&gt;&lt;Alt&gt;d"
                        value={s.dictationHotkey}
                        onChange={(e) => setS({ ...s, dictationHotkey: e.target.value })}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={capturing || !s.dictationHotkey.trim()}
                        onClick={async () => {
                          setCapturing(true);
                          setHotkeyMsg(undefined);
                          try {
                            const r = await window.karen.hotkeyInstall(s.dictationHotkey.trim());
                            setHotkey(r);
                            setHotkeyMsg(
                              r.conflicts?.length
                                ? `Bound, but ${r.conflicts.join(" and ")} already uses this combination — one of them will win.`
                                : `Bound to ${s.dictationHotkey}. Press it anywhere to dictate.`,
                            );
                          } catch (err) {
                            setHotkeyMsg((err as Error).message);
                          } finally {
                            setCapturing(false);
                          }
                        }}
                      >
                        {hotkey?.installed ? "Rebind" : "Bind"}
                      </button>
                      {hotkey?.installed ? (
                        <button
                          className="btn"
                          onClick={async () => {
                            setHotkey(await window.karen.hotkeyRemove());
                            setHotkeyMsg("Removed.");
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <span className="help">
                      GNOME's own format: modifiers in angle brackets, then the key —
                      <code>&lt;Super&gt;&lt;Alt&gt;d</code>. Karen registers this as a normal
                      desktop shortcut, so it also appears in Settings → Keyboard, and it works
                      while Karen is in the background. Press once to start, again to transcribe.
                    </span>
                  </div>

                  {hotkeyMsg ? <div className="help">{hotkeyMsg}</div> : null}

                  {hotkey?.installed && hotkey.socketReady === false ? (
                    <div className="warn">
                      The shortcut is registered, but Karen could not open its control socket, so
                      pressing it will do nothing. Restart Karen.
                    </div>
                  ) : null}
                </>
              )}

              <div className="section-title">Microphone</div>
              <div className="field">
                <span className="label">Input device</span>
                <select
                  className="select"
                  value={s.dictationSource}
                  onChange={(e) => { setS({ ...s, dictationSource: e.target.value }); void save({ dictationSource: e.target.value }); }}
                >
                  <option value="">System default</option>
                  {mics.map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.description}</option>
                  ))}
                </select>
                <span className="help">
                  Audio is recorded on this machine and sent only to the transcription endpoint
                  above. It is never routed into the VM, and the file is deleted once transcribed.
                </span>
              </div>
              <div className="field">
                <span className="label">Language</span>
                <input
                  className="input"
                  placeholder="auto-detect"
                  value={s.dictationLanguage}
                  onChange={(e) => setS({ ...s, dictationLanguage: e.target.value })}
                  onBlur={() => save({ dictationLanguage: s.dictationLanguage })}
                />
                <span className="help">
                  Two-letter code such as <code>en</code>. Naming the language is usually faster
                  and more accurate than letting the model detect it. Leave blank to auto-detect.
                </span>
              </div>
            </div>
          ) : null}

          {tab === "paths" ? (
            <>
              <div className="section">
                <div className="section-title">Where your notes are saved</div>
                <div className="help">
                  Meeting reports, research write-ups and anything else Karen produces for you
                  land in the vault, inside the subfolder below. Nothing is written outside it —
                  paths are resolved before the check, so a symlink pointing out is refused too.
                </div>
                <PathField
                  label="Vault"
                  placeholder="/home/you/Documents/Obsidian/Vault"
                  value={s.vaultRoot}
                  onChange={(v) => { setS({ ...s, vaultRoot: v }); void save({ vaultRoot: v }); }}
                  help="An Obsidian vault, or any folder you keep notes in."
                />
                <div className="field">
                  <span className="label">Subfolder Karen may write to</span>
                  <input className="input" value={s.vaultWriteSubdir}
                    onChange={(e) => setS({ ...s, vaultWriteSubdir: e.target.value })}
                    onBlur={() => save({ vaultWriteSubdir: s.vaultWriteSubdir })} />
                  <span className="help">
                    {s.vaultRoot
                      ? `Everything lands under ${s.vaultRoot}/${s.vaultWriteSubdir || "Karen"}/`
                      : "Choose a vault above to see where files will land."}
                  </span>
                </div>
                <div className="field">
                  <span className="label">Meeting notes subfolder</span>
                  <input className="input" placeholder="Meetings"
                    value={s.meetingReportDir}
                    onChange={(e) => setS({ ...s, meetingReportDir: e.target.value })}
                    onBlur={() => save({ meetingReportDir: s.meetingReportDir })} />
                  <span className="help">
                    {s.vaultRoot
                      ? `Reports and transcripts go to ${s.vaultRoot}/${s.vaultWriteSubdir || "Karen"}/${s.meetingReportDir || "Meetings"}/`
                      : "Inside the subfolder above."}
                  </span>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Recordings</div>
                <PathField
                  label="Meeting recordings"
                  value={s.meetingsRoot}
                  onChange={(v) => { setS({ ...s, meetingsRoot: v }); void save({ meetingsRoot: v }); }}
                  help="Audio is kept here until it is transcribed. An hour of a meeting is roughly 230 MB."
                />
                <label className="check">
                  <input type="checkbox" checked={s.deleteRawAudioAfterTranscription}
                    onChange={(e) => {
                      setS({ ...s, deleteRawAudioAfterTranscription: e.target.checked });
                      void save({ deleteRawAudioAfterTranscription: e.target.checked });
                    }} />
                  <span>Delete the audio once the transcript is written</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.meetingCaptureSystemAudio}
                    onChange={(e) => {
                      setS({ ...s, meetingCaptureSystemAudio: e.target.checked });
                      void save({ meetingCaptureSystemAudio: e.target.checked });
                    }} />
                  <span>Record the system's audio as well as the microphone</span>
                </label>
                <span className="help">
                  Leave this on for remote meetings. On headphones a microphone records you and
                  nobody else, so without it the transcript is one side of the conversation.
                </span>
              </div>

              <div className="section">
                <div className="section-title">The agent's own folder</div>
                <div className="field">
                  <span className="label">Workspace (inside the VM)</span>
                  <input className="input" value={s.workspaceRoot}
                    onChange={(e) => setS({ ...s, workspaceRoot: e.target.value })}
                    onBlur={() => save({ workspaceRoot: s.workspaceRoot })} />
                  <span className="help">
                    Drafts and documents are written here, and writes here are auto-approved in
                    Guarded mode. This one is typed rather than browsed: it is a path on the VM,
                    which this machine's file dialog cannot see.
                  </span>
                </div>
              </div>
            </>
          ) : null}

          {tab === "pairing" ? (
            <div className="section">
              <div className="section-title">Pair the VM</div>
              <div className="help">
                Run this inside the VM once. The VM dials out to this app — nothing needs to reach
                into the VM, so no hypervisor port forwarding is required.
              </div>
              <div className="field">
                <span className="label">Setup command</span>
                <div className="code-block">
{`mkdir -p ~/.config/karen && chmod 700 ~/.config/karen
printf '%s' '${reveal && pairing ? pairing.token : "•".repeat(43)}' > ~/.config/karen/token
chmod 600 ~/.config/karen/token
cat > ~/.config/karen/bridge.json <<'JSON'
{ "hostUrl": "ws://10.0.2.2:${pairing?.port ?? 8765}" }
JSON`}
                </div>
                <div className="row">
                  <button className="btn" onClick={() => setReveal((r) => !r)}>
                    {reveal ? "Hide token" : "Reveal token"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "privacy" ? (
            <>
            <div className="section">
              <div className="section-title">Stored conversations</div>
              <div className="help">
                Chats live as files in the VM and never leave it. Deleting a chat also deletes the
                research runs it started — their retrieved sources, extracted passages and reports.
                Research runs that no chat started are left alone.
              </div>
              {cleared ? <div className="help">{cleared}</div> : null}
              <div className="field">
                {clearing ? (
                  <div className="warn">
                    <div>Delete every chat and everything they produced? This cannot be undone.</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost" onClick={() => setClearing(false)}>Cancel</button>
                      <button
                        className="btn btn-danger"
                        onClick={async () => {
                          const r = await window.karen.deleteAllSessions();
                          setCleared(
                            `Deleted ${r?.sessions ?? 0} chat(s)` +
                              (r?.runsDeleted ? ` and ${r.runsDeleted} research run(s).` : "."),
                          );
                          setClearing(false);
                          // The rail is still showing the chats that just went,
                          // and the open transcript now has no file behind it.
                          onSessionsCleared();
                        }}
                      >
                        Delete everything
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-danger" onClick={() => setClearing(true)}>
                    Delete all chats…
                  </button>
                )}
              </div>
            </div>

            <div className="section">
              <div className="section-title">Network activity</div>
              <div className="help">
                Every connection this app attempted. Requests off the allowlist are cancelled, not
                merely logged. Research traffic never appears here: it happens in the VM.
              </div>
              <div className="code-block" style={{ maxHeight: 300 }}>
                {activity.length === 0 ? "No outbound requests recorded."
                  : activity.slice().reverse().map((a, i) => (
                      <div key={i} style={{ color: a.allowed ? "var(--green)" : "var(--red)" }}>
                        {a.allowed ? "ALLOW" : "BLOCK"}  {a.url}  ({a.reason})
                      </div>
                    ))}
              </div>
              <button className="btn" onClick={() => window.karen.clearNetworkActivity().then(() => setActivity([]))}>
                Clear log
              </button>
            </div>
            </>
          ) : null}
        </div>

        <div className="modal-foot">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
