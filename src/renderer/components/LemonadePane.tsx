/**
 * The engines and models Lemonade offers, and what this machine can run.
 *
 * MyRA used to work all of this out itself: probe a build for devices, guess a
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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RegistrySearch } from "./RegistrySearch.tsx";
import { ModelCard, type CardTarget } from "./ModelCard.tsx";
import { DownloadProgress, gb } from "./modelBits.tsx";
import { useDownloads } from "./Downloads.tsx";
import { fraction } from "../../core/downloads/download.ts";
import { ModelOptionsEditor } from "./ModelOptionsEditor.tsx";

import { groupCatalog, repoOf, type CatalogEntry } from "../../core/runtime/catalog.ts";
import { LEMONADE_VERSION } from "../../core/runtime/lemonade.ts";
import { displayModelName, SOURCE_LABELS, type ForeignModel } from "../../core/runtime/foreign.ts";
import {
  ENABLED_SOURCES, explainRegistryError, REGISTRY_HOST, REGISTRY_LABEL, type RegistrySource,
} from "../../core/runtime/registry.ts";
import { deletePrompt, ownerOf } from "../../core/runtime/modelOwner.ts";
import type { PullProgress } from "../../core/runtime/systemInfo.ts";
import { fitModel, type Machine, type Verdict } from "../../core/runtime/fit.ts";
import {
  engineStates, engineUsable, partitionByRunnable, runnable, type Runnable,
} from "../../core/runtime/runnable.ts";
import type { DownloadJob, EngineInfo, MachineInfo } from "../../core/runtime/systemInfo.ts";
import type { EngineUpdate } from "../../core/runtime/engineReleases.ts";
import type { PendingUpdate } from "../types.ts";

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

/**
 * The engine verdict as a chip, in the same slot as the fit verdict.
 *
 * One column, not two: they answer the same question -- "what happens if I
 * press Download" -- and only one of them is ever the real answer. Memory only
 * matters once something can execute the model at all.
 */
/**
 * Capability labels in the words of what they do.
 *
 * `tool-calling` and `omni` are terms from the model-hosting world, and this
 * page is read by people who write papers. Anything not listed falls through
 * as the label itself rather than being dropped -- a capability MyRA has not
 * heard of is still worth showing.
 */
const LABEL_WORDS: Record<string, string> = {
  reasoning: "Reasoning",
  coding: "Code",
  vision: "Reads images",
  omni: "Reads images",
  "tool-calling": "Tools",
  embedding: "Embeddings",
  reranking: "Reranking",
  transcription: "Transcription",
  "realtime-transcription": "Live transcription",
  tts: "Speech",
  image: "Image generation",
};

const RUN_CHIP: Record<Runnable, { short: string; tone: string }> = {
  ready: { short: "Ready", tone: "good" },
  /* Deliberately the same chip as `ready`. This column answers "what happens
     if I press Download", and for a model the answer is the same either way --
     an engine update pending on the Runtime screen is not this row's news. */
  "update-pending": { short: "Ready", tone: "good" },
  "needs-engine": { short: "Needs engine", tone: "warn" },
  unsupported: { short: "Cannot run", tone: "bad" },
};

/**
 * One waiting build, whichever way MyRA came to know about it.
 *
 * The two sources answer the same question for the reader -- "there is a
 * different build of this and here is what it costs" -- so they share a row
 * rather than getting a section each. `waiting` is the one thing that changes
 * what the row has to say, because a chosen build gets downloaded on the next
 * model load whether or not anybody presses anything.
 */
interface UpdateRow {
  recipe: string;
  backend: string;
  from: string;
  to: string;
  sizeBytes?: number | undefined;
  releaseUrl?: string | undefined;
  /** Upstream's own label on this build, reported rather than acted on. */
  prerelease?: boolean | undefined;
  /** `owner/repo`, so the sentence about that label can name who wrote it. */
  repo?: string | undefined;
  waiting: boolean;
}

function mb(bytes?: number): string {
  return bytes ? `${Math.round(bytes / 1024 ** 2)} MB` : "";
}

/**
 * "today", "yesterday", or a date.
 *
 * A timestamp answers "did I already check this?" and nothing finer is
 * useful: engine releases arrive daily at best, and "3 September" is
 * something a person can compare against their own memory of the week.
 */
function whenChecked(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "recently";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return then.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/**
 * One update, and what agreeing to it does.
 *
 * The consequences are behind a press rather than beside every row, because
 * there is usually one update on the screen and always four things worth
 * knowing about it; printed inline for every backend they would be wallpaper.
 * Pressing Update opens them and does nothing else -- the button that acts is
 * inside, and it is the second press, which is the whole point.
 */
function EngineUpdateRow({
  row, busy, open, onAsk, onGo,
}: {
  row: UpdateRow;
  busy: boolean;
  open: boolean;
  onAsk: () => void;
  onGo: () => void;
}): React.JSX.Element {
  const label = BACKEND_LABELS[row.backend] ?? row.backend;
  const size = mb(row.sizeBytes);
  return (
    <div className={open ? "lem-update open" : "lem-update"}>
      <div className="lem-update-head">
        <span className="lem-update-what">
          <span aria-hidden="true">↑</span> {label} {row.from} → <strong>{row.to}</strong>
        </span>
        {/* On the controls' line rather than the versions' one: the cards are
            250px wide and "Processor b10375 → b10793 · 16 MB" does not fit on
            one, so the size wrapped alone onto a third line. */}
        {size ? <span className="lem-update-size">{size}</span> : null}
        {row.releaseUrl ? (
          <a className="lem-update-notes" href={row.releaseUrl} target="_blank" rel="noreferrer">
            What changed ↗
          </a>
        ) : null}
        <button type="button" className="lem-install" disabled={busy} onClick={onAsk}>
          {row.waiting ? "Install now" : "Update"}
        </button>
      </div>

      {open ? (
        <div className="lem-update-body">
          {/* Written in the order the questions actually arrive: what happens
              to what I have open, whether it is safe, and how to get out. */}
          {row.waiting ? (
            <p>
              {row.to} is already chosen for this machine and will be downloaded the next time a
              model loads. Installing it now means that download happens here, where you can see
              it, rather than in the middle of your next question.
            </p>
          ) : null}
          <p>
            Downloads {size ? `${size} ` : ""}from the project that publishes this engine, then
            <strong> restarts the backend, so any model you have loaded will be unloaded</strong>.
            Your conversations, meetings and research runs are not touched.
          </p>
          <p>
            A newer engine can be faster or fix a bug, and can also behave differently from the one
            your earlier work ran on. If it goes wrong you can put {row.from} back in one press —
            it is downloaded again, so that takes about as long as this will.
          </p>
          {/* Reported, not acted on. The flag means different things in
              different projects and changed meaning inside this one --
              llama.cpp marked every build a pre-release from 21 August 2026,
              having marked none before it. Filtering on that would decide by
              which week a project changed its CI. */}
          {row.prerelease ? (
            <p>
              <code>{row.repo ?? "The project"}</code> marks this build a pre-release, as it does
              for all of its recent builds. That is its own labelling rather than a warning about
              this one.
            </p>
          ) : null}
          <div className="lem-update-go">
            <button type="button" className="lem-install strong" disabled={busy} onClick={onGo}>
              {row.waiting ? `Install ${row.to}` : `Update to ${row.to}`}
            </button>
            <button type="button" className="lem-more" disabled={busy} onClick={onAsk}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function engineName(id: string): string {
  return ENGINE_LABELS[id] ?? id;
}

/**
 * What an academic reaches for first.
 *
 * Alphabetical order put "3D generation" at the top of the grid and chat
 * models in the middle, which is exactly backwards for this audience: chat and
 * transcription are the two engines MyRA's own features depend on, and the
 * rest are there because Lemonade offers them.
 */
const ENGINE_ORDER = [
  "llamacpp", "vllm", "flm", "ryzenai-llm",
  "whispercpp", "moonshine", "openmoss",
  "kokoro", "sd-cpp",
];

/** Installed first, then what can be installed, then the rest. */
function engineRank(engine: EngineInfo): number {
  // `update_required` is an installed engine with a newer build waiting, so it
  // belongs at the top with the rest of what this machine already has.
  if (engine.backends.some((b) => b.state === "installed" || b.state === "update_required")) return 0;
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
    { id: string; downloaded?: boolean; sizeBytes?: number; source?: string;
      checkpoint?: string; recipe?: string }[]
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
  /* Models whose engine this machine cannot run. Hidden by default and
     counted out loud -- see `runnable.ts` for why they are not simply
     listed alongside the rest. */
  const [showBlocked, setShowBlocked] = useState(false);
  /* The curated catalogue or the registries. Two different acts -- "show me
     what MyRA suggests" and "go and look this up" -- and mixing them would
     put a box that reaches the internet next to one that does not. */
  const [mode, setMode] = useState<"mine" | "catalog" | "search">("mine");
  /* The model whose load settings are open, if any. One at a time: these are
     per-model settings and two panels open at once invites editing one and
     saving the other. */
  const [tuning, setTuning] = useState<string | undefined>();
  /* The model whose card is open. Set from any of the three tabs, so a curated
     model and a searched one are looked at the same way -- two different pages
     depending on which tab you arrived from is how a person learns not to
     trust either. */
  const [viewing, setViewing] = useState<CardTarget | undefined>();
  /*
   * The downloads in flight, read from main rather than kept here.
   *
   * This page used to own them, which is why leaving it looked like the
   * download stopping: the bytes carried on arriving, and the only record of
   * them was the state that had just been unmounted. See components/Downloads.
   */
  const downloads = useDownloads();
  const [pullError, setPullError] = useState<string | undefined>();
  const inFlight = downloads.find((d) => d.state === "running" || d.state === "paused");
  const pulling = inFlight?.name;
  const job: PullProgress | undefined = inFlight
    ? {
        file: inFlight.file,
        fileIndex: inFlight.fileIndex,
        totalFiles: inFlight.totalFiles,
        bytesDone: inFlight.bytesDone,
        bytesTotal: inFlight.bytesTotal,
        percent: Math.round((fraction(inFlight) ?? 0) * 100),
      }
    : undefined;
  /* The model whose deletion is being confirmed. One at a time, and closed by
     pressing anything else. */
  const [deleting, setDeleting] = useState<string | undefined>();

  /* Escape closes it, like every other dialog in the app. A panel that can only
     be dismissed by finding its own close button is one people leave open. */
  useEffect(() => {
    if (!tuning) return undefined;
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setTuning(undefined);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [tuning]);
  const starting = useRef(false);

  /* Engine builds. Kept apart from `info` because they have different
     lifetimes: `info` is re-read on every refresh, while a check is a thing
     the user did once and its result should still be on screen afterwards. */
  const [updates, setUpdates] = useState<EngineUpdate[]>([]);
  const [pending, setPending] = useState<PendingUpdate[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | undefined>();
  const [pins, setPins] = useState<Record<string, string>>({});
  const [shipped, setShipped] = useState<Record<string, string>>({});
  /* Which update is showing its consequences, if any. One at a time, and
     closed by pressing the same button again. */
  const [confirming, setConfirming] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    const [infoRes, listRes, catRes, verRes] = await Promise.all([
      window.myra.lemonadeInfo(),
      window.myra.lemonadeModels(),
      window.myra.lemonadeCatalog(),
      window.myra.engineVersions(),
    ]);
    if (verRes.ok) {
      setPins(verRes.pins);
      setShipped(verRes.shipped);
    }
    if (infoRes.ok && infoRes.info) setInfo(infoRes.info);
    else if (infoRes.error) setError(infoRes.error);
    if (listRes.ok) {
      /*
       * Only what is actually on the disk.
       *
       * `downloaded` is the daemon's own field and it separates a model whose
       * files are here from one it merely has a definition for -- registering
       * a model without pulling it (an interrupted download, a checkpoint
       * registered by hand) leaves exactly that. Measured on this machine the
       * daemon reports every listed model as downloaded, so the filter changes
       * nothing today; it is here because "My models" is a promise about the
       * disk, and a tab that keeps that promise only while nothing has gone
       * wrong is not keeping it.
       *
       * Applied once, before the list is used for anything, because it also
       * feeds `have` -- and `have` is what decides whether a row on the search
       * page says Downloaded.
       */
      setInstalled(listRes.models.filter((m) => m.downloaded !== false));
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
    const res = await window.myra.lemonadeEnsure();
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
      void window.myra.lemonadeDownloads().then((r) => setJobs(r.jobs.filter((j) => !j.complete)));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  /**
   * The check, which is the only thing on this screen that reaches GitHub.
   *
   * `pending` is refreshed from the same call even though it costs no network:
   * it is read out of the daemon's own report, and a person who presses Check
   * expects one answer about engine builds rather than two half-answers from
   * two places.
   */
  const checkUpdates = async (): Promise<void> => {
    setChecking(true);
    setCheckError(undefined);
    const res = await window.myra.engineUpdatesCheck();
    setChecking(false);
    if (!res.ok || !res.check) {
      setCheckError(res.error ?? "Could not reach GitHub to ask.");
      return;
    }
    setUpdates(res.check.updates);
    setPending(res.check.pending);
    setCheckedAt(res.check.checkedAt);
    /* Named rather than counted: "2 engines could not be checked" sends
       somebody looking for which two. */
    setCheckError(res.check.unreachable.length
      ? `Could not read the release list for ${res.check.unreachable.join(", ")}.`
      : undefined);
  };

  const pinOf = (recipe: string, backend: string): string => `${recipe}:${backend}`;

  const updateFor = (recipe: string, backend: string): UpdateRow | undefined => {
    /* A build already chosen wins over one merely found: it is the one the
       daemon will fetch on the next load whether anybody presses anything. */
    const waiting = pending.find((u) => u.recipe === recipe && u.backend === backend);
    if (waiting) return { ...waiting, waiting: true };
    const found = updates.find((u) => u.recipe === recipe && u.backend === backend);
    return found ? { ...found, waiting: false } : undefined;
  };

  const applyBuild = async (
    recipe: string,
    backend: string,
    version: string | undefined,
  ): Promise<void> => {
    setConfirming(undefined);
    const label = BACKEND_LABELS[backend] ?? backend;
    await run(
      version
        ? `Moving ${engineName(recipe)} (${label}) to ${version}`
        : `Putting ${engineName(recipe)} (${label}) back to the build MyRA ships`,
      () => window.myra.engineUpdate(recipe, backend, version),
    );
    /* The row goes whether or not it worked. On success it is done; on
       failure the pin was rolled back, so the offer no longer describes the
       machine and leaving it up would invite pressing it again against an
       error that has not changed. */
    setUpdates((list) => list.filter((u) => !(u.recipe === recipe && u.backend === backend)));
    setPending((list) => list.filter((u) => !(u.recipe === recipe && u.backend === backend)));
  };

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

  /*
   * Progress for the download in flight.
   *
   * Subscribed once and pushed, not polled. `/api/v1/downloads` was the obvious
   * source and is the wrong one: it stays empty for the whole of a `/pull`,
   * because it reports the daemon's own background jobs rather than a transfer
   * somebody is waiting on. The pull itself streams the figures when asked,
   * which is what this receives.
   *
   * Held here rather than in the card, so a download survives closing the page
   * it was started from.
   */
  /* A download that finished added a model, and this page is the one showing
     the list it was added to. */
  useEffect(() => window.myra.onModelsChanged(() => void refresh()), [refresh]);

  /**
   * Fetch one version of one model.
   *
   * Two things here were wrong once and are the reason the button never worked,
   * so both are settled in `pullName` and `pullCheckpoint` rather than here.
   * The name needs a `user.` prefix or Lemonade refuses a pull that supplies
   * its own checkpoint, and the recipe has to come from what the registry says
   * the model is FOR -- `/pull/variants` reports `llamacpp` for any repository
   * containing `.gguf` files, diffusion and audio models included.
   */
  const download = useCallback(
    async (
      source: RegistrySource,
      choice: { name: string; checkpoint: string; recipe: string },
    ): Promise<void> => {
      setPullError(undefined);
      /* Resolves once the transfer has started, not when it has finished.
         Everything after that point -- progress, pausing, cancelling, and
         noticing it arrived -- belongs to the registry in main, which is what
         lets it outlive this page. */
      const res = await window.myra.registryPull(
        choice.name, choice.checkpoint, source, choice.recipe,
      );
      if (!res.ok) setPullError(explainRegistryError(res.error ?? "", source));
    },
    [],
  );

  /**
   * Remove a model from this machine.
   *
   * The window asks; the main process decides whose file it is and what that
   * means. Nothing here computes a path -- see `modelDelete.ts` for why that
   * matters -- and the warning a person reads before pressing this comes from
   * `deletePrompt`, which is the same function the main process's behaviour is
   * keyed to.
   */
  const removeModel = useCallback(
    async (id: string): Promise<void> => {
      setDeleting(undefined);
      await run(`Deleting ${displayModelName(id)}`, () => window.myra.lemonadeDeleteModel(id));
    },
    // `run` is redefined every render and closing over a stale one is harmless:
    // it reads no state of its own beyond the setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
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
    info !== undefined && ![...engineStates(info.engines ?? []).values()].some(engineUsable);

  const groups = useMemo(() => groupCatalog(catalog), [catalog]);
  /* Models the daemon knows that the catalogue does not -- the user's own
     files, reached through `extra_models_dir`. Their own drawer, always last. */
  const mine = useMemo(
    () => installed.filter((m) => !catalog.some((c) => c.id === m.id)),
    [installed, catalog],
  );

  /** What each engine can do here, built once rather than per row. */
  const states = useMemo(() => engineStates(info?.engines ?? []), [info?.engines]);
  /** The engines with a backend installed, named rather than counted. */
  const readyEngines = useMemo(
    () => [...states].filter(([, v]) => engineUsable(v)).map(([id]) => id),
    [states],
  );
  /* The same set, for the registry rows: a downloaded diffusion model needs
     sd-cpp present before it will load, and that is worth saying before the
     download rather than after. */
  const installedEngines = useMemo(() => new Set(readyEngines), [readyEngines]);

  const active = groups.find((g) => g.id === group) ?? groups[0];
  const { rows, blockedCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = active?.entries ?? [];
    if (q) list = list.filter((m) => m.id.toLowerCase().includes(q));
    if (onlyMine) list = list.filter((m) => have.has(m.id));

    /* The models this machine has no engine for are separated before anything
       else, because their count is shown and because leaving them mixed in is
       what made the list offer 95 downloads that could never be loaded. */
    const { usable, blocked } = partitionByRunnable(list, states);
    const shown = showBlocked ? [...usable, ...blocked] : usable;

    /* Downloaded first -- they are the ones you can act on right now -- then
       what will actually run, then upstream's suggestions, then smallest.
       Size last rather than first: sorting by size alone put 135M-parameter
       models at the top of a list an academic reads for research work. */
    const order = (m: CatalogEntry): number =>
      runnable(m.recipe, states).state === "ready" ? 0
        : runnable(m.recipe, states).state === "needs-engine" ? 1 : 2;
    return {
      rows: [...shown].sort(
        (a, b) =>
          Number(have.has(b.id)) - Number(have.has(a.id)) ||
          order(a) - order(b) ||
          Number(b.suggested) - Number(a.suggested) ||
          (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity),
      ),
      blockedCount: blocked.length,
    };
  }, [active, query, onlyMine, have, states, showBlocked]);

  const loadOrUnload = (id: string): void => {
    void run(id === loaded ? `Unloading ${id}` : `Loading ${id}`, () =>
      id === loaded ? window.myra.lemonadeUnload() : window.myra.lemonadeLoad(id));
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
              <p>What MyRA has to work with. Reported by Lemonade, not guessed.</p>
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
                Each kind of model needs its engine installed once. MyRA downloads them through
                Lemonade — nothing is fetched until you press a button here.
              </p>
              {/*
                * Said out loud, because the absence of automatic updates reads
                * as a missing feature otherwise -- "how do I update llama.cpp?
                * I don't see a button" was the report that started this.
                *
                * The versions still come from the Lemonade release MyRA ships
                * ({LEMONADE_VERSION}); what changed is that moving off one is
                * now something a person can do, and still nothing that happens
                * on its own. A runtime that updated itself underneath a piece
                * of work could change an answer between one run and the next.
                */}
              <p>
                Each engine starts on the build the Lemonade release MyRA ships
                ({LEMONADE_VERSION}) names for it. Nothing here changes on its own — MyRA has no
                automatic updates and does not look for any until you ask it to.
              </p>
            </header>

            <div className="lem-updatebar">
              <button
                type="button"
                className="lem-more"
                disabled={busy || checking}
                onClick={() => void checkUpdates()}
              >
                {checking ? "Asking GitHub…" : "Check for engine updates"}
              </button>
              {/* What pressing it costs, before it is pressed. This is the one
                  control on the screen that reaches the network on its own
                  behalf rather than to fetch something the user asked for. */}
              <span className="lem-updatebar-note">
                {checkedAt
                  ? `Last checked ${whenChecked(checkedAt)}. Asks GitHub which builds exist; nothing else is sent.`
                  : "Asks GitHub which builds exist; nothing else is sent."}
              </span>
              {checkError ? <span className="lem-updatebar-bad">{checkError}</span> : null}
              {checkedAt && !checkError && !updates.length && !pending.length ? (
                <span className="lem-updatebar-note">
                  Every engine you have installed is on the newest build its source publishes.
                </span>
              ) : null}
            </div>

            <div className="lem-grid">
              {engines.map((engine) => {
                /* An engine whose build is behind is still an engine that is
                   here and working, so it wears the tick and carries its own
                   version -- the Install button underneath it was the old
                   rendering of `update_required`, and offering to install
                   something already installed is its own kind of wrong. */
                const held = engine.backends.filter(
                  (b) => b.state === "installed" || b.state === "update_required");
                const ready = held.length > 0;
                const offer = engine.backends.filter((b) => b.state === "installable");
                const blocked = engine.backends.filter((b) => b.state === "unsupported");
                const news = engine.backends.flatMap((b) => {
                  const row = updateFor(engine.id, b.id);
                  return row ? [row] : [];
                });
                return (
                  <article key={engine.id} className={ready ? "lem-card ready" : "lem-card"}>
                    <div className="lem-card-head">
                      <h4>{engineName(engine.id)}</h4>
                      {ENGINE_IMPL[engine.id] ? (
                        <span className="lem-card-impl">{ENGINE_IMPL[engine.id]}</span>
                      ) : null}
                    </div>
                    <div className="lem-backends">
                      {held.map((b) => (
                        <span
                          key={b.id}
                          className="lem-chip good"
                          title={
                            b.version
                              ? `${BACKEND_LABELS[b.id] ?? b.id} ${b.version}, read from the ` +
                                "build installed on this machine."
                              : b.message
                          }
                        >
                          <span aria-hidden="true">✓</span> {BACKEND_LABELS[b.id] ?? b.id}
                          {/* The version, because "is mine current" is the
                              question a tick cannot answer. Taken from the
                              daemon, which reads it off the installed binary
                              -- showing the pin here would name a build that
                              is not on the disk the moment one is chosen. */}
                          {b.version ? <span className="lem-chip-ver"> {b.version}</span> : null}
                        </span>
                      ))}
                      {offer.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          className="lem-install"
                          disabled={busy}
                          title={b.message}
                          onClick={() =>
                            void run(
                              `Installing ${BACKEND_LABELS[b.id] ?? b.id} for ${engineName(engine.id)}`,
                              () => window.myra.lemonadeInstallBackend(engine.id, b.id),
                            )
                          }
                        >
                          Install {BACKEND_LABELS[b.id] ?? b.id}
                        </button>
                      ))}
                      {offer.length === 0 && held.length === 0 ? (
                        <span className="lem-chip dim">Nothing here runs on this machine</span>
                      ) : null}
                    </div>

                    {/* One row per backend with a build waiting, either found
                        on GitHub or already chosen and not yet fetched. */}
                    {news.map((row) => (
                      <EngineUpdateRow
                        key={`${row.recipe}:${row.backend}`}
                        row={row}
                        busy={busy}
                        open={confirming === pinOf(row.recipe, row.backend)}
                        onAsk={() => setConfirming(
                          confirming === pinOf(row.recipe, row.backend)
                            ? undefined
                            : pinOf(row.recipe, row.backend))}
                        onGo={() => void applyBuild(row.recipe, row.backend, row.to)}
                      />
                    ))}

                    {/* Offered only where a version was chosen here, and only
                        while it differs from the one Lemonade shipped: an
                        engine still on its original build has nothing to go
                        back to, and a button that undoes nothing is noise. */}
                    {held.flatMap((b) => {
                      const key = pinOf(engine.id, b.id);
                      const original = shipped[key];
                      if (!pins[key] || !original || original === b.version) return [];
                      return [(
                        <button
                          key={`revert-${b.id}`}
                          type="button"
                          className="lem-revert"
                          disabled={busy}
                          onClick={() => void applyBuild(engine.id, b.id, undefined)}
                        >
                          Put {BACKEND_LABELS[b.id] ?? b.id} back to {original}, the build MyRA ships
                        </button>
                      )];
                    })}
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

      {/*
        * One model, as a page, replacing the list rather than sitting beside
        * it. A split pane would keep the results in view at the cost of giving
        * a model card half a column, and the card is the thing somebody came
        * here to read.
        */}
      {info && section === "models" && viewing ? (
        <ModelCard
          target={viewing}
          machine={machine}
          have={have}
          pulling={pulling}
          job={job}
          onDownload={(choice) => void download(viewing.source, choice)}
          onBack={() => setViewing(undefined)}
        />
      ) : null}

      {info && section === "models" && !viewing ? (
        <>
          {/* ---------------- models ---------------- */}
          <section className="lem-section">
            <header className="lem-head">
              <h3>Models</h3>
              {/* One line. The paragraph that was here described the grouping,
                  the registry labelling and the machine filter -- three things
                  the screen below now shows rather than promises, and sixty
                  pixels of the reason the first model sat below the fold. */}
              <p>Every model names the registry it comes from, and its country.</p>
            </header>

            {/*
              * The constraint every verdict on this page is derived from, said
              * once, at the size of a fact rather than of a footnote.
              *
              * It was a 12px grey sentence under the heading, which is where
              * you put something you do not expect to be read -- and it is the
              * single most decision-relevant thing here: every "fits" and
              * "too large" below is measured against these two numbers, and
              * whether a model can run at all is measured against the third.
              */}
            <div className="lem-machine" aria-label="What this machine can run">
              <div className="lem-machine-cell">
                <span className="lem-machine-key">Memory</span>
                <span className="lem-machine-value">{gb(info.ramBytes)}</span>
              </div>
              <div className={machine.vramBytes ? "lem-machine-cell accel" : "lem-machine-cell"}>
                <span className="lem-machine-key">Graphics</span>
                <span className="lem-machine-value">
                  {machine.vramBytes ? gb(machine.vramBytes) : "None"}
                </span>
              </div>
              <div className={noEngine ? "lem-machine-cell warn" : "lem-machine-cell"}>
                <span className="lem-machine-key">Engines</span>
                <span className="lem-machine-value">
                  {noEngine
                    ? "None installed"
                    /* The implementation, which is what "engine" means
                       here -- `engineName` returns what the engine is FOR
                       ("Chat models"), and "Engines: Chat models" is not a
                       sentence. */
                    : readyEngines.map((id) => ENGINE_IMPL[id] ?? id).join(", ")}
                </span>
              </div>
            </div>

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

            {pulling ? <DownloadProgress name={pulling} job={job} /> : null}
            {pullError ? <p className="reg-line bad">{pullError}</p> : null}

            <div className="lem-modes" role="tablist">
              {/* First, and the default: what is already on this machine is
                  what a person comes back to. The other two are for adding
                  something, which is the rarer act. */}
              <button
                type="button"
                role="tab"
                aria-selected={mode === "mine"}
                className={mode === "mine" ? "lem-mode on" : "lem-mode"}
                onClick={() => setMode("mine")}
              >
                My models
                <span className="lem-mode-sub">
                  {installed.length} downloaded · load settings
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "catalog"}
                className={mode === "catalog" ? "lem-mode on" : "lem-mode"}
                onClick={() => setMode("catalog")}
              >
                Recommended
                <span className="lem-mode-sub">MyRA’s curated list — offline</span>
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
                    registry can never be advertised here that MyRA refuses
                    to contact. */}
                <span className="lem-mode-sub">
                  {ENABLED_SOURCES.map((s) => REGISTRY_LABEL[s]).join(" · ")}
                </span>
              </button>
            </div>

            {mode === "mine" ? (
              <MyModels
                installed={installed}
                foreign={foreign}
                catalog={catalog}
                loaded={loaded}
                loading={undefined}
                machine={machine}
                busy={busy}
                tuning={tuning}
                onTune={(id) => setTuning(tuning === id ? undefined : id)}
                onLoadOrUnload={loadOrUnload}
                onReload={(id) =>
                  void run(`Reloading ${displayModelName(id)}`, async () => {
                    await window.myra.lemonadeUnload();
                    return window.myra.lemonadeLoad(id);
                  })
                }
                onRescan={() => {
                  setRescanning(true);
                  void window.myra.lemonadeRescan().then(async (r) => {
                    setRescanning(false);
                    if (!r.ok) setError(r.error);
                    else await refresh();
                  });
                }}
                rescanning={rescanning}
                onBrowse={() => setMode("search")}
                deleting={deleting}
                onAskDelete={(id) => setDeleting(deleting === id ? undefined : id)}
                onDelete={(id) => void removeModel(id)}
                onReveal={(id) => void window.myra.modelReveal(id)}
                onOpen={setViewing}
              />
            ) : mode === "catalog" ? (
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
                  {/* What this tab will show, not what the catalogue holds.
                      "168" over a list of 73 is a number the user can check
                      by scrolling, and it fails that check. */}
                  <span className="lem-tab-count">
                    {partitionByRunnable(g.entries, states).usable.length}
                  </span>
                </button>
                ))}
              </div>

              {active ? (
                <div className="lem-filters">
                  <input
                    type="search"
                    className="lem-search"
                    placeholder={`Search ${partitionByRunnable(active.entries, states).usable.length} ${active.title.toLowerCase()} models`}
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

                {/* Column headings, because the row is now a table and a
                    table with unlabelled columns is a puzzle. The registry
                    column especially: aligning 168 identical values is what
                    answers "are these all from one place?" at a glance, which
                    168 inline pills did not. */}
                <div className="lem-cols" aria-hidden="true">
                  <span>Model</span>
                  <span>Registry</span>
                  <span className="num">Download</span>
                  <span>Runs here</span>
                  <span />
                </div>

                <ul className="lem-models">
                  {rows.map((m, i) => {
                    const verdict = runnable(m.recipe, states);
                    const fit = m.sizeBytes && machine.ramBytes ? fitModel(m.sizeBytes, machine) : undefined;
                    const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
                    const here = have.has(m.id);
                    /* Two different verdicts, and the engine one wins. A model
                       that fits comfortably in memory and has no engine to run
                       it is not "Fits on GPU"; showing that was the bug. */
                    const runChip = { ready: RUN_CHIP.ready, other: RUN_CHIP[verdict.state] };
                    /* Where the runnable models end. Without a line here the
                       blocked ones simply fade in, and a dimmed row looks like
                       a rendering artefact rather than a different category. */
                    const firstBlocked =
                      verdict.state === "unsupported" &&
                      rows[i - 1] !== undefined &&
                      runnable(rows[i - 1]!.recipe, states).state !== "unsupported";
                    return (
                      <Fragment key={m.id}>
                      {firstBlocked ? (
                        <li className="lem-divider">
                          Below here: nothing on this machine can run these.
                        </li>
                      ) : null}
                      <li
                        className={[
                          "lem-model",
                          m.id === loaded ? "loaded" : "",
                          verdict.state === "unsupported" ? "blocked" : "",
                        ].filter(Boolean).join(" ")}
                      >
                        <div className="lem-model-id">
                          {/* The same card the search results open. A curated
                              model and a searched one are the same kind of
                              thing, and two ways of looking at one depending on
                              which tab you arrived from is how somebody learns
                              not to trust either. */}
                          {repoOf(m.checkpoint) ? (
                            <button
                              type="button"
                              className="lem-model-name link"
                              title={`What ${m.id} is, on the registry it comes from`}
                              onClick={() =>
                                setViewing({
                                  repo: repoOf(m.checkpoint) ?? "",
                                  recipe: m.recipe,
                                  source: m.source,
                                })
                              }
                            >
                              {m.id}
                            </button>
                          ) : (
                            <span className="lem-model-name">{m.id}</span>
                          )}
                          <div className="lem-model-meta">
                            {/*
                              * No "Suggested" badge, though the sort still
                              * uses it.
                              *
                              * 66 of the 73 chat models this machine can run
                              * are on upstream's shortlist. A mark that
                              * appears on nine rows in ten is not a
                              * recommendation, it is the baseline -- and in
                              * the accent colour it pulled the eye sixty-six
                              * times to say nothing, crowding out the labels
                              * that do differ. It stays a sort key, where it
                              * is genuinely useful, and stops being a badge.
                              */}
                            {/* "chat" is the group heading already, and the
                                engine ids -- llamacpp, whispercpp -- are the
                                implementation detail this page exists to keep
                                people from having to learn. */}
                            {m.labels
                              .filter((l) => l !== "chat" && !ENGINE_IMPL[l] && !ENGINE_LABELS[l])
                              .slice(0, 3)
                              .map((l) => (
                                <span key={l} className="lem-tag">{LABEL_WORDS[l] ?? l}</span>
                              ))}
                            {m.id === loaded ? <span className="lem-tag accent">Loaded</span> : null}
                            {here && m.id !== loaded ? (
                              <span className="lem-tag">Downloaded</span>
                            ) : null}
                          </div>
                        </div>

                        {/* On every row, including Hugging Face ones. A badge shown only on
                            the exceptions makes an unlabelled row ambiguous -- it could mean
                            "the usual registry" or "nobody checked" -- and someone verifying
                            against an institutional policy cannot tell those apart. */}
                        <span
                          className={
                            m.source === "huggingface" ? "lem-model-src" : "lem-model-src foreign"
                          }
                          title={REGISTRY_HOST[m.source]}
                        >
                          {REGISTRY_LABEL[m.source]}
                        </span>

                        <span className="lem-model-size">{gb(m.sizeBytes)}</span>

                        {/* Once the engine is there, memory is the live
                            question again and the fit verdict is the useful
                            one; before that it is noise. Text and colour are
                            taken from the SAME verdict -- reading the words
                            off one and the tone off the other painted "Too
                            large" in the green reserved for "fits". */}
                        {(() => {
                          const shown =
                            verdict.state === "ready" ? (chip ?? runChip.ready) : runChip.other;
                          return (
                            <span
                              className={`lem-chip ${shown.tone}`}
                              title={
                                verdict.state === "ready" && fit
                                  ? `${verdict.reason} ${fit.label}`
                                  : verdict.reason
                              }
                            >
                              {shown.short}
                            </span>
                          );
                        })()}

                        <div className="lem-model-acts">
                          {/* Only for models that are here: there is nothing to
                              tune about a model that has not been downloaded. */}
                          {here ? (
                            <button
                              type="button"
                              className="lem-act"
                              onClick={() => setTuning(tuning === m.id ? undefined : m.id)}
                              title="How this model loads: context size, backend, arguments"
                            >
                              Tune
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={here ? "lem-act" : "lem-act get"}
                            /* Downloading something nothing can run is the one
                               action on this page that cannot be undone
                               cheaply -- it is somebody's bandwidth, possibly
                               metered. The tooltip says why rather than
                               leaving a dead button. */
                            disabled={busy || (!here && verdict.state === "unsupported")}
                            title={verdict.state === "unsupported" ? verdict.reason : undefined}
                            onClick={() =>
                              here
                                ? loadOrUnload(m.id)
                                : void run(`Downloading ${m.id}`, () => window.myra.lemonadePull(m.id))
                            }
                          >
                            {here ? (m.id === loaded ? "Unload" : "Load") : "Download"}
                          </button>
                        </div>
                      </li>
                      </Fragment>
                    );
                  })}
                  {rows.length === 0 ? (
                    <li className="lem-none">
                      {query ? `Nothing matching \u201c${query}\u201d.` : "Nothing downloaded in this group yet."}
                    </li>
                  ) : null}
                </ul>

                {/* Counted out loud rather than silently filtered. Someone who
                    read about a model elsewhere and cannot find it here needs
                    to know it was withheld and why, or they conclude the list
                    is broken. */}
                {blockedCount ? (
                  <button
                    type="button"
                    className="lem-hidden"
                    onClick={() => setShowBlocked(!showBlocked)}
                  >
                    {showBlocked
                      ? `Hide the ${blockedCount} this machine cannot run`
                      : `${blockedCount} more need hardware this machine does not have — show them anyway`}
                  </button>
                ) : null}
              </>
            ) : null}

            {mine.length ? (
              <>
                <header className="lem-head sub">
                  <h4>Already on this machine</h4>
                  <p>
                    Your own model folder, plus anything LM Studio or Ollama has already
                    downloaded. MyRA reads these where they are — nothing is copied, moved or
                    re-downloaded.
                  </p>
                </header>
                <ul className="lem-models">
                  {mine.map((m) => {
                    const from = foreign.get(m.id);
                    /* The label from the manifest, not the directory name: the
                       index has to flatten `llama3.2:3b` to build a path, and
                       the colon is how anyone using Ollama refers to it. */
                    /* The manifest label when there is one, otherwise the id
                       with its index prefix stripped -- these rows were the
                       ones showing `lmstudio__` and `LiquidAI__` at people. */
                    const name = from?.label ?? displayModelName(m.id);
                    const fit = m.sizeBytes && machine.ramBytes
                      ? fitModel(m.sizeBytes, machine)
                      : undefined;
                    const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
                    return (
                      <li key={m.id} className={m.id === loaded ? "lem-model loaded" : "lem-model"}>
                        <div className="lem-model-id">
                          <span className="lem-model-name" title={from?.path ?? m.id}>{name}</span>
                          <div className="lem-model-meta">
                            {m.id === loaded ? <span className="lem-tag accent">Loaded</span> : null}
                            {/* Where the file came from, which is not the same
                                question as which registry a download would
                                use -- these are already here. */}
                            {from ? <span className="lem-tag">{SOURCE_LABELS[from.source]}</span> : null}
                          </div>
                        </div>
                        {/* The registry column stays empty rather than being
                            collapsed: these were not fetched by MyRA, and
                            naming one would be a claim about their provenance
                            that MyRA cannot make. */}
                        <span className="lem-model-src">—</span>
                        <span className="lem-model-size">{gb(m.sizeBytes)}</span>
                        {chip ? (
                          <span className={`lem-chip ${chip.tone}`} title={fit?.label}>{chip.short}</span>
                        ) : (
                          <span className="lem-chip dim">On disk</span>
                        )}
                        <div className="lem-model-acts">
                          <button
                            type="button"
                            className="lem-act"
                            onClick={() => setTuning(tuning === m.id ? undefined : m.id)}
                            title="How this model loads: context size, backend, arguments"
                          >
                            Tune
                          </button>
                          <button
                            type="button"
                            className="lem-act"
                            disabled={busy}
                            onClick={() => loadOrUnload(m.id)}
                          >
                            {m.id === loaded ? "Unload" : "Load"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {/*
              * Over the page, not under it.
              *
              * It sat below the lists, on the reasoning that expanding a row
              * would shove everything beneath it out from under the pointer.
              * True, and it traded that for something worse: with sixty models
              * on the page, pressing Tune scrolled a panel into existence
              * somewhere off the bottom of the screen, so the button appeared
              * to do nothing at all.
              */}
            {tuning ? (
              <div
                className="dialog-backdrop"
                role="dialog"
                aria-modal="true"
                aria-label={`Load settings for ${tuning}`}
                onMouseDown={(e) => {
                  // Only the backdrop itself. A drag that starts inside the
                  // panel and ends on the backdrop must not close it.
                  if (e.target === e.currentTarget) setTuning(undefined);
                }}
              >
                <div className="mopt-modal">
                  <ModelOptionsEditor
                    model={tuning}
                    machine={machine}
                    loaded={tuning === loaded}
                    onReload={() =>
                      void run(`Reloading ${tuning}`, async () => {
                        await window.myra.lemonadeUnload();
                        return window.myra.lemonadeLoad(tuning);
                      })
                    }
                    onClose={() => setTuning(undefined)}
                  />
                </div>
              </div>
            ) : null}

            {/* The daemon reads the model folders once, when it starts. Someone
                who downloads a model in LM Studio while MyRA is open has no
                other way to make it appear. */}
            <button
              type="button"
              className="lem-more"
              disabled={busy || rescanning}
              onClick={() => {
                setRescanning(true);
                void window.myra.lemonadeRescan().then(async (r) => {
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
                installedEngines={installedEngines}
                machine={machine}
                have={have}
                catalog={catalog}
                states={states}
                pulling={pulling}
                job={job}
                onDownload={(source, choice) => void download(source, choice)}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * Asking before deleting, in the words that fit this particular file.
 *
 * Two shapes, decided by `deletePrompt` rather than here. For MyRA's own
 * models it is one press: the daemon removes what it downloaded, and a person
 * who pressed Delete meant Delete. For a file belonging to LM Studio or Ollama
 * the first press only explains -- what the file is, where it is, and what that
 * other application is likely to do about its disappearance -- and the button
 * that actually removes it is worded differently and sits beside a Reveal, so
 * the path can be checked rather than taken on trust.
 *
 * The user asked for exactly this shape: keep those models on the list, let
 * them be deleted, warn properly first.
 */
function DeleteConfirm({
  prompt,
  busy,
  onConfirm,
  onCancel,
  onReveal,
}: {
  prompt: ReturnType<typeof deletePrompt>;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReveal: () => void;
}) {
  return (
    <li className={prompt.warns ? "lem-confirm warn" : "lem-confirm"}>
      <p className="lem-confirm-title">{prompt.title}</p>
      <p className="lem-confirm-body">{prompt.body}</p>
      <div className="lem-model-acts">
        <button type="button" className="lem-act" onClick={onCancel}>
          Keep it
        </button>
        {prompt.reveal ? (
          <button type="button" className="lem-act" onClick={onReveal}>
            Show me the file
          </button>
        ) : null}
        <button type="button" className="lem-act danger on" disabled={busy} onClick={onConfirm}>
          {prompt.confirm}
        </button>
      </div>
    </li>
  );
}

/**
 * The models already on this machine, and how each one loads.
 *
 * Its own tab because it answers a different question from the other two. The
 * catalogue and the registry are for *finding* a model; this is for the ones
 * already here, which is what somebody who has finished choosing comes back
 * to. It was previously a section at the bottom of the catalogue tab, below
 * seventy rows of models the person had not downloaded — the wrong way round
 * for the thing they own.
 *
 * Every row opens the same per-model settings the Tune button always offered,
 * so context size, backend and extra arguments are edited where the model is,
 * rather than being hunted for under a list of things to install.
 */
function MyModels({
  installed,
  foreign,
  catalog,
  loaded,
  machine,
  busy,
  tuning,
  onTune,
  onLoadOrUnload,
  onReload,
  onRescan,
  rescanning,
  onBrowse,
  deleting,
  onAskDelete,
  onDelete,
  onReveal,
  onOpen,
}: {
  installed: {
    id: string; downloaded?: boolean; sizeBytes?: number; source?: string;
    checkpoint?: string; recipe?: string;
  }[];
  foreign: Map<string, ForeignModel>;
  catalog: CatalogEntry[];
  loaded: string | undefined;
  loading: string | undefined;
  machine: Machine;
  busy: boolean;
  tuning: string | undefined;
  onTune: (id: string) => void;
  onLoadOrUnload: (id: string) => void;
  onReload: (id: string) => void;
  onRescan: () => void;
  rescanning: boolean;
  onBrowse: () => void;
  /** The row whose delete is being confirmed, if any. */
  deleting: string | undefined;
  onAskDelete: (id: string) => void;
  onDelete: (id: string) => void;
  onReveal: (id: string) => void;
  /** Undefined for a model with no repository behind it -- an imported file. */
  onOpen: (target: CardTarget) => void;
}) {
  /* Loaded first, then the rest by size. The loaded model is the one every
     other row is compared against, and it is the one whose settings someone
     has come here to change. */
  const rows = useMemo(
    () =>
      [...installed].sort(
        (a, b) =>
          Number(b.id === loaded) - Number(a.id === loaded) ||
          (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
      ),
    [installed, loaded],
  );

  if (!rows.length) {
    return (
      <div className="lem-callout">
        <p className="lem-callout-title">No models on this machine yet.</p>
        <p className="lem-callout-body">
          MyRA also reads anything LM Studio or Ollama has already downloaded, where it
          lies — nothing is copied or re-downloaded. If you have some, look again; otherwise
          browse a registry and download one.
        </p>
        <div className="lem-model-acts">
          <button type="button" className="lem-act" disabled={rescanning} onClick={onRescan}>
            {rescanning ? "Looking again…" : "Look again"}
          </button>
          <button type="button" className="lem-act get" onClick={onBrowse}>
            Browse registries
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="lem-group-hint">
        Everything downloaded, plus anything LM Studio or Ollama already had. Tune opens the
        settings that model loads with — context window, backend, extra arguments.
      </p>

      <div className="lem-cols" aria-hidden="true">
        <span>Model</span>
        <span>Where from</span>
        <span className="num">Size</span>
        <span>Fits</span>
        <span />
      </div>

      <ul className="lem-models">
        {rows.map((m) => {
          const from = foreign.get(m.id);
          const known = catalog.find((c) => c.id === m.id);
          const name = from?.label ?? displayModelName(m.id);
          const fit = m.sizeBytes && machine.ramBytes ? fitModel(m.sizeBytes, machine) : undefined;
          const chip = fit ? FIT_CHIP[fit.verdict] : undefined;
          const repo = repoOf(m.checkpoint);
          return (
            <Fragment key={m.id}>
            <li className={m.id === loaded ? "lem-model loaded" : "lem-model"}>
              <div className="lem-model-id">
                {/* A link only where there is something to open. An imported
                    file has no repository, and a name that is a button on some
                    rows and text on others is honest about which is which. */}
                {repo ? (
                  <button
                    type="button"
                    className="lem-model-name link"
                    title={`What ${name} is, on the registry it came from`}
                    onClick={() => onOpen({ repo, recipe: m.recipe ?? "llamacpp", source: "huggingface" })}
                  >
                    {name}
                  </button>
                ) : (
                  <span className="lem-model-name" title={from?.path ?? m.id}>{name}</span>
                )}
                <div className="lem-model-meta">
                  {m.id === loaded ? <span className="lem-tag accent">Loaded</span> : null}
                  {known?.labels
                    .filter((l) => l !== "chat")
                    .slice(0, 2)
                    .map((l) => <span key={l} className="lem-tag">{l}</span>)}
                </div>
              </div>
              {/*
                * Where the file came from, and only what is actually known.
                *
                * "This machine" was being printed for anything the curated
                * catalogue did not list -- which included every model MyRA had
                * downloaded from Hugging Face under a name of its own, so a
                * downloaded model claimed a local provenance it did not have.
                * The checkpoint is the record: a repository id means a
                * registry, an absolute path means a file that was already here.
                */}
              <span className="lem-model-src" title={repo ?? from?.path ?? m.checkpoint}>
                {from
                  ? SOURCE_LABELS[from.source]
                  : known
                    ? REGISTRY_LABEL[known.source]
                    : repo
                      ? REGISTRY_LABEL.huggingface
                      : "This machine"}
              </span>
              <span className="lem-model-size">{gb(m.sizeBytes)}</span>
              {chip ? (
                <span className={`lem-chip ${chip.tone}`} title={fit?.label}>{chip.short}</span>
              ) : (
                <span className="lem-chip dim">On disk</span>
              )}
              <div className="lem-model-acts">
                <button
                  type="button"
                  className={tuning === m.id ? "lem-act get" : "lem-act"}
                  onClick={() => onTune(m.id)}
                  title="How this model loads: context size, backend, arguments"
                >
                  {tuning === m.id ? "Close" : "Tune"}
                </button>
                <button
                  type="button"
                  className="lem-act"
                  disabled={busy}
                  onClick={() => onLoadOrUnload(m.id)}
                >
                  {m.id === loaded ? "Unload" : "Load"}
                </button>
                <button
                  type="button"
                  className={deleting === m.id ? "lem-act danger on" : "lem-act danger"}
                  disabled={busy}
                  aria-expanded={deleting === m.id}
                  onClick={() => onAskDelete(m.id)}
                  title={`Remove ${name} from this machine`}
                >
                  {deleting === m.id ? "Cancel" : "Delete"}
                </button>
              </div>
            </li>
            {/*
              * The confirmation, in the row rather than in a dialog.
              *
              * It has to say different things for different models -- MyRA's
              * own download, a file in MyRA's folder, and a file belonging to
              * LM Studio or Ollama are three different acts wearing one word --
              * and every one of those sentences comes from `deletePrompt`,
              * which is the same function the main process's behaviour is keyed
              * to. A dialog would have been a second place for those words to
              * live.
              */}
            {deleting === m.id ? <DeleteConfirm
              prompt={deletePrompt({
                owner: ownerOf({
                  ...(m.source !== undefined ? { source: m.source } : {}),
                  ...(from ? { foreign: from.source } : {}),
                }),
                name,
                ...(m.sizeBytes ? { size: gb(m.sizeBytes) } : {}),
                ...(from?.path ? { path: from.path } : {}),
              })}
              busy={busy}
              onConfirm={() => onDelete(m.id)}
              onCancel={() => onAskDelete(m.id)}
              onReveal={() => onReveal(m.id)}
            /> : null}
            </Fragment>
          );
        })}
      </ul>

      {/*
        * Over the page, not under it. See the note on the other one of these.
        *
        * This is the copy that mattered: "My models" is the tab someone opens
        * to tune something, and with a screen of models on it, Tune scrolled a
        * panel into existence below the fold, where it read as a button that
        * did nothing.
        */}
      {tuning ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Load settings for ${tuning}`}
          onMouseDown={(e) => {
            // Only the backdrop. A drag begun inside the panel must not close it.
            if (e.target === e.currentTarget) onTune(tuning);
          }}
        >
          <div className="mopt-modal">
            <ModelOptionsEditor
              model={tuning}
              machine={machine}
              loaded={tuning === loaded}
              onReload={() => onReload(tuning)}
              onClose={() => onTune(tuning)}
            />
          </div>
        </div>
      ) : null}

      <button type="button" className="lem-more" disabled={busy || rescanning} onClick={onRescan}>
        {rescanning ? "Looking again…" : "Look again for LM Studio and Ollama models"}
      </button>
    </>
  );
}
