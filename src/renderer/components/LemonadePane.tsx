/**
 * The engines and models Lemonade offers, and what this machine can run.
 *
 * Karen used to work all of this out itself: probe a build for devices, guess a
 * backend from PCI vendor ids, curate a small list of chat models, and write
 * its own sentence about why a card was not being used. All of it now comes
 * from the daemon -- and comes back wider, because Lemonade serves speech,
 * text-to-speech, image and embedding models through the same API as chat.
 *
 * Three decisions shape the layout:
 *
 *   - **Models are grouped by what they do, not by which engine runs them.**
 *     "Transcription" is a thing an academic wants; "whispercpp" is an
 *     implementation detail they should never have to learn.
 *   - **Every model shows whether it will fit**, using the size from the
 *     catalogue and the memory from the daemon, as a colour-coded verdict
 *     rather than a sentence -- because the list is scanned, not read.
 *   - **The catalogue is searched, not scrolled.** There are 178 chat models.
 *     A list that long is a filing cabinet with no drawers unless you can type
 *     into it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { groupCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { fitModel, type Verdict } from "../../core/runtime/fit.ts";
import type { DownloadJob, EngineInfo, MachineInfo } from "../../core/runtime/systemInfo.ts";

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
  llamacpp: "Chat models",
  whispercpp: "Transcription",
  moonshine: "Transcription",
  kokoro: "Speech synthesis",
  "sd-cpp": "Image generation",
  vllm: "Chat models",
  flm: "Chat models",
  "ryzenai-llm": "Chat models",
  onnxruntime: "ONNX Runtime",
  acestep: "Music generation",
  thinksound: "Sound effects",
  thenoise: "Audio models",
  openmoss: "Speech models",
  trellis: "3D generation",
  ds4: "Depth estimation",
};

/** The implementation, kept as a subtitle rather than folded into the name. */
const ENGINE_IMPL: Record<string, string> = {
  llamacpp: "llama.cpp",
  whispercpp: "whisper.cpp",
  moonshine: "Moonshine",
  kokoro: "Kokoro",
  "sd-cpp": "Stable Diffusion",
  vllm: "vLLM",
  flm: "FastFlowLM, NPU",
  "ryzenai-llm": "Ryzen AI, NPU",
  acestep: "ACE-Step",
  thinksound: "ThinkSound",
  openmoss: "OpenMOSS",
  trellis: "TRELLIS",
};

/** One line per group, so a heading is not the only thing explaining it. */
const GROUP_HINT: Record<string, string> = {
  chat: "Answering questions, drafting, and summarising.",
  vision: "Reading figures, scans, and screenshots.",
  speech: "Turning recorded audio into text — used by Meetings.",
  voice: "Reading text aloud.",
  image: "Making pictures from a description.",
  embedding: "Finding related passages across your library.",
};

/**
 * The fit verdict as a chip.
 *
 * `fitModel` returns a full sentence, which is right when you are looking at
 * one model and wrong when you are scanning ninety: at that length the same
 * sentence repeated is noise. The sentence stays, on hover.
 */
const FIT_CHIP: Record<Verdict, { short: string; tone: string }> = {
  gpu: { short: "Fits on GPU", tone: "good" },
  partial: { short: "Part on GPU", tone: "warn" },
  cpu: { short: "Processor", tone: "dim" },
  "too-large": { short: "Too large", tone: "bad" },
};

function gb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1)} GB` : "—";
}

function engineName(id: string): string {
  return ENGINE_LABELS[id] ?? id;
}

/**
 * What an academic reaches for first.
 *
 * Alphabetical order put "3D generation" at the top of the grid and chat
 * models in the middle, which is exactly backwards for this audience: chat and
 * transcription are the two engines Karen's own features depend on, and the
 * rest are there because Lemonade offers them.
 */
const ENGINE_ORDER = [
  "llamacpp", "vllm", "flm", "ryzenai-llm",
  "whispercpp", "moonshine", "openmoss",
  "kokoro", "sd-cpp",
];

/** Installed first, then what can be installed, then the rest. */
function engineRank(engine: EngineInfo): number {
  if (engine.backends.some((b) => b.state === "installed")) return 0;
  if (engine.backends.some((b) => b.state === "installable")) return 1;
  return 2;
}

function enginePriority(id: string): number {
  const i = ENGINE_ORDER.indexOf(id);
  return i === -1 ? ENGINE_ORDER.length : i;
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
  const [group, setGroup] = useState("chat");
  const [query, setQuery] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
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
    setPhase("Starting Lemonade");
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

  const run = async (
    what: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<void> => {
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

  const have = useMemo(() => new Set(installed.map((m) => m.id)), [installed]);
  const machine = {
    ...(info?.devices[0]?.totalBytes ? { vramBytes: info.devices[0].totalBytes } : {}),
    ramBytes: info?.ramBytes ?? 0,
  };

  const engines = useMemo(
    () =>
      (info?.engines ?? [])
        .filter((e) => showAllEngines || engineRank(e) < 2)
        .sort(
          (a, b) =>
            engineRank(a) - engineRank(b) ||
            enginePriority(a.id) - enginePriority(b.id) ||
            engineName(a.id).localeCompare(engineName(b.id)),
        ),
    [info?.engines, showAllEngines],
  );

  const groups = useMemo(() => groupCatalog(catalog), [catalog]);
  /* Models the daemon knows that the catalogue does not -- the user's own
     files, reached through `extra_models_dir`. Their own drawer, always last. */
  const mine = useMemo(
    () => installed.filter((m) => !catalog.some((c) => c.id === m.id)),
    [installed, catalog],
  );

  const active = groups.find((g) => g.id === group) ?? groups[0];
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = active?.entries ?? [];
    if (q) list = list.filter((m) => m.id.toLowerCase().includes(q));
    if (onlyMine) list = list.filter((m) => have.has(m.id));
    /* Downloaded models float to the top of whatever is showing: they are the
       ones you can act on right now. */
    return [...list].sort((a, b) => Number(have.has(b.id)) - Number(have.has(a.id)));
  }, [active, query, onlyMine, have]);

  const loadOrUnload = (id: string): void => {
    void run(id === loaded ? `Unloading ${id}` : `Loading ${id}`, () =>
      id === loaded ? window.karen.lemonadeUnload() : window.karen.lemonadeLoad(id));
  };

  return (
    <div className="lem">
      {/* ---------------- status ---------------- */}

      {phase || error || jobs.length ? (
        <div className={error ? "lem-status bad" : "lem-status"} role="status">
          {error ? (
            <p className="lem-status-line">{error}</p>
          ) : (
            <p className="lem-status-line">
              <span className="lem-spinner" aria-hidden="true" />
              {phase}…
            </p>
          )}
          {jobs.map((j) => (
            <div key={j.id} className="lem-job">
              <div className="lem-job-head">
                <span className="lem-job-name">{j.label}</span>
                <span className="lem-job-figure">
                  {j.percent ?? 0}% of {gb(j.bytesTotal)}
                </span>
              </div>
              <div className="lem-bar">
                <div className="lem-bar-fill" style={{ width: `${j.percent ?? 0}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!info && !error ? <p className="lem-waiting">Looking at this machine…</p> : null}

      {info ? (
        <>
          {/* ---------------- this machine ---------------- */}
          <section className="lem-section">
            <header className="lem-head">
              <h3>This machine</h3>
              <p>What Karen has to work with. Reported by Lemonade, not guessed.</p>
            </header>

            <div className="lem-stats">
              {info.devices.map((d) => (
                <div key={d.id} className="lem-stat accel">
                  <span className="lem-stat-key">Accelerator</span>
                  <span className="lem-stat-value">{d.description}</span>
                  <span className="lem-stat-figure">{gb(d.totalBytes)} memory</span>
                </div>
              ))}
              <div className="lem-stat">
                <span className="lem-stat-key">Memory</span>
                <span className="lem-stat-value">{gb(info.ramBytes)}</span>
                <span className="lem-stat-figure">system RAM</span>
              </div>
              {info.modelStorageFreeBytes ? (
                <div className="lem-stat">
                  <span className="lem-stat-key">Free space</span>
                  <span className="lem-stat-value">{gb(info.modelStorageFreeBytes)}</span>
                  <span className="lem-stat-figure">for downloaded models</span>
                </div>
              ) : null}
              {info.driverVersion ? (
                <div className="lem-stat">
                  <span className="lem-stat-key">Driver</span>
                  <span className="lem-stat-value">{info.driverVersion}</span>
                  {info.osVersion ? <span className="lem-stat-figure">{info.osVersion}</span> : null}
                </div>
              ) : null}
            </div>

            {info.devices.length === 0 ? (
              <div className="lem-callout">
                <p className="lem-callout-title">
                  No graphics acceleration was found, so models run on the processor.
                </p>
                {/* The daemon's own sentence, not one composed here. */}
                {info.note ? <p className="lem-callout-body">{info.note}</p> : null}
              </div>
            ) : null}
          </section>

          {/* ---------------- engines ---------------- */}
          <section className="lem-section">
            <header className="lem-head">
              <h3>Engines</h3>
              <p>
                Each kind of model needs its engine installed once. Karen downloads them through
                Lemonade — nothing is fetched until you press a button here.
              </p>
            </header>

            <div className="lem-grid">
              {engines.map((engine) => {
                const ready = engine.backends.some((b) => b.state === "installed");
                const offer = engine.backends.filter((b) => b.state !== "unsupported");
                const blocked = engine.backends.filter((b) => b.state === "unsupported");
                return (
                  <article key={engine.id} className={ready ? "lem-card ready" : "lem-card"}>
                    <div className="lem-card-head">
                      <h4>{engineName(engine.id)}</h4>
                      {ENGINE_IMPL[engine.id] ? (
                        <span className="lem-card-impl">{ENGINE_IMPL[engine.id]}</span>
                      ) : null}
                    </div>
                    <div className="lem-backends">
                      {offer.map((b) =>
                        b.state === "installed" ? (
                          <span key={b.id} className="lem-chip good" title={b.message}>
                            <span aria-hidden="true">✓</span> {BACKEND_LABELS[b.id] ?? b.id}
                          </span>
                        ) : (
                          <button
                            key={b.id}
                            type="button"
                            className="lem-install"
                            disabled={busy}
                            title={b.message}
                            onClick={() =>
                              void run(
                                `Installing ${BACKEND_LABELS[b.id] ?? b.id} for ${engineName(engine.id)}`,
                                () => window.karen.lemonadeInstallBackend(engine.id, b.id),
                              )
                            }
                          >
                            Install {BACKEND_LABELS[b.id] ?? b.id}
                          </button>
                        ),
                      )}
                      {offer.length === 0 ? (
                        <span className="lem-chip dim">Nothing here runs on this machine</span>
                      ) : null}
                    </div>
                    {/* Why a backend is greyed out, which is the question the
                        old pane answered and the one people actually asked. */}
                    {showAllEngines && blocked.length ? (
                      <ul className="lem-blocked">
                        {blocked.map((b) => (
                          <li key={b.id}>
                            {BACKEND_LABELS[b.id] ?? b.id} — {b.message ?? "not supported here"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <button type="button" className="lem-more" onClick={() => setShowAllEngines(!showAllEngines)}>
              {showAllEngines ? "Show only what this machine can run" : "Show every engine, including the ones this machine cannot run"}
            </button>
          </section>

          {/* ---------------- models ---------------- */}
          <section className="lem-section">
            <header className="lem-head">
              <h3>Models</h3>
              <p>Grouped by what they do. Sizes are the download; the fit allows for working memory too.</p>
            </header>

            {/* Sticky as one piece: the chat group is 178 rows, and a search
                box that scrolls off the top is a search box you cannot use
                while looking at what it filtered. */}
            <div className="lem-browser-bar">
              <div className="lem-tabs" role="tablist">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={g.id === active?.id}
                    className={g.id === active?.id ? "lem-tab on" : "lem-tab"}
                    onClick={() => setGroup(g.id)}
                  >
                  {g.title}
                  <span className="lem-tab-count">{g.entries.length}</span>
                </button>
                ))}
              </div>

              {active ? (
                <div className="lem-filters">
                  <input
                    type="search"
                    className="lem-search"
                    placeholder={`Search ${active.entries.length} ${active.title.toLowerCase()} models`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label={`Search ${active.title}`}
                  />
                  <label className="lem-toggle">
                    <input
                      type="checkbox"
                      checked={onlyMine}
                      onChange={(e) => setOnlyMine(e.target.checked)}
                    />
                    Downloaded only
                  </label>
                </div>
              ) : null}
            </div>

            {active ? (
              <>
                {GROUP_HINT[active.id] ? (
                  <p className="lem-group-hint">{GROUP_HINT[active.id]}</p>
                ) : null}

                <ul className="lem-models">
                  {rows.map((m) => {
                    const fit = m.sizeBytes && machine.ramBytes ? fitModel(m.sizeBytes, machine) : undefined;
                    const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
                    const here = have.has(m.id);
                    return (
                      <li key={m.id} className={m.id === loaded ? "lem-model loaded" : "lem-model"}>
                        <div className="lem-model-id">
                          <span className="lem-model-name">{m.id}</span>
                          {m.suggested ? (
                            <span className="lem-chip accent" title="Recommended by Lemonade">
                              Suggested
                            </span>
                          ) : null}
                          {m.id === loaded ? <span className="lem-chip accent">Loaded</span> : null}
                        </div>
                        <span className="lem-model-size">{gb(m.sizeBytes)}</span>
                        {chip ? (
                          <span className={`lem-chip ${chip.tone}`} title={fit?.label}>
                            {chip.short}
                          </span>
                        ) : (
                          <span className="lem-chip dim">—</span>
                        )}
                        <button
                          type="button"
                          className={here ? "lem-act" : "lem-act get"}
                          disabled={busy}
                          onClick={() =>
                            here
                              ? loadOrUnload(m.id)
                              : void run(`Downloading ${m.id}`, () => window.karen.lemonadePull(m.id))
                          }
                        >
                          {here ? (m.id === loaded ? "Unload" : "Load") : "Download"}
                        </button>
                      </li>
                    );
                  })}
                  {rows.length === 0 ? (
                    <li className="lem-none">
                      {query ? `Nothing matching “${query}”.` : "Nothing downloaded in this group yet."}
                    </li>
                  ) : null}
                </ul>
              </>
            ) : null}

            {mine.length ? (
              <>
                <header className="lem-head sub">
                  <h4>Your own models</h4>
                  <p>Found in your models folder. Karen did not download these and will not move them.</p>
                </header>
                <ul className="lem-models">
                  {mine.map((m) => (
                    <li key={m.id} className={m.id === loaded ? "lem-model loaded" : "lem-model"}>
                      <div className="lem-model-id">
                        <span className="lem-model-name">{m.id}</span>
                        {m.id === loaded ? <span className="lem-chip accent">Loaded</span> : null}
                      </div>
                      <span className="lem-model-size">—</span>
                      <span className="lem-chip dim">on disk</span>
                      <button
                        type="button"
                        className="lem-act"
                        disabled={busy}
                        onClick={() => loadOrUnload(m.id)}
                      >
                        {m.id === loaded ? "Unload" : "Load"}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
