/**
 * The engines and models Lemonade offers, and what this machine can run.
 *
 * Karen used to work all of this out itself: probe a build for devices, guess a
 * backend from PCI vendor ids, curate a small list of chat models, and write
 * its own sentence about why a card was not being used. All of it now comes
 * from the daemon -- and comes back wider, because Lemonade serves speech,
 * text-to-speech, image and embedding models through the same API as chat.
 *
 * Two decisions shape the layout:
 *
 *   - **Models are grouped by what they do, not by which engine runs them.**
 *     "Transcription" is a thing an academic wants; "whispercpp" is an
 *     implementation detail they should never have to learn.
 *   - **Every model shows whether it will fit**, using the size from the
 *     catalogue and the memory from the daemon. That guidance is the part of
 *     the old model hub worth keeping, and it survives here unchanged.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { groupCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { fitModel } from "../../core/runtime/fit.ts";
import type { DownloadJob, MachineInfo } from "../../core/runtime/systemInfo.ts";

const BACKEND_LABELS: Record<string, string> = {
  cuda: "NVIDIA (CUDA)",
  rocm: "AMD (ROCm)",
  vulkan: "Vulkan",
  metal: "Apple silicon (Metal)",
  cpu: "Processor",
  npu: "NPU",
  system: "Already on this machine",
};

/** Engine ids are upstream's; these say what each one is for. */
const ENGINE_LABELS: Record<string, string> = {
  llamacpp: "Chat models (llama.cpp)",
  whispercpp: "Transcription (whisper.cpp)",
  moonshine: "Transcription (Moonshine)",
  kokoro: "Speech synthesis (Kokoro)",
  "sd-cpp": "Image generation (Stable Diffusion)",
  vllm: "Chat models (vLLM)",
  flm: "Chat models (FastFlowLM, NPU)",
  "ryzenai-llm": "Chat models (Ryzen AI NPU)",
  onnxruntime: "ONNX Runtime",
  acestep: "Music generation",
  thinksound: "Sound effects",
  thenoise: "Audio models",
  openmoss: "Speech models",
  trellis: "3D generation",
  ds4: "Depth estimation",
};

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1)} GB` : "—";
}

export function LemonadePane() {
  const [info, setInfo] = useState<MachineInfo | undefined>();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<{ id: string; downloaded?: boolean }[]>([]);
  const [loaded, setLoaded] = useState<string | undefined>();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<string | undefined>();
  const [openGroup, setOpenGroup] = useState<string | undefined>("chat");
  const [showAllEngines, setShowAllEngines] = useState(false);
  const starting = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const [infoRes, listRes, catRes] = await Promise.all([
      window.karen.lemonadeInfo(),
      window.karen.lemonadeModels(),
      window.karen.lemonadeCatalog(),
    ]);
    if (infoRes.ok && infoRes.info) setInfo(infoRes.info);
    else if (infoRes.error) setError(infoRes.error);
    if (listRes.ok) {
      setInstalled(listRes.models);
      setLoaded(listRes.loaded);
    }
    if (catRes.ok) setCatalog(catRes.catalog);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setPhase("starting Lemonade");
    const res = await window.karen.lemonadeEnsure();
    setBusy(false);
    setPhase(undefined);
    if (!res.ok) setError(res.error);
    else await refresh();
    starting.current = false;
  }, [refresh]);

  useEffect(() => { void start(); }, [start]);

  /* Only while something is transferring. The daemon owns the download now, so
     this is the only window onto it -- but polling an idle server for the life
     of the app would be waste. */
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      void window.karen.lemonadeDownloads().then((r) => setJobs(r.jobs.filter((j) => !j.complete)));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setPhase(what);
    const res = await fn();
    setBusy(false);
    setPhase(undefined);
    setJobs([]);
    if (!res.ok) setError(res.error);
    await refresh();
  };

  const have = new Set(installed.map((m) => m.id));
  const machine = {
    ...(info?.devices[0]?.totalBytes ? { vramBytes: info.devices[0].totalBytes } : {}),
    ramBytes: info?.ramBytes ?? 0,
  };

  const engines = (info?.engines ?? []).filter((e) =>
    showAllEngines || e.backends.some((b) => b.state === "installed" || b.state === "installable"));

  return (
    <section className="pane-block">
      <h4 className="pane-sub">This machine</h4>
      {phase ? <p className="hint">{phase}…</p> : null}
      {error ? <p className="hint error">{error}</p> : null}
      {jobs.map((j) => (
        <p key={j.id} className="hint">{j.label}: {j.percent ?? 0}% of {gb(j.bytesTotal)}</p>
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

          <h4 className="pane-sub">Engines</h4>
          <p className="hint">
            Each kind of model needs its engine installed once. Karen downloads them through
            Lemonade.
          </p>
          <ul className="device-list">
            {engines.map((engine) => (
              <li key={engine.id}>
                <span className="build-tag">{ENGINE_LABELS[engine.id] ?? engine.id}</span>
                {engine.backends.filter((b) => b.state !== "unsupported").map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    disabled={busy || b.state === "installed"}
                    onClick={() => void run(
                      `installing ${BACKEND_LABELS[b.id] ?? b.id} for ${ENGINE_LABELS[engine.id] ?? engine.id}`,
                      () => window.karen.lemonadeInstallBackend(engine.id, b.id),
                    )}
                  >
                    {b.state === "installed" ? `${BACKEND_LABELS[b.id] ?? b.id} ✓` : `Install ${BACKEND_LABELS[b.id] ?? b.id}`}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          <button type="button" className="link" onClick={() => setShowAllEngines(!showAllEngines)}>
            {showAllEngines ? "Show only what this machine can run" : "Show every engine"}
          </button>

          <h4 className="pane-sub">Models</h4>
          {groupCatalog(catalog).map((group) => (
            <div key={group.id}>
              <button
                type="button"
                className="link"
                onClick={() => setOpenGroup(openGroup === group.id ? undefined : group.id)}
              >
                {openGroup === group.id ? "▾" : "▸"} {group.title} ({group.entries.length})
              </button>
              {openGroup === group.id ? (
                <ul className="device-list">
                  {group.entries.map((m) => {
                    const fit = m.sizeBytes && machine.ramBytes
                      ? fitModel(m.sizeBytes, machine)
                      : undefined;
                    return (
                      <li key={m.id}>
                        <span className="build-tag">{m.id}</span>
                        <span className="pill">{gb(m.sizeBytes)}</span>
                        {m.id === loaded ? <span className="pill">loaded</span> : null}
                        {fit ? <span className="hint">{fit.label}</span> : null}
                        <span className="build-spacer" />
                        {have.has(m.id) ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(
                              m.id === loaded ? `unloading ${m.id}` : `loading ${m.id}`,
                              () => m.id === loaded
                                ? window.karen.lemonadeUnload()
                                : window.karen.lemonadeLoad(m.id),
                            )}
                          >
                            {m.id === loaded ? "Unload" : "Load"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(`downloading ${m.id}`, () => window.karen.lemonadePull(m.id))}
                          >
                            Download
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ))}
          {installed.filter((m) => !catalog.some((c) => c.id === m.id)).length ? (
            <>
              <h4 className="pane-sub">Your own models</h4>
              <ul className="device-list">
                {installed.filter((m) => !catalog.some((c) => c.id === m.id)).map((m) => (
                  <li key={m.id}>
                    <span className="build-tag">{m.id}</span>
                    {m.id === loaded ? <span className="pill">loaded</span> : null}
                    <span className="build-spacer" />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(
                        m.id === loaded ? `unloading ${m.id}` : `loading ${m.id}`,
                        () => m.id === loaded
                          ? window.karen.lemonadeUnload()
                          : window.karen.lemonadeLoad(m.id),
                      )}
                    >
                      {m.id === loaded ? "Unload" : "Load"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        !error ? <p className="hint">Looking at this machine…</p> : null
      )}
    </section>
  );
}
