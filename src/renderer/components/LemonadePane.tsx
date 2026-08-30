/**
 * The engines and models Lemonade offers, and what this machine can run.
 *
 * Karen used to work all of this out itself: probe a build for devices, guess a
 * backend from PCI vendor ids, curate a small list of chat models, and write
 * its own sentence about why a card was not being used. All of it now comes
 * from the daemon -- and comes back wider, because Lemonade serves speech,
 * text-to-speech, image and embedding models through the same API as chat.
 *
 * It renders one of two halves, chosen by `section`, because the two answer
 * different questions and belong in different places. **Engines** are setup --
 * what this machine can run, installed once, in Settings beside the other
 * machine-level switches. **Models** are a working choice you come back to, so
 * they get the whole width of their own screen. Showing both in both places
 * made each screen half about something the person was not there for.
 *
 * Three decisions shape the models half:
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

import { RegistrySearch } from "./RegistrySearch.tsx";

import { groupCatalog, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { SOURCE_LABELS, type ForeignModel } from "../../core/runtime/foreign.ts";
import { ENABLED_SOURCES, REGISTRY_HOST, REGISTRY_LABEL } from "../../core/runtime/registry.ts";
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

export function LemonadePane({
  section,
  onOpenModels,
  onOpenRuntime,
}: {
  /** `engines` is Settings → Runtime; `models` is the Models screen. */
  section: "engines" | "models";
  /** Offered from the engines half, which is where you finish and move on. */
  onOpenModels?: () => void;
  /** Offered from the models half when no engine is installed to run them. */
  onOpenRuntime?: () => void;
}) {
  const [info, setInfo] = useState<MachineInfo | undefined>();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<
    { id: string; downloaded?: boolean; sizeBytes?: number }[]
  >([]);
  /** LM Studio and Ollama models, by the id Lemonade reports them under. */
  const [foreign, setForeign] = useState<Map<string, ForeignModel>>(new Map());
  const [rescanning, setRescanning] = useState(false);
  const [loaded, setLoaded] = useState<string | undefined>();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<string | undefined>();
  const [group, setGroup] = useState("chat");
  const [query, setQuery] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [showAllEngines, setShowAllEngines] = useState(false);
  /* The curated catalogue or the registries. Two different acts -- "show me
     what Karen suggests" and "go and look this up" -- and mixing them would
     put a box that reaches the internet next to one that does not. */
  const [mode, setMode] = useState<"catalog" | "search">("catalog");
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
      setForeign(new Map((listRes.foreign ?? []).map((m) => [m.id, m])));
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

  /* Whether anything at all can run a model yet, which is the one fact the
     models half needs from the engines half. */
  const noEngine =
    info !== undefined && !(info.engines ?? []).some((e) => e.backends.some((b) => b.state === "installed"));

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

      {info && section === "engines" ? (
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

            {/* Where you go once an engine is in place. The models themselves
                live on their own screen and are not repeated here. */}
            {onOpenModels ? (
              <button type="button" className="lem-more" onClick={onOpenModels}>
                Choose and download models →
              </button>
            ) : null}
          </section>
        </>
      ) : null}

      {info && section === "models" ? (
        <>
          {/* ---------------- models ---------------- */}
          <section className="lem-section">
            <header className="lem-head">
              <h3>Models</h3>
              <p>
                Grouped by what they do. Sizes are the download; the fit allows for working memory
                too. Every row names the registry it would be fetched from — some institutions
                restrict which of those staff may use.
              </p>
            </header>

            {/* One line rather than the machine strip, which belongs on the
                Runtime page: without it the verdict column is a colour with
                nothing behind it, and with it this screen is about models. */}
            <p className="lem-group-hint">
              Fit is measured against {gb(info.ramBytes)} of memory
              {machine.vramBytes ? ` and ${gb(machine.vramBytes)} of graphics memory` : ", with no graphics acceleration"}.
            </p>

            {/* Downloading a model that nothing can run is a wasted transfer,
                and it is not obvious from here that an engine is a separate
                thing. Say so before the list, not after the download. */}
            {noEngine ? (
              <div className="lem-callout">
                <p className="lem-callout-title">No engine is installed yet.</p>
                <p className="lem-callout-body">
                  A model needs an engine to run it. Install one under Settings → Runtime first;
                  downloading a model on its own will not give you anything that answers.
                </p>
                {onOpenRuntime ? (
                  <button type="button" className="lem-more" onClick={onOpenRuntime}>
                    Open Settings → Runtime →
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="lem-modes" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "catalog"}
                className={mode === "catalog" ? "lem-mode on" : "lem-mode"}
                onClick={() => setMode("catalog")}
              >
                Recommended
                <span className="lem-mode-sub">Karen’s curated list — offline</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "search"}
                className={mode === "search" ? "lem-mode on" : "lem-mode"}
                onClick={() => setMode("search")}
              >
                Search registries
                {/* Listed from the enabled set rather than written out, so a
                    registry can never be advertised here that Karen refuses
                    to contact. */}
                <span className="lem-mode-sub">
                  {ENABLED_SOURCES.map((s) => REGISTRY_LABEL[s]).join(" · ")}
                </span>
              </button>
            </div>

            {mode === "catalog" ? (
              <>
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
                          {/* On every row, including Hugging Face ones. A badge shown only on
                              the exceptions makes an unlabelled row ambiguous -- it could mean
                              "the usual registry" or "nobody checked" -- and someone verifying
                              against an institutional policy cannot tell those apart. */}
                          <span
                            className={
                              m.source === "huggingface"
                                ? "lem-chip lem-src"
                                : "lem-chip lem-src foreign"
                            }
                            title={REGISTRY_HOST[m.source]}
                          >
                            {REGISTRY_LABEL[m.source]}
                          </span>
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
                  <h4>Already on this machine</h4>
                  <p>
                    Your own model folder, plus anything LM Studio or Ollama has already
                    downloaded. Karen reads these where they are — nothing is copied, moved or
                    re-downloaded.
                  </p>
                </header>
                <ul className="lem-models">
                  {mine.map((m) => {
                    const from = foreign.get(m.id);
                    /* The label from the manifest, not the directory name: the
                       index has to flatten `llama3.2:3b` to build a path, and
                       the colon is how anyone using Ollama refers to it. */
                    const name = from?.label ?? m.id;
                    const fit = m.sizeBytes && machine.ramBytes
                      ? fitModel(m.sizeBytes, machine)
                      : undefined;
                    const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
                    return (
                      <li key={m.id} className={m.id === loaded ? "lem-model loaded" : "lem-model"}>
                        <div className="lem-model-id">
                          <span className="lem-model-name" title={from?.path ?? m.id}>{name}</span>
                          {from ? (
                            <span className="lem-chip">{SOURCE_LABELS[from.source]}</span>
                          ) : null}
                          {m.id === loaded ? <span className="lem-chip accent">Loaded</span> : null}
                        </div>
                        <span className="lem-model-size">{gb(m.sizeBytes)}</span>
                        {chip ? (
                          <span className={`lem-chip ${chip.tone}`} title={fit?.label}>{chip.short}</span>
                        ) : (
                          <span className="lem-chip dim">on disk</span>
                        )}
                        <button
                          type="button"
                          className="lem-act"
                          disabled={busy}
                          onClick={() => loadOrUnload(m.id)}
                        >
                          {m.id === loaded ? "Unload" : "Load"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {/* The daemon reads the model folders once, when it starts. Someone
                who downloads a model in LM Studio while Karen is open has no
                other way to make it appear. */}
            <button
              type="button"
              className="lem-more"
              disabled={busy || rescanning}
              onClick={() => {
                setRescanning(true);
                void window.karen.lemonadeRescan().then(async (r) => {
                  setRescanning(false);
                  if (!r.ok) setError(r.error);
                  else await refresh();
                });
              }}
            >
              {rescanning ? "Looking again…" : "Look again for LM Studio and Ollama models"}
            </button>
              </>
            ) : (
              <RegistrySearch
                machine={machine}
                have={have}
                onDownloaded={async () => {
                  await refresh();
                }}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
