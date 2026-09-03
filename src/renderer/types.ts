import type { CatalogEntry } from "../core/runtime/catalog.ts";
import type { Provider } from "../core/providers.ts";
import type { ModelPrice } from "../core/pricing.ts";
import type { ApiState } from "../main/api/manager.ts";

/* Re-exported so the renderer imports it from one place, the way every
   other shared shape in this file is reached. */
export type { ApiState };
import type { RequestRecord } from "../core/api/log.ts";
import type { ForeignModel } from "../core/runtime/foreign.ts";
import type { InstalledModel } from "../main/runtime/lemonadeApi.ts";
import type { LoadedModel } from "../core/runtime/lemonade.ts";
import type { ModelOptions } from "../core/runtime/modelOptions.ts";
export type { RunFootprint } from "../core/research/run.ts";
import type { RunFootprint } from "../core/research/run.ts";
import type { RegistrySource, RepoVariants } from "../core/runtime/registry.ts";
import type { BrowseSort, HfModel, RepoFile } from "../core/runtime/hfBrowse.ts";
import type { PullProgress } from "../core/runtime/systemInfo.ts";
import type { DownloadJob, MachineInfo } from "../core/runtime/systemInfo.ts";
/**
 * What the renderer renders.
 *
 * Deliberately not a mirror of the main process's types: this describes a
 * conversation as it appears on screen, which is a different shape from the
 * message list that goes to the model. Keeping them separate is what lets a
 * tool call be a card with a live progress line rather than a JSON blob.
 */

export interface TextBlock { kind: "text"; text: string }
export interface ThinkingBlock { kind: "thinking"; text: string }
export type Block = TextBlock | ThinkingBlock;

export interface UserItem { id: string; kind: "user"; text: string }

export interface AssistantItem {
  id: string;
  kind: "assistant";
  blocks: Block[];
  streaming?: boolean;
}

export interface ToolItem {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  /** The latest progress line, replaced as it arrives rather than appended. */
  update?: string;
  output: string;
  /**
   * "stopped" is not a kind of failure: it is a call that was still in flight
   * when the turn ended, because the user cancelled or the turn errored out.
   * Without it such a card spins for ever, claiming work is happening after
   * everything has stopped.
   */
  status: "running" | "ok" | "error" | "stopped";
}

/**
 * Something the app did to the conversation, said out loud.
 *
 * Compaction rewrites what the model is sent, so it has to be visible: an
 * assistant that quietly forgets the first half of a conversation is
 * indistinguishable from one that is broken.
 */
export interface NoticeItem {
  id: string;
  kind: "notice";
  text: string;
}

export type Item = UserItem | AssistantItem | ToolItem | NoticeItem;

/** A source a tool retrieved, so [n] markers in the prose can resolve. */
export interface CitedSource {
  n: number;
  url: string;
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  engine?: string;
  publishedDate?: string;
  snippet?: string;
  note?: string;
  via?: string;
}

export interface Usage {
  input: number;
  output: number;
  total: number;
  /** What the conversation currently occupies in the model's window. */
  contextTokens?: number;
  /** The window itself. Only known for a model Karen started. */
  contextLimit?: number;
}

export type Theme = "dark" | "light";

export interface EndpointSettings {
  baseUrl: string;
  envVar: string;
  model?: string;
  timeoutMs: number;
}

export type { AudioOption, AudioRole } from "../core/audio/models.ts";
import type { AudioOption, AudioRole } from "../core/audio/models.ts";
export type { ModelOption } from "../core/models/roles.ts";
import type { ModelOption } from "../core/models/roles.ts";
export type { ImageRecord } from "../core/images/store.ts";
import type { ImageRecord } from "../core/images/store.ts";
export type { ImagePreset } from "../core/images/presets.ts";

/** One tick of a model download, as the main process reports it. */
export interface AudioProgress {
  model: string;
  file: string;
  fileIndex: number;
  totalFiles: number;
  bytesDone: number;
  bytesTotal: number;
  percent: number;
}

export interface AudioSettings {
  /** A model reference: a bare id is local, `provider::model` is a provider's. */
  transcriptionModel: string;
  voiceModel: string;
  voice: string;
  speed: number;
  speechToSpeech: boolean;
}

/** The image model and its size. Mirrors core's ImageSettings. */
export interface ImageSettings {
  model: string;
  size: string;
}

export interface Settings {
  permissionMode: "manual" | "guarded" | "yolo";
  theme: Theme;
  llm: EndpointSettings;
  /** The two speech models and the voice. Mirrors core's AudioSettings. */
  audio: AudioSettings;
  /** The image model and its size. Mirrors core's ImageSettings. */
  image: ImageSettings;
  embeddings: EndpointSettings;
  /** Where Zotero's library is, when Karen cannot work it out. Empty = find it. */
  zoteroDataDir: string;
  workspaceRoot: string;
  vaultRoot: string;
  vaultWriteSubdir: string;
  dictationHotkey: string;
  dictationSource: string;
  dictationLanguage: string;
  deleteRawAudioAfterTranscription: boolean;
  meetingsRoot: string;
  /** Where generated images and their sidecars are kept. */
  imagesRoot: string;
  meetingReportDir: string;
  meetingCaptureSystemAudio: boolean;
  meetingInstructions: string;
  /** Closing the window leaves Karen running in the tray. */
  keepRunningInTray: boolean;
  setupCompleted: boolean;
  providers: Provider[];
  /** Sampler settings per model, keyed the way a model is chosen. */
  sampling: Record<string, Record<string, number>>;
}

/*
 * Imported, not re-declared.
 *
 * ResearchMode is kept in step by hand because only its NAMES cross the
 * boundary. A provider brings a rule with it -- whether an endpoint is really
 * on this machine -- and the picker's warning and the main process's routing
 * have to reach the same answer every time. Two copies of that rule is two
 * chances to disagree about the only thing this app promises.
 */
export type { Provider, ProviderKind } from "../core/providers.ts";
export type { ModelPrice } from "../core/pricing.ts";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

/*
 * The ladder itself lives in core/research/ladder.ts and is imported, not
 * copied. It used to be redeclared here with a note asking the next person to
 * keep the two in step -- which held right up until a rung was added to one of
 * them. ladder.ts touches no filesystem, so the renderer can have the real one.
 */
export type { ResearchMode } from "../core/research/ladder.ts";
import type { ResearchMode } from "../core/research/ladder.ts";
export {
  RESEARCH_MODES, reaches, exactly, searches, readsLibrary, readsDocuments,
} from "../core/research/ladder.ts";

export interface ResearchConfig {
  mode: ResearchMode;
  category: string;
  timeRange?: string;
  /** The Zotero collection the library rung is limited to. All of it if absent. */
  collection?: string | undefined;
  collectionName?: string | undefined;
}

/** One row of the collection picker: nested, with its full path for the title. */
export interface CollectionNode {
  key: string;
  name: string;
  depth: number;
  path: string;
  children: number;
}

export interface VaultStatus {
  usable: boolean;
  backend: string;
  reason: string;
  persistent?: boolean;
  present?: Record<string, boolean>;
}

/** A capture device, as MediaDevices reports it. */
export interface AudioSource {
  id: string;
  name: string;
  description: string;
  isDefault?: boolean;
  kind: "microphone" | "system";
}

export interface MeetingProgress {
  stage: string;
  fraction: number;
  detail?: string;
}

export interface MeetingResult {
  reportPath: string;
  transcriptPath: string;
  actions: number;
  unverified: number;
  audioDeleted: boolean;
}

export interface MeetingState {
  phase: "idle" | "recording" | "processing" | "done" | "failed";
  title?: string;
  elapsedMs?: number;
  tracks?: string[];
  levels?: Record<string, number>;
  progress?: MeetingProgress;
  result?: MeetingResult;
  reportPath?: string;
  /** The meeting directory a stage is currently working on. */
  workingOn?: string;
  error?: string;
}

/** What a meeting has been through, as the page lists it. */
export interface MeetingArtifacts {
  instructions?: string;
  transcribedAt?: string;
  transcriptModel?: string;
  notedAt?: string;
  notesModel?: string;
  filedNotePath?: string;
  filedTranscriptPath?: string;
  error?: string;
}

export interface MeetingSummary {
  id: string;
  dir: string;
  title: string;
  startedAt: string;
  seconds: number;
  tracks: string[];
  hasAudio: boolean;
  audioBytes: number;
  transcribed: boolean;
  noted: boolean;
  state: MeetingArtifacts;
}

/** One Whisper model Karen offers to download. */
export interface WhisperModel {
  file: string;
  label: string;
  bytes: number;
  multilingual: boolean;
  hint: string;
}

export interface WhisperSnapshot {
  config: {
    binary?: string;
    tag?: string;
    modelPath?: string;
    modelFile?: string;
    useForTranscription: boolean;
  };
  server: {
    state: "stopped" | "starting" | "ready" | "failed";
    baseUrl?: string;
    error?: string;
    log: string[];
    pid?: number;
  };
  installed: string[];
  /** Set on a platform whisper.cpp publishes no build for. */
  unavailable?: string;
  catalogue: WhisperModel[];
}

export interface AgentEvent {
  type:
    | "text" | "tool_start" | "tool_update" | "tool_end" | "tool_error"
    | "compacted" | "notice" | "done" | "error";
  text?: string;
  /** For text: "thinking" is the model's reasoning, anything else is the answer. */
  kind?: "text" | "thinking";
  toolCallId?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
}

/**
 * A document the model wrote, as it stood at that moment.
 *
 * Mirrors DocumentUpdate in core/agent/tools/documents.ts by hand, because the
 * renderer does not import from core. The draft flow emits one of these after
 * every section, so a file arrives here many times with `final` false before
 * the last one.
 */
export interface DocumentUpdate {
  path: string;
  name: string;
  markdown: string;
  final: boolean;
}

/** State of an in-flight dictation. */
export interface DictationState {
  phase: "idle" | "recording" | "transcribing";
  elapsedMs: number;
  /** Input level, 0..1, already scaled and smoothed. */
  level: number;
  /** The microphone has been producing nothing for a few seconds. */
  silent?: boolean;
  /** Input gain is too high and samples are hitting full scale. */
  clipping?: boolean;
  error?: string;
}

/**
 * A clarifying question the research pipeline asked mid-run.
 *
 * v1 called this a UiRequest and it arrived over pi's extension_ui_request
 * channel with a `method` that could be select/confirm/input/editor. The
 * pipeline only ever uses two of those, so only two survive.
 */
export interface PromptRequest {
  id: string;
  /** v1's `method`, kept under its old name so the dialog reads the same. */
  method: "input" | "editor" | "confirm" | "choice" | "models";
  title: string;
  message?: string;
  prefill?: string;
  placeholder?: string;
  /** choice: the answers to offer. "Other" is added by the dialog, not sent. */
  options?: string[];
  /** choice: whether several of them can be picked at once. */
  multi?: boolean;
  /** models: one dropdown per entry. */
  slots?: { key: string; label: string; hint: string }[];
  /** models: what each slot is set to now. */
  current?: Record<string, string>;
}

export interface KarenApi {
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  onDocument(cb: (doc: DocumentUpdate) => void): () => void;
  revealDocument(path: string): Promise<void>;

  newSession(): Promise<string>;
  listSessions(): Promise<SessionSummary[]>;
  openSession(id: string): Promise<unknown[]>;
  deleteSession(id: string): Promise<void>;
  deleteAllSessions(): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  setSecret(name: string, value: string): Promise<unknown>;
  secretsBackend(): Promise<VaultStatus>;
  discoverModels(which: "llm" | "embeddings"): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  testEndpoint(which: "llm" | "embeddings"): Promise<{ ok: boolean; status?: number; error?: string }>;

  /* ---- audio ---- */
  audioModels(role: AudioRole): Promise<{ ok: boolean; options: AudioOption[]; error?: string }>;
  audioLoad(model: string): Promise<{ ok: boolean; error?: string }>;
  /** Let go of a loaded speech model, by name, freeing what it holds. */
  audioUnload(model: string): Promise<{ ok: boolean; error?: string }>;
  onAudioProgress(cb: (p: AudioProgress) => void): () => void;
  /** The spoken form of an answer, as bytes to play. */
  speak(text: string): Promise<{ ok: boolean; audio?: Uint8Array; mime?: string; error?: string }>;
  previewVoice(voice?: string): Promise<{ ok: boolean; audio?: Uint8Array; mime?: string; error?: string }>;

  /* ---- images ---- */
  imageModels(): Promise<{ ok: boolean; options: ModelOption[]; error?: string }>;
  imageLoad(model: string): Promise<{ ok: boolean; error?: string }>;
  /** Live progress for a model download; returns an unsubscribe. */
  onImageProgress(cb: (p: AudioProgress) => void): () => void;
  /** Draws one image, files it, and hands back the bytes to show. */
  imageGenerate(request: { prompt: string; negative?: string; preset?: string }): Promise<{
    ok: boolean; record?: ImageRecord; image?: Uint8Array; error?: string;
  }>;
  imageCancel(): Promise<{ ok: boolean }>;
  imageList(): Promise<{ ok: boolean; images: ImageRecord[]; error?: string }>;
  imageRead(id: string): Promise<{ ok: boolean; image?: Uint8Array; mime?: string; error?: string }>;
  imageDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  imageReveal(id: string): Promise<{ ok: boolean; error?: string }>;
  imageSaveCopy(id: string): Promise<{ ok: boolean; saved?: boolean; path?: string; error?: string }>;
  imageFolder(): Promise<{ ok: boolean; error?: string }>;

  chooseDirectory(opts: { title?: string; current?: string }): Promise<string | undefined>;
  /** Put text on the system clipboard. Main-process, so it works off file://. */
  copy(text: string): Promise<void>;
  providerModels(opts: { baseUrl: string; id?: string; apiKey?: string }): Promise<{
    ok: boolean; models?: string[]; error?: string;
    /** Per-model cost, when the endpoint's listing carried it. */
    prices?: Record<string, ModelPrice>;
  }>;
  /** Ask a provider whether it sends reasoning. Field names back, never text. */
  providerReasoning(opts: { baseUrl: string; id?: string; model: string; apiKey?: string }): Promise<{
    ok: boolean; message?: string; error?: string; asking?: boolean;
  }>;
  /** Settings changed by the main process itself. Returns an unsubscribe. */
  onSettings(cb: (settings: Settings) => void): () => void;
  setProviderKey(id: string, value: string): Promise<unknown>;
  /** Which providers have a key stored. Never the keys themselves. */
  providerKeysPresent(): Promise<Record<string, boolean>>;
  zoteroCollections(): Promise<{
    ok: boolean;
    collections?: CollectionNode[];
    error?: string;
    /** "database" means Zotero's API was unreachable and the file was read. */
    via?: "api" | "database";
  }>;
  /**
   * What each route into Zotero can do right now, probed on demand.
   *
   * Both are always reported, whether or not the other worked: they fail for
   * unrelated reasons and only one message on screen has meant, for months,
   * that the wrong one was fixed.
   */
  zoteroStatus(): Promise<{
    ok: boolean;
    error?: string;
    api?: { ok: boolean; message: string; collections?: number };
    file?: {
      ok: boolean; message: string; items?: number; collections?: number;
      path?: string; source?: string;
    };
    looked?: {
      path?: string;
      source?: string;
      tried: string[];
      profiles: { path: string; dataDir?: string }[];
    };
  }>;
  setResearch(config: ResearchConfig): Promise<void>;
  getResearch(): Promise<ResearchConfig>;
  engines(): Promise<{ pandoc: boolean; pandocPath?: string; pandocVersion?: string; pdftotext: boolean }>;
  /** macOS TCC status. Every other platform answers "granted". */
  mediaAccess(): Promise<{ microphone: MediaAccess; screen: MediaAccess }>;
  requestMicrophone(): Promise<boolean>;
  installPandoc(): Promise<{ ok: boolean; error?: string; path?: string; version?: string }>;
  onSetupProgress(cb: (p: DownloadProgress | undefined) => void): () => void;
  privacy(): Promise<PrivacyReport>;

  meetingState(): Promise<MeetingState>;
  meetingStart(title: string, tracks: { id: string; label: string; source?: string }[]): Promise<string>;
  meetingAudio(trackId: string, pcm: ArrayBuffer): Promise<void>;
  meetingStop(): Promise<unknown>;
  meetingDiscard(): Promise<void>;
  meetingLevels(): Promise<Record<string, number>>;
  onMeeting(cb: (state: MeetingState) => void): () => void;
  onMeetings(cb: (list: MeetingSummary[]) => void): () => void;
  meetingList(): Promise<MeetingSummary[]>;
  meetingTranscribe(dir: string): Promise<{ ok: boolean; error?: string }>;
  meetingNotes(dir: string): Promise<{ ok: boolean; error?: string }>;
  meetingRun(dir: string): Promise<{ ok: boolean; error?: string }>;
  meetingCancel(): Promise<{ ok: boolean }>;
  meetingInstructions(dir: string, text: string): Promise<{ ok: boolean }>;
  meetingRead(dir: string, which: "notes" | "transcript"): Promise<string | undefined>;
  meetingReveal(path: string): Promise<{ ok: boolean }>;
  meetingDelete(dir: string): Promise<{ ok: boolean; error?: string }>;
  reportDevices(devices: AudioSource[]): Promise<void>;

  dictationStart(): Promise<void>;
  dictationAudio(pcm: ArrayBuffer): Promise<void>;
  /** Answers rather than rejecting: a failed transcription is a sentence, not a
   *  rejection wrapped in "Error invoking remote method". */
  dictationStop(): Promise<{ ok: boolean; error?: string } | undefined>;
  dictationCancel(): Promise<void>;
  onDictationText(cb: (text: string) => void): () => void;

  academicSearch(
    query: string,
    opts: { page?: number; sort?: SortBy },
  ): Promise<{ results: AcademicResult[]; failures: string[] }>;
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  researchRuns(): Promise<RunSummary[]>;
  researchRun(id: string): Promise<RunDetail>;
  researchSource(id: string, n: number): Promise<RunSource | undefined>;
  researchReveal(id: string): Promise<void>;
  researchFootprint(
    id: string,
  ): Promise<{ ok: boolean; error?: string; footprint?: RunFootprint }>;
  researchDelete(id: string): Promise<{
    ok: boolean;
    error?: string;
    deleted?: { id: string; files: number; bytes: number };
    runs?: RunSummary[];
  }>;
  onResearchProgress(cb: (note: string) => void): () => void;
  answerPrompt(id: string, answer: string | undefined): Promise<void>;
  onPrompt(cb: (request: PromptRequest) => void): () => void;

  /* The bundled runtime. All user-driven: no tool reaches any of this. */
  runtimeState(): Promise<RuntimeState>;
  runtimeConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig>;
  /** Why a build found no GPU. Asked only when one did not, since it shells out. */
  lemonadeEnsure(): Promise<{ ok: boolean; error?: string }>;
  lemonadeInfo(): Promise<{ ok: boolean; error?: string; info?: MachineInfo }>;
  lemonadeInstallBackend(
    recipe: string,
    backend: string,
  ): Promise<{ ok: boolean; error?: string; info?: MachineInfo }>;
  lemonadeDownloads(): Promise<{ ok: boolean; jobs: DownloadJob[] }>;
  lemonadeCatalog(): Promise<{ ok: boolean; error?: string; catalog: CatalogEntry[] }>;
  lemonadeModels(): Promise<{
    ok: boolean;
    error?: string;
    models: InstalledModel[];
    loaded?: string;
    /** LM Studio and Ollama models found on this machine. */
    foreign?: ForeignModel[];
  }>;
  /** Re-read the model folders and restart the daemon so it sees the result. */
  lemonadeRescan(): Promise<{
    ok: boolean;
    error?: string;
    found?: { source: string; dir: string; count: number }[];
  }>;
  lemonadeLoad(name: string): Promise<{ ok: boolean; error?: string; loaded?: string }>;
  lemonadeUnload(): Promise<{ ok: boolean; error?: string }>;
  lemonadePull(
    name: string,
    checkpoint?: string,
  ): Promise<{ ok: boolean; error?: string; models?: InstalledModel[] }>;
  /** Live progress for the download in flight; returns an unsubscribe. */
  onPullProgress(fn: (p: PullProgress & { name: string }) => void): () => void;
  /** The files in one repository, with sizes. */
  hfFiles(repo: string): Promise<{ ok: boolean; error?: string; files?: RepoFile[] }>;
  /** Browse Hugging Face directly: publisher, model kind, sort, full pages. */
  hfBrowse(q: {
    query?: string;
    authors?: string[];
    kind?: string;
    sort?: BrowseSort;
    ggufOnly?: boolean;
  }): Promise<{ ok: boolean; error?: string; result?: { models: HfModel[]; url: string } }>;
  registryVariants(
    checkpoint: string,
    source: RegistrySource,
  ): Promise<{ ok: boolean; error?: string; variants?: RepoVariants }>;
  registryPull(
    name: string,
    checkpoint: string,
    source: RegistrySource,
    recipe?: string,
  ): Promise<{ ok: boolean; error?: string; models?: InstalledModel[] }>;
  modelOptions(name: string): Promise<{ ok: boolean; error?: string; options?: ModelOptions }>;
  modelOptionsSet(
    name: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; options?: ModelOptions }>;
  modelOptionsReset(name: string): Promise<{ ok: boolean; error?: string; options?: ModelOptions }>;
  /** Whether this desktop shows tray icons at all. */
  trayAvailable(): Promise<boolean>;
  apiState(): Promise<ApiState>;
  apiConfig(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string; state: ApiState }>;
  apiStart(): Promise<{ ok: boolean; error?: string; state: ApiState }>;
  apiStop(): Promise<{ ok: boolean; error?: string; state: ApiState }>;
  /** The only call that returns a key's plaintext, and only at creation. */
  apiKeyCreate(label: string): Promise<{ ok: boolean; error?: string; state: ApiState; secret?: string }>;
  apiKeyRevoke(id: string): Promise<{ ok: boolean; error?: string; state: ApiState }>;
  apiRequests(): Promise<{ ok: boolean; entries: RequestRecord[] }>;
  apiCancel(id: string): Promise<{ ok: boolean }>;
  apiClearLog(): Promise<{ ok: boolean; entries: RequestRecord[] }>;
  onApi(cb: (state: ApiState) => void): () => void;
  onApiLog(cb: (entries: RequestRecord[]) => void): () => void;
  onRuntime(cb: (state: RuntimeState) => void): () => void;
  onRuntimeDownload(cb: (p: DownloadProgress | undefined) => void): () => void;

}

declare global {
  interface Window { karen: KarenApi }
}

/* ------------------------------------------------------------------ *
 * Privacy                                                             *
 * ------------------------------------------------------------------ */

export interface PrivacyReport {
  /** Every fixed host the app can contact, from src/core/destinations.ts. */
  destinations: { host: string; when: string; sends: string }[];
  /** Requests the window attempted and the egress filter cancelled. */
  blocked: { url: string; at: string }[];
  /** Where the user pointed their own endpoints, and whether that is local. */
  endpoints: { label: string; url: string; local: boolean }[];
}

/* ------------------------------------------------------------------ *
 * Research runs                                                       *
 * ------------------------------------------------------------------ */

export interface RunSummary {
  id: string;
  question: string;
  startedAt?: string;
  /** "180 found → 174 deduped → 41 screened in → 28 read in full → 22 cited". */
  funnel: string;
  /** Present when the run did not finish: the stage it would resume at. */
  nextStage?: string;
  paused: boolean;
}

export interface RunSourceRecord {
  n: number;
  url: string;
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  /** Exactly what was read, so a citation cannot drift from its source. */
  sha256: string;
  retrievedAt: string;
  chars: number;
  via: "html" | "pdf" | "abstract" | "text";
  /** Set when the full text came from an open version rather than the record. */
  note?: string;
}

export interface RunDetail extends RunSummary {
  stages: { stage: string; done: boolean }[];
  summary: string;
  counts: { found: number; deduped: number; screened: number; read: number; cited: number };
  queries: string[];
  searches: {
    at: string; query: string; category?: string; page?: number;
    results: number; newResults?: number; error?: string;
  }[];
  screened: {
    id: number; include: boolean; reason: string; defaulted?: boolean;
    title?: string; url?: string; year?: number; venue?: string; foundBy?: number;
    snowballRound?: number;
  }[];
  sources: RunSourceRecord[];
  dropped: { source: number; quote: string; reason: string }[];
  verification: {
    sentenceIndex: number; sentence: string; source: number; verdict: string; note: string;
  }[];
  quoteChecks: { quote: string; citation?: number; verbatim: boolean; reason?: string }[];
  report?: string;
  review?: string;
  bibtex?: string;
}

export interface RunSource {
  record?: RunSourceRecord;
  text: string;
  /** Where extraction located each cited passage in the text above. */
  spans: { start: number; end: number; quote: string; claim: string }[];
}

/* ------------------------------------------------------------------ *
 * Academic search                                                     *
 * ------------------------------------------------------------------ */

export type SortBy = "relevance" | "citations" | "newest";

export interface AcademicResult {
  id: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** Times cited, per OpenAlex. Absent for arXiv-only records. */
  citedBy?: number;
  doi?: string;
  abstract?: string;
  url: string;
  /** A directly readable full text, when the record names one. */
  pdfUrl?: string;
  engine: string;
}

/* ------------------------------------------------------------------ runtime */

export type Backend = "cpu" | "vulkan" | "cuda" | "rocm" | "metal";

export interface RuntimeDevice {
  id: string;
  description: string;
  totalBytes?: number;
  freeBytes?: number;
}

export interface ModelFit {
  verdict: "gpu" | "partial" | "cpu" | "too-large";
  requiredBytes: number;
  kvBytes?: number;
  estimated: boolean;
  label: string;
}

export interface RuntimeConfig {
  modelsDir: string;
  startOnLaunch: boolean;
  activeModel?: string;
  /** Chosen deliberately, unlike activeModel which is just the last one loaded. */
  /* `| undefined` explicitly, so clearing it is expressible: with
     exactOptionalPropertyTypes a bare optional cannot be set back to nothing,
     and un-choosing a default is a thing people need to do. */
  defaultModel?: string | undefined;
  useForChat: boolean;
  /** Offer models already downloaded by LM Studio and Ollama. */
  importForeignModels: boolean;
  extraModelDirs?: string[];
}

export type RuntimePhase =
  | { kind: "idle" }
  | { kind: "downloading"; what: string; receivedBytes: number; totalBytes?: number; bytesPerSecond: number }
  | { kind: "extracting"; what: string }
  | { kind: "probing"; what: string };

export interface ServerStatus {
  state: "stopped" | "starting" | "ready" | "failed";
  baseUrl?: string;
  modelPath?: string;
  error?: string;
  log: string[];
  pid?: number;
  /** Tokens one conversation gets, read from the running server's /props. */
  contextSize?: number;
  slots?: number;
}

/** The answer to "why did this build find no GPU". */
export interface RuntimeDiagnosis {
  nvidia: { driverVersion?: string; cudaCeiling?: string; names: string[] };
  /** The raw stdout+stderr of `llama-server --list-devices`. */
  probeLog: string;
  /** True when reinstalling the build would fix what the explanation describes. */
  repairable?: boolean;
  /** A plain-English cause, when one can be established. */
  explanation?: string;
}

export interface RuntimeState {
  config: RuntimeConfig;
  /** The Lemonade daemon: whether it is up, and what it is holding. */
  lemonade: {
    state: string;
    error?: string;
    loaded?: string;
    /** The model currently being loaded, while `load` has not yet returned. */
    loading?: string;
    /** Context size and device for the loaded model, straight from the daemon. */
    active?: LoadedModel;
    log: string[];
  };
}

export type CacheType = "f16" | "q8_0" | "q4_0";

export interface LaunchSettings {
  /** `?: T | undefined`, not `?: T`: undefined is the value that means "auto",
   *  and a patch has to be able to send it. */
  context?: number | undefined;
  slots: number;
  cacheType: CacheType;
  gpuLayers?: number | undefined;
  extraArgs?: string | undefined;
}

export interface LaunchBudget {
  /** True when the context was left for llama.cpp's --fit to size. */
  autofit: boolean;
  weightsBytes: number;
  cacheBytes: number;
  estimated: boolean;
  overheadBytes: number;
  totalBytes: number;
  budgetBytes: number;
  headroomBytes: number;
  verdict: ModelFit["verdict"];
  context: number;
}

export interface LaunchPlan {
  settings: LaunchSettings;
  budget: LaunchBudget;
  /** The tuning half of the command line, shown verbatim. */
  args: string[];
  /** Set when an extra argument was rejected; the budget is still valid. */
  error?: string;
}

export interface LocalModel {
  path: string;
  name: string;
  size?: number;
  /** The context it will start with, resolved from its settings. */
  context?: number;
  source?: string;
  shape?: { layers?: number; contextLength?: number; hasChatTemplate?: boolean; architecture?: string };
  fit?: ModelFit;
}

export interface HfSearchResult {
  id: string;
  downloads?: number;
  likes?: number;
  gated: false | "auto" | "manual";
  /** Hub tags, shown as text and never interpreted. */
  tags?: string[];
  lastModified?: string;
}

export interface HfFileChoice {
  label: string;
  entry: string;
  size: number;
  /** Every file that must be fetched. More than one for a sharded model. */
  parts: { path: string; size: number; sha256?: string }[];
  quant?: string;
  fit: ModelFit;
}

/** Electron's `systemPreferences.getMediaAccessStatus` states. */
export type MediaAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface DownloadProgress {
  what: string;
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
}
