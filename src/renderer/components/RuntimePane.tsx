import { useCallback, useEffect, useState } from "react";
import type { LocalModel, RuntimeDevice, RuntimeState } from "../types.ts";
import { ModelBrowser } from "./ModelBrowser.tsx";

/**
 * Running a model on this machine, without a terminal.
 *
 * Opt-in, and it says so: Karen works against an endpoint you point it at, and
 * this exists so that you do not have to have one. Nothing here is reachable by
 * the model — installing a runtime, downloading a model and starting a process
 * are all things a person does by pressing a button.
 *
 * There is no background update check anywhere in this app. Updates happen when
 * the button below is pressed and at no other time, which is the whole reason
 * it is a button.
 */

const BACKENDS: { id: string; label: string; hint: string }[] = [
  { id: "vulkan", label: "Vulkan", hint: "Works with NVIDIA, AMD and Intel cards" },
  { id: "cuda", label: "CUDA", hint: "NVIDIA only, Windows only, and a much larger download" },
  { id: "rocm", label: "ROCm", hint: "AMD's own driver stack" },
  { id: "metal", label: "Metal", hint: "Built into the macOS build" },
  { id: "cpu", label: "Processor", hint: "Always works, and is much slower" },
];

function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function rate(bytesPerSecond: number): string {
  if (!bytesPerSecond) return "";
  return `${gb(bytesPerSecond)}/s`;
}

export function RuntimePane() {
  const [state, setState] = useState<RuntimeState | undefined>();
  const [devices, setDevices] = useState<RuntimeDevice[]>([]);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const next = (await window.karen.runtimeState()) as RuntimeState & { devices?: RuntimeDevice[] };
    setState(next);
    if (next.devices?.length) setDevices(next.devices);
  }, []);

  const refreshModels = useCallback(async () => {
    setModels((await window.karen.runtimeModels()) as LocalModel[]);
  }, []);

  useEffect(() => {
    void refresh();
    void refreshModels();
    return window.karen.onRuntime((next) => setState(next as RuntimeState));
  }, [refresh, refreshModels]);

  if (!state) return null;

  const { config, phase, server, suggestion, activeBuild } = state;
  const installed = Boolean(activeBuild);

  const patch = async (changes: Partial<RuntimeState["config"]>): Promise<void> => {
    await window.karen.runtimeConfig(changes);
    await refresh();
  };

  const setUp = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    const result = (await window.karen.runtimeSetUp()) as
      { ok: boolean; note?: string; error?: string; devices?: RuntimeDevice[] };
    setBusy(false);
    if (result.ok) {
      setNote(result.note);
      setDevices(result.devices ?? []);
      await refresh();
      await refreshModels();
    } else {
      setError(result.error);
    }
  };

  const install = async (backend: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const tag = activeBuild?.tag ?? state.baseline;
    const result = (await window.karen.runtimeInstall(tag, backend)) as
      { ok: boolean; error?: string; devices?: RuntimeDevice[]; accelerated?: boolean };
    setBusy(false);
    if (result.ok) {
      setDevices(result.devices ?? []);
      setNote(
        result.accelerated
          ? undefined
          : "That build started, but found no GPU on this machine — it will run on the processor.",
      );
      await refresh();
    } else {
      setError(result.error);
    }
  };

  const checkUpdates = async (): Promise<void> => {
    setUpdateNote("checking…");
    const result = (await window.karen.runtimeCheckUpdates()) as
      { ok: boolean; current?: string; newest?: string; behind?: number; error?: string };
    if (!result.ok) {
      setUpdateNote(result.error);
      return;
    }
    if (!result.newest || result.newest === result.current) {
      setUpdateNote("You have the newest build.");
      return;
    }
    // Upstream ships several builds a day, so "newer exists" is not the same
    // recommendation it would be for a normal release feed. Say so.
    setUpdateNote(
      `${result.newest} is available (you have ${result.current}). llama.cpp publishes several ` +
        `builds most days, so a newer one is not necessarily a better one — these are upstream ` +
        `nightlies, not tested releases.`,
    );
  };

  const start = async (path?: string): Promise<void> => {
    setError(undefined);
    const result = (await window.karen.runtimeStart(path)) as { ok: boolean; error?: string };
    if (!result.ok && result.error) setError(result.error);
    await refresh();
  };

  return (
    <div className="pane">
      <p className="pane-lead">
        Karen can run a model on this machine, so nothing you type leaves it. This is optional — if
        you already point Karen at an endpoint of your own, you can ignore all of it.
      </p>

      {error ? <p className="warning" role="alert">{error}</p> : null}
      {note ? <p className="hint note">{note}</p> : null}

      {/* ------------------------------------------------------ the engine -- */}
      <fieldset className="endpoint">
        <legend>Engine</legend>

        {!installed ? (
          <>
            <p className="hint">
              Karen will look at this machine, download the right build of llama.cpp
              (about 30 MB), and check that it works before recommending a model.
            </p>
            <p className="hint">{suggestion.reason}</p>
            <div className="endpoint-actions">
              <button type="button" onClick={() => void setUp()} disabled={busy}>
                {busy ? "Setting up…" : "Set up a local model"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="runtime-current">
              <strong>{activeBuild!.tag}</strong>
              <span className="pill">{activeBuild!.backend}</span>
            </p>

            {devices.length ? (
              <ul className="runtime-devices">
                {devices.map((d) => (
                  <li key={d.id}>
                    <code>{d.id}</code> {d.description}
                    {d.totalBytes ? <span className="dim"> — {gb(d.totalBytes)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">
                No graphics acceleration was found, so models run on the processor.
              </p>
            )}

            <label>
              Build
              <select
                value={config.backendOverride ?? activeBuild!.backend}
                onChange={(e) => void install(e.target.value)}
                disabled={busy}
              >
                {BACKENDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} — {b.hint}
                  </option>
                ))}
              </select>
            </label>

            <div className="endpoint-actions">
              <button type="button" onClick={() => void checkUpdates()} disabled={busy}>
                Check for updates
              </button>
              <button type="button" onClick={() => void window.karen.runtimeProbe().then(refresh)}>
                Re-check hardware
              </button>
              {updateNote ? <span className="status">{updateNote}</span> : null}
            </div>
          </>
        )}

        {phase.kind !== "idle" ? (
          <div className="runtime-progress">
            {phase.kind === "downloading" ? (
              <>
                <div className="bar">
                  <span
                    style={{
                      width: phase.totalBytes
                        ? `${Math.round((phase.receivedBytes / phase.totalBytes) * 100)}%`
                        : "100%",
                    }}
                  />
                </div>
                <span className="dim">
                  {phase.what} — {gb(phase.receivedBytes)}
                  {phase.totalBytes ? ` of ${gb(phase.totalBytes)}` : ""} {rate(phase.bytesPerSecond)}
                </span>
              </>
            ) : (
              <span className="dim">
                {phase.kind === "extracting" ? "Unpacking" : "Checking what your hardware can do"} — {phase.what}
              </span>
            )}
            <button type="button" onClick={() => void window.karen.runtimeCancel()}>
              Cancel
            </button>
          </div>
        ) : null}
      </fieldset>

      {/* ------------------------------------------------------- the model -- */}
      {installed ? (
        <fieldset className="endpoint">
          <legend>Models</legend>

          {models.length === 0 ? (
            <p className="hint">
              No models yet. Karen also looks in LM Studio's and llama.cpp's folders, so if you
              have models there they will appear here without being downloaded again.
            </p>
          ) : (
            <ul className="model-list">
              {models.map((m) => (
                <li key={m.path} className={config.activeModel === m.path ? "active" : ""}>
                  <div className="model-row">
                    <span className="model-name">{m.name}</span>
                    <span className="pill">{m.source}</span>
                    <span className="dim">{gb(m.size)}</span>
                  </div>
                  {m.fit ? <p className={`fit fit-${m.fit.verdict}`}>{m.fit.label}</p> : null}
                  {m.shape?.hasChatTemplate === false ? (
                    <p className="fit fit-too-large">
                      This file has no chat template, so it cannot hold a conversation.
                    </p>
                  ) : null}
                  <div className="endpoint-actions">
                    <button
                      type="button"
                      onClick={() => void start(m.path)}
                      disabled={server.state === "starting"}
                    >
                      {config.activeModel === m.path && server.state === "ready" ? "Restart" : "Use this model"}
                    </button>
                    {m.source === "Karen" ? (
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          void window.karen.runtimeDeleteModel(m.path).then(() => void refreshModels())
                        }
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="endpoint-actions">
            <button type="button" onClick={() => setBrowsing(true)}>
              Find models
            </button>
            <button type="button" onClick={() => void refreshModels()}>
              Rescan
            </button>
          </div>
        </fieldset>
      ) : null}

      {/* ------------------------------------------------------ the server -- */}
      {installed ? (
        <fieldset className="endpoint">
          <legend>Server</legend>

          <p className="runtime-current">
            <span className={`dot dot-${server.state}`} />
            {server.state === "ready"
              ? "Running"
              : server.state === "starting"
                ? "Loading the model — this can take a while for a large one"
                : server.state === "failed"
                  ? "Stopped after an error"
                  : "Not running"}
          </p>
          {server.error ? <p className="warning">{server.error}</p> : null}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.useForChat}
              onChange={(e) => void patch({ useForChat: e.target.checked })}
            />
            Use this model for chat and research
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.startOnLaunch}
              onChange={(e) => void patch({ startOnLaunch: e.target.checked })}
            />
            Start it when Karen opens
          </label>

          <div className="endpoint-actions">
            {server.state === "ready" || server.state === "starting" ? (
              <button type="button" onClick={() => void window.karen.runtimeStop().then(refresh)}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                disabled={!config.activeModel}
                title={config.activeModel ? undefined : "Choose a model first"}
              >
                Start
              </button>
            )}
            <button type="button" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide log" : "Show log"}
            </button>
          </div>

          {showLog ? (
            <pre className="runtime-log">
              {server.log.length ? server.log.join("\n") : "Nothing logged yet."}
            </pre>
          ) : null}
        </fieldset>
      ) : null}

      {browsing ? (
        <ModelBrowser
          onClose={() => {
            setBrowsing(false);
            void refreshModels();
          }}
        />
      ) : null}
    </div>
  );
}
