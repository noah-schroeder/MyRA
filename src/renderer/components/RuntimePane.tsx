import { useCallback, useEffect, useState } from "react";

import { LemonadePane } from "./LemonadePane.tsx";
import type {
  LocalModel, RuntimeDevice, RuntimeDiagnosis, RuntimeState,
} from "../types.ts";

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

/**
 * How each backend is described. WHICH of them appear is decided by the main
 * process, in `availableBackends` -- this pane used to hold its own list of all
 * five and show every one on every platform, so Linux was offered Metal, and
 * CUDA carried the label "Windows only" long after Linux CUDA started working.
 * A dropdown that talks someone out of the right choice is worse than one that
 * omits it.
 */
const BACKEND_LABELS: Record<string, { label: string; hint: string }> = {
  vulkan: { label: "Vulkan", hint: "Works with NVIDIA, AMD and Intel cards" },
  cuda: {
    label: "CUDA",
    hint: "NVIDIA only, and the fastest option on their cards",
  },
  rocm: { label: "ROCm", hint: "AMD's own driver stack" },
  metal: { label: "Metal", hint: "Built into the macOS build" },
  cpu: { label: "Processor", hint: "Always works, and is much slower" },
};

const FALLBACK_BACKENDS = ["vulkan", "cpu"];

function gb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function rate(bytesPerSecond: number): string {
  if (!bytesPerSecond) return "";
  return `${gb(bytesPerSecond)}/s`;
}

export function RuntimePane({ onOpenHub }: { onOpenHub?: () => void }) {
  const [state, setState] = useState<RuntimeState | undefined>();
  const [devices, setDevices] = useState<RuntimeDevice[]>([]);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | undefined>();
  const [diagnosis, setDiagnosis] = useState<RuntimeDiagnosis | undefined>();
  /** Set once a check has found a build newer than the running one. */
  const [available, setAvailable] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const next = (await window.karen.runtimeState()) as RuntimeState & { devices?: RuntimeDevice[] };
    setState(next);
    if (next.devices?.length) setDevices(next.devices);

    /*
     * Diagnose whenever there is nothing to accelerate with, not only in the
     * moment after an install.
     *
     * The first version of this asked only inside `install()`, which meant the
     * explanation appeared once, in a note, and was gone as soon as the pane was
     * reopened -- so someone looking at "No graphics acceleration was found" on
     * an already-installed CUDA build, which is exactly the person who needs it,
     * saw nothing at all.
     *
     * Guarded on a build being installed, because with no runtime at all the
     * answer is "install one" rather than anything about drivers.
     */
    if (next.activeBuild && !next.devices?.length) {
      setDiagnosis(await window.karen.runtimeDiagnose());
    } else {
      setDiagnosis(undefined);
    }
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
    const result = await window.karen.runtimeInstall(tag, backend);
    setBusy(false);
    if (result.ok) {
      setDevices(result.devices ?? []);
      const model = result.unloaded
        ? `${result.unloaded} was unloaded — press Start to load it again.`
        : "";
      if (result.accelerated) {
        setNote(model || undefined);
      } else {
        /*
         * "found no GPU" is true and useless on its own.
         *
         * ggml loads its backends with dlopen and treats one that fails to
         * initialise exactly like one that is absent, so a driver too old for
         * the build reads identically to a machine with no card. The driver
         * can distinguish them; ask it, and show what the probe actually
         * printed, rather than leaving someone with a working 4060 to guess.
         */
        setNote(
          `That build started, but found no GPU on this machine — it will run on the processor. ${model}`,
        );
      }
      // refresh() fetches the diagnosis when there is one to fetch.
      await refresh();
    } else {
      setError(result.error);
    }
  };

  const checkUpdates = async (): Promise<void> => {
    setUpdateNote("checking…");
    setAvailable(undefined);
    const result = await window.karen.runtimeCheckUpdates();
    if (!result.ok) {
      setUpdateNote(result.error);
      return;
    }
    if (!result.newest || result.newest === result.current) {
      setUpdateNote("You have the newest build.");
      return;
    }
    // Upstream ships several builds a day, so "newer exists" is not the same
    // recommendation it would be for a normal release feed. Say so, and leave
    // the decision to install with the person reading it.
    setAvailable(result.newest);
    setUpdateNote(
      `${result.newest} is available. llama.cpp publishes several builds most days, so a newer ` +
        `one is not necessarily a better one — these are upstream nightlies, not tested releases. ` +
        `The build you have now stays installed, so you can go back.`,
    );
  };

  /**
   * Install what the check found.
   *
   * The old build is left on disk and the active pointer only moves once the
   * new one has downloaded, verified, unpacked and answered --list-devices --
   * so the worst case of pressing this is that you press "Use" on the previous
   * build in the list below.
   */
  const installUpdate = async (tag: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setUpdateNote(undefined);
    const result = await window.karen.runtimeUpdate(tag);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAvailable(undefined);
    setUpdateNote(
      result.unchanged
        ? "You already had that build."
        : `Now running ${result.build}. ${result.from} is still installed below.` +
          (result.unloaded
            ? ` ${result.unloaded} was unloaded so it does not keep running on the old engine — ` +
              `press Start to load it again.`
            : ""),
    );
    if (result.devices) setDevices(result.devices);
    await refresh();
  };

  const useBuild = async (id: string): Promise<void> => {
    setError(undefined);
    const result = await window.karen.runtimeActivate(id);
    if (!result.ok) setError(result.error);
    else if (result.devices) setDevices(result.devices);
    setUpdateNote(
      result.ok
        ? `Now running ${id}.` +
          (result.unloaded ? ` ${result.unloaded} was unloaded — press Start to load it again.` : "")
        : undefined,
    );
    await refresh();
  };

  const removeBuild = async (id: string): Promise<void> => {
    const result = await window.karen.runtimeRemoveBuild(id);
    if (!result.ok) setError(result.error);
    await refresh();
  };

  const start = async (path?: string): Promise<void> => {
    setError(undefined);
    const result = (await window.karen.runtimeStart(path)) as { ok: boolean; error?: string };
    if (!result.ok && result.error) setError(result.error);
    await refresh();
  };

  return (
    <div className="pane">
      <LemonadePane />
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

            {/* The reason, when one can be established. Sits directly under the
                message it explains: ggml cannot tell "driver too old" from "no
                card", so without this both read as "you have no GPU". */}
            {diagnosis && !devices.length ? (
              <div className="diagnosis">
                {diagnosis.explanation ? <p className="hint note">{diagnosis.explanation}</p> : null}
                {diagnosis.nvidia.driverVersion ? (
                  <p className="hint">
                    Driver {diagnosis.nvidia.driverVersion}
                    {diagnosis.nvidia.cudaCeiling
                      ? `, supports CUDA up to ${diagnosis.nvidia.cudaCeiling}`
                      : ""}
                    {diagnosis.nvidia.names.length ? ` — ${diagnosis.nvidia.names.join(", ")}` : ""}
                  </p>
                ) : (
                  <p className="hint">nvidia-smi found no driver on this machine.</p>
                )}
                {diagnosis.probeLog ? (
                  <>
                    <p className="hint">What the build printed when it looked for devices:</p>
                    <pre className="runtime-log">{diagnosis.probeLog}</pre>
                  </>
                ) : null}
                {/* The remedy, next to the reason.
                    Without this the only way to reinstall the build you already
                    have is the Build dropdown -- and choosing the option that is
                    already selected fires no change, so someone whose CUDA build
                    needs replacing would have to switch to Vulkan and back to
                    discover it. */}
                {diagnosis.repairable && activeBuild ? (
                  <button
                    type="button"
                    onClick={() => void install(activeBuild.backend)}
                    disabled={busy}
                  >
                    {busy
                      ? "Installing…"
                      : `Install the ${
                          BACKEND_LABELS[activeBuild.backend]?.label ?? activeBuild.backend
                        } build again`}
                  </button>
                ) : null}
              </div>
            ) : null}

            <label>
              Build
              <select
                value={config.backendOverride ?? activeBuild!.backend}
                onChange={(e) => void install(e.target.value)}
                disabled={busy}
              >
                {(state?.backends ?? FALLBACK_BACKENDS).map((id) => {
                  const b = BACKEND_LABELS[id] ?? { label: id, hint: "" };
                  return (
                    <option key={id} value={id}>
                      {b.hint ? `${b.label} — ${b.hint}` : b.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <div className="endpoint-actions">
              <button type="button" onClick={() => void checkUpdates()} disabled={busy}>
                Check for updates
              </button>
              {available ? (
                <button
                  type="button"
                  className="primary-sm"
                  onClick={() => void installUpdate(available)}
                  disabled={busy}
                >
                  {busy ? "Installing…" : `Install ${available}`}
                </button>
              ) : null}
              <button type="button" onClick={() => void window.karen.runtimeProbe().then(refresh)}>
                Re-check hardware
              </button>
            </div>
            {updateNote ? <p className="hint note">{updateNote}</p> : null}

            {/*
              * Every build ever installed, and a way back to it.
              *
              * This is what makes the update button safe to press: builds go
              * into their own directories and never overwrite each other, so
              * "that nightly is worse" costs a click rather than a download.
              */}
            {state.builds.length > 1 ? (
              <>
                <h4 className="pane-sub">Installed builds</h4>
                <ul className="build-list">
                  {state.builds.map((b) => (
                    <li key={b.id} className={b.id === activeBuild!.id ? "active" : ""}>
                      <span className="build-tag">{b.tag}</span>
                      <span className="pill">{b.backend}</span>
                      <span className="build-spacer" />
                      {b.id === activeBuild!.id ? (
                        <span className="dim">in use</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => void useBuild(b.id)} disabled={busy}>
                            Use
                          </button>
                          <button type="button" className="danger" onClick={() => void removeBuild(b.id)}>
                            Remove
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
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
          <p className="hint">
            {models.length === 0
              ? "No models yet. Karen also looks in LM Studio's and llama.cpp's folders, so if you " +
                "have models there they will appear without being downloaded again."
              : `${models.length} model${models.length === 1 ? "" : "s"} on this machine.`}
          </p>
          {/*
            * Choosing a model is its own screen now, not a list in a dialog.
            * Comparing quantisations against what this machine can hold is a
            * task with real content in it -- sizes, fit, what is already
            * downloaded -- and a fieldset in Settings was the wrong shape.
            */}
          <div className="endpoint-actions">
            <button type="button" className="primary-sm" onClick={onOpenHub}>
              Open the model hub
            </button>
            <button type="button" onClick={() => void refreshModels()}>
              Rescan folders
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

    </div>
  );
}
