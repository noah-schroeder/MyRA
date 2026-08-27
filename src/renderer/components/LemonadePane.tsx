/**
 * The runtime, as Lemonade reports it.
 *
 * Karen used to work this out for itself -- run a build with --list-devices,
 * infer a backend from PCI vendor ids, and write its own sentence about why a
 * card was not being used. All three now come from one request, and the third
 * comes back better than Karen wrote it: the daemon states a reason per device
 * and per backend, so what is shown here stays true as its hardware support
 * changes rather than as this file is maintained.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DownloadJob, MachineInfo } from "../../core/runtime/systemInfo.ts";

/** Upstream's ids are terse; these are what a person should read. */
const BACKEND_LABELS: Record<string, string> = {
  cuda: "CUDA — NVIDIA cards",
  rocm: "ROCm — AMD cards",
  vulkan: "Vulkan — works with most cards",
  metal: "Metal — Apple silicon",
  cpu: "Processor only",
  system: "A llama.cpp already on this machine",
};

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—";
}

export function LemonadePane() {
  const [info, setInfo] = useState<MachineInfo | undefined>();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<string | undefined>();
  const [models, setModels] = useState<{ id: string; downloaded?: boolean }[]>([]);
  const [loaded, setLoaded] = useState<string | undefined>();
  const running = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.karen.lemonadeInfo();
    if (res.ok && res.info) {
      setInfo(res.info);
      setError(undefined);
    } else if (res.error) setError(res.error);
    const list = await window.karen.lemonadeModels();
    if (list.ok) {
      setModels(list.models);
      setLoaded(list.loaded);
    }
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setPhase("starting Lemonade");
    const res = await window.karen.lemonadeEnsure();
    setBusy(false);
    setPhase(undefined);
    if (!res.ok) setError(res.error);
    else await refresh();
    running.current = false;
  }, [refresh]);

  useEffect(() => { void start(); }, [start]);

  /* Only while something is actually transferring: the daemon owns the
     download now, so this is the only window onto it -- but polling an idle
     server every second for the life of the app would be waste. */
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      void window.karen.lemonadeDownloads().then((r) => setJobs(r.jobs.filter((j) => !j.complete)));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const install = async (backend: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setPhase(`installing the ${BACKEND_LABELS[backend] ?? backend} backend`);
    const res = await window.karen.lemonadeInstallBackend("llamacpp", backend);
    setBusy(false);
    setPhase(undefined);
    setJobs([]);
    if (!res.ok) setError(res.error);
    else if (res.info) setInfo(res.info);
  };

  const load = async (id: string): Promise<void> => {
    setBusy(true);
    setPhase(`loading ${id}`);
    const res = id === loaded ? await window.karen.lemonadeUnload() : await window.karen.lemonadeLoad(id);
    setBusy(false);
    setPhase(undefined);
    if (!res.ok) setError(res.error);
    setLoaded(id === loaded ? undefined : id);
  };

  const installable = (info?.backends ?? []).filter((b) => b.state !== "unsupported");
  const blocked = (info?.backends ?? []).filter((b) => b.state === "unsupported" && b.message);

  return (
    <section className="pane-block">
      <h4 className="pane-sub">Inference engine</h4>

      {phase ? <p className="hint">{phase}…</p> : null}
      {error ? <p className="hint error">{error}</p> : null}

      {jobs.map((j) => (
        <p key={j.id} className="hint">
          {j.label}: {j.percent ?? 0}% of {gb(j.bytesTotal)}
        </p>
      ))}

      {info ? (
        <>
          {info.devices.length ? (
            <ul className="device-list">
              {info.devices.map((d) => (
                <li key={d.id}>
                  <span className="build-tag">{d.description}</span>
                  <span className="pill">{gb(d.totalBytes)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="hint">No graphics acceleration was found, so models run on the processor.</p>
              {/* The daemon's own sentence, not one composed here. */}
              {info.note ? <p className="hint note">{info.note}</p> : null}
            </>
          )}

          <p className="hint">
            {gb(info.ramBytes)} memory
            {info.modelStorageFreeBytes ? ` · ${gb(info.modelStorageFreeBytes)} free for models` : ""}
            {info.driverVersion ? ` · driver ${info.driverVersion}` : ""}
          </p>

          <h4 className="pane-sub">Backends</h4>
          <ul className="device-list">
            {installable.map((b) => (
              <li key={b.id}>
                <span className="build-tag">{BACKEND_LABELS[b.id] ?? b.id}</span>
                <span className="pill">{b.state}</span>
                <span className="build-spacer" />
                {b.state === "installable" ? (
                  <button type="button" onClick={() => void install(b.id)} disabled={busy}>
                    Install
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          <h4 className="pane-sub">Models</h4>
          {models.length ? (
            <ul className="device-list">
              {models.map((m) => (
                <li key={m.id}>
                  <span className="build-tag">{m.id}</span>
                  {m.downloaded ? <span className="pill">on this machine</span> : null}
                  {m.id === loaded ? <span className="pill">loaded</span> : null}
                  <span className="build-spacer" />
                  <button type="button" onClick={() => void load(m.id)} disabled={busy}>
                    {m.id === loaded ? "Unload" : "Load"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              No models yet. Anything already in Karen&apos;s models folder is picked up
              automatically.
            </p>
          )}

          {blocked.length ? (
            <p className="hint">
              Not available here: {blocked.map((b) => `${b.id} (${b.message})`).join(", ")}.
            </p>
          ) : null}
        </>
      ) : (
        !error ? <p className="hint">Looking at this machine…</p> : null
      )}
    </section>
  );
}
