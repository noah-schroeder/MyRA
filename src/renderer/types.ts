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
  status: "running" | "ok" | "error";
}

export type Item = UserItem | AssistantItem | ToolItem;

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

export interface Usage { input: number; output: number; total: number }

export type Theme = "dark" | "light";

export interface EndpointSettings {
  baseUrl: string;
  envVar: string;
  model?: string;
  timeoutMs: number;
}

export interface Settings {
  permissionMode: "manual" | "guarded" | "yolo";
  theme: Theme;
  llm: EndpointSettings;
  transcription: EndpointSettings;
  embeddings: EndpointSettings;
  workspaceRoot: string;
  vaultRoot: string;
  vaultWriteSubdir: string;
  dictationHotkey: string;
  dictationSource: string;
  dictationLanguage: string;
  deleteRawAudioAfterTranscription: boolean;
  meetingsRoot: string;
  meetingReportDir: string;
  meetingCaptureSystemAudio: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export type ResearchMode = "off" | "web" | "deep";

export interface ResearchConfig {
  mode: ResearchMode;
  category: string;
  timeRange?: string;
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
  error?: string;
}

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_update" | "tool_end" | "tool_error" | "done" | "error";
  text?: string;
  toolCallId?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
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
  method: "input" | "editor" | "confirm";
  title: string;
  message?: string;
  prefill?: string;
  placeholder?: string;
}

export interface KarenApi {
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;

  newSession(): Promise<string>;
  listSessions(): Promise<SessionSummary[]>;
  openSession(id: string): Promise<unknown[]>;
  deleteSession(id: string): Promise<void>;
  deleteAllSessions(): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  setSecret(name: string, value: string): Promise<unknown>;
  secretsBackend(): Promise<VaultStatus>;
  discoverModels(which: "llm" | "transcription" | "embeddings"): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  testEndpoint(which: "llm" | "transcription" | "embeddings"): Promise<{ ok: boolean; status?: number; error?: string }>;
  chooseDirectory(opts: { title?: string; current?: string }): Promise<string | undefined>;
  setResearch(config: ResearchConfig): Promise<void>;
  getResearch(): Promise<ResearchConfig>;
  engines(): Promise<{ pandoc: boolean; pandocPath?: string; pandocVersion?: string; pdftotext: boolean }>;
  privacy(): Promise<PrivacyReport>;

  meetingState(): Promise<MeetingState>;
  meetingStart(title: string, tracks: { id: string; label: string; source?: string }[]): Promise<string>;
  meetingAudio(trackId: string, pcm: ArrayBuffer): Promise<void>;
  meetingStop(): Promise<unknown>;
  meetingDiscard(): Promise<void>;
  meetingLevels(): Promise<Record<string, number>>;
  onMeeting(cb: (state: MeetingState) => void): () => void;
  reportDevices(devices: AudioSource[]): Promise<void>;

  dictationStart(): Promise<void>;
  dictationAudio(pcm: ArrayBuffer): Promise<void>;
  dictationStop(): Promise<void>;
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
  onResearchProgress(cb: (note: string) => void): () => void;
  answerPrompt(id: string, answer: string | undefined): Promise<void>;
  onPrompt(cb: (request: PromptRequest) => void): () => void;

  /* The bundled runtime. All user-driven: no tool reaches any of this. */
  runtimeState(): Promise<RuntimeState>;
  runtimeConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig>;
  runtimeDetect(): Promise<{ gpu: unknown; suggestion: { backend: Backend; reason: string } }>;
  runtimeSetUp(): Promise<{ ok: boolean; note?: string; error?: string; devices?: RuntimeDevice[]; build?: string }>;
  runtimeCheckUpdates(): Promise<{ ok: boolean; current?: string; newest?: string; behind?: number; error?: string }>;
  runtimeInstall(
    tag: string,
    backend: string,
  ): Promise<{ ok: boolean; error?: string; devices?: RuntimeDevice[]; accelerated?: boolean; build?: string }>;
  runtimeUpdate(tag?: string): Promise<{
    ok: boolean;
    error?: string;
    build?: string;
    from?: string;
    unchanged?: boolean;
    devices?: RuntimeDevice[];
    accelerated?: boolean;
  }>;
  runtimeActivate(id: string): Promise<{ ok: boolean; error?: string; build?: string; devices?: RuntimeDevice[] }>;
  runtimeRemoveBuild(id: string): Promise<{ ok: boolean; error?: string }>;
  runtimeProbe(): Promise<{ ok: boolean; devices?: RuntimeDevice[]; error?: string }>;
  runtimeCancel(): Promise<{ ok: boolean }>;
  runtimeModels(): Promise<LocalModel[]>;
  runtimeDeleteModel(path: string): Promise<{ ok: boolean; error?: string }>;
  runtimeStart(modelPath?: string): Promise<{ ok: boolean; status?: ServerStatus; error?: string }>;
  runtimeStop(): Promise<{ ok: boolean }>;
  onRuntime(cb: (state: RuntimeState) => void): () => void;
  onRuntimeDownload(cb: (p: DownloadProgress | undefined) => void): () => void;

  hfSearch(query: string, sort?: string): Promise<{ ok: boolean; models?: HfSearchResult[]; error?: string }>;
  hfFiles(repo: string): Promise<{ ok: boolean; files?: HfFileChoice[]; error?: string; gated?: boolean }>;
  hfInspect(repo: string, entry: string, size: number): Promise<{ shape?: unknown; fit: ModelFit; largestContext?: number }>;
  hfDownload(
    repo: string,
    parts: { path: string; size: number; sha256?: string }[],
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
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
  activeBuild?: string;
  backendOverride?: Backend;
  modelsDir: string;
  startOnLaunch: boolean;
  activeModel?: string;
  contextSize?: number;
  useForChat: boolean;
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
}

export interface RuntimeState {
  config: RuntimeConfig;
  phase: RuntimePhase;
  server: ServerStatus;
  /** The build the running process came from; differs from the active one
   *  between an update and the next restart. */
  serverBuild?: string;
  suggestion: { backend: Backend; reason: string };
  activeBuild?: { id: string; tag: string; backend: Backend };
  builds: { id: string; tag: string; backend: Backend }[];
  baseline: string;
  devices?: RuntimeDevice[];
  /** What the probe and the OS say this machine has, for sizing models. */
  machine?: { vramBytes?: number; ramBytes: number };
}

export interface LocalModel {
  path: string;
  name: string;
  size: number;
  source: string;
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

export interface DownloadProgress {
  what: string;
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
}
