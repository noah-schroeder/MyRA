import type { DataTable } from "../core/tabular/table.ts";
import type { ChartData } from "../core/charts/layout.ts";
import type { ChartSpec } from "../core/charts/spec.ts";
import type { PrismaFigure } from "../core/prisma/spec.ts";
import type { CatalogEntry } from "../core/runtime/catalog.ts";
import type { Provider } from "../core/providers.ts";
import type { ModelPrice } from "../core/pricing.ts";
import type { HotkeySettings } from "../core/hotkeys.ts";
import type { ApiState } from "../main/api/manager.ts";

/* Re-exported so the renderer imports it from one place, the way every
   other shared shape in this file is reached. */
export type { ApiState };
import type { RequestRecord } from "../core/api/log.ts";
import type { ForeignModel } from "../core/runtime/foreign.ts";
import type { InstalledModel } from "../main/runtime/lemonadeApi.ts";
import type { LoadedModel } from "../core/runtime/lemonade.ts";
import type { ModelOptions } from "../core/runtime/modelOptions.ts";
import type { AutoContext, ModelShape } from "../core/runtime/fit.ts";
export type { RunFootprint } from "../core/research/run.ts";
import type { RunFootprint } from "../core/research/run.ts";
import type { RegistrySource, RepoVariants } from "../core/runtime/registry.ts";
import type { BrowseSort, HfModel, RepoDetail } from "../core/runtime/hfBrowse.ts";
import type { PreparedCard } from "../core/runtime/modelCard.ts";
import type { Owner } from "../core/runtime/modelOwner.ts";
import type { Paper, PaperKind, PaperSummary } from "../core/papers/paper.ts";
import type { Task, TaskSummary } from "../core/tasks/task.ts";
export type { Task, TaskSummary } from "../core/tasks/task.ts";
import type { Member, MemberKind, Project, ProjectSummary } from "../core/projects/project.ts";
export type { Member, MemberKind, Project, ProjectSummary } from "../core/projects/project.ts";
import type { DeleteReport, ItemRow, ProjectDetail } from "../main/projectStore.ts";
export type { DeleteReport, ItemRow, ProjectDetail } from "../main/projectStore.ts";
import type { DraftRequest } from "../core/papers/prompt.ts";
export type { Paper, PaperKind, PaperSection, PaperSummary } from "../core/papers/paper.ts";
export type { DraftRequest } from "../core/papers/prompt.ts";
export type { Review, ReviewReport, ReviewStatus, ReviewSummary } from "../core/review/record.ts";
import type { Review, ReviewSummary } from "../core/review/record.ts";
export type { JobSnapshot } from "../main/work.ts";
import type { JobSnapshot } from "../main/work.ts";
import type { PullProgress } from "../core/runtime/systemInfo.ts";
import type { DownloadJob, MachineInfo } from "../core/runtime/systemInfo.ts";
import type { ReasoningDialect } from "../core/llm/reasoningDialect.ts";
export type { ReasoningDialect, ReasoningLevel } from "../core/llm/reasoningDialect.ts";
import type { UpdateCheck as EngineUpdateCheck } from "../main/runtime/engineUpdates.ts";
export type { EngineUpdateCheck };
export type { PendingUpdate } from "../main/runtime/engineUpdates.ts";
export type { EngineUpdate } from "../core/runtime/engineReleases.ts";
export type { UpdateCheckResult } from "../main/appUpdate.ts";
import type { UpdateCheckResult } from "../main/appUpdate.ts";
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

export interface UserItem {
  id: string;
  kind: "user";
  text: string;
  /** What was attached, for the sent bubble -- name and kind only, never the bytes or the extracted text. */
  attachments?: { kind: "image" | "document" | "data"; name: string }[];
}

/**
 * One reply's speed. Mirrors MessageStats in core/llm/speed.ts by hand, for
 * the reason the whole file does: the renderer cannot import across the
 * sandbox boundary.
 */
export interface MessageStats {
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond?: number;
  promptPerSecond?: number;
  ttftMs?: number;
  totalMs: number;
  measured: boolean;
}

export interface AssistantItem {
  id: string;
  kind: "assistant";
  blocks: Block[];
  streaming?: boolean;
  /** Absent while streaming; filled in when the "stats" event for this reply arrives. */
  stats?: MessageStats;
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
  /** The window itself. Only known for a model MyRA started. */
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
  /** Where Zotero's library is, when MyRA cannot work it out. Empty = find it. */
  zoteroDataDir: string;
  /** When the stored Hugging Face token is actually sent to the model server. */
  hfTokenUse: "gated" | "always";
  workspaceRoot: string;
  vaultRoot: string;
  vaultWriteSubdir: string;
  hotkeys: HotkeySettings;
  dictationSource: string;
  dictationLanguage: string;
  deleteRawAudioAfterTranscription: boolean;
  meetingsRoot: string;
  /** Where generated images and their sidecars are kept. */
  imagesRoot: string;
  /** Where the paper drafter keeps one file per paper. */
  papersRoot: string;
  reviewsRoot: string;
  /** The project new work files itself into. Empty means none. */
  activeProject: string;
  /** The peer reviewer's instructions, and one block per study design. */
  reviewPrompt: string;
  reviewStudyTypes: StudyType[];
  meetingReportDir: string;
  meetingCaptureSystemAudio: boolean;
  meetingInstructions: string;
  /** Closing the window leaves MyRA running in the tray. */
  keepRunningInTray: boolean;
  setupCompleted: boolean;
  /** Whether the first-run tour has been shown. Settings -> About can reset it. */
  seenTutorial: boolean;
  providers: Provider[];
  /** Who the model is told it is. MyRA's rules follow it and are not editable. */
  persona: string;
  /** Per model, overriding the above. Keyed the way `sampling` is. */
  systemPrompts: Record<string, string>;
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
export type { HotkeySettings } from "../core/hotkeys.ts";

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
  /** Which databases Quick and Look up query, by id. Empty means the keyless defaults. */
  databases?: string[] | undefined;
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

/**
 * One of a meeting's extracted action items, mirroring
 * core/meetings/store.ts's `ActionRecord` -- redefined here rather than
 * imported, the same reason `MeetingSummary` above is: that module touches
 * node:fs.
 */
export interface ActionRecord {
  type: "decision" | "action" | "update" | "question" | "risk";
  title: string;
  owner: string | null;
  due: string | null;
  quote: string;
  certain: boolean;
  at: string | null;
  sourcing: "verbatim" | "reworded" | "unverified";
  sourceText?: string;
  speaker?: string;
  /** Set once this item has become a task -- the id of that task. */
  taskId?: string;
}

/** One Whisper model MyRA offers to download. */
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
    | "compacted" | "notice" | "done" | "error" | "stats";
  text?: string;
  /** For text: "thinking" is the model's reasoning, anything else is the answer. */
  kind?: "text" | "thinking";
  toolCallId?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
  /** For "stats": how fast the reply that just finished was. One per model call. */
  stats?: MessageStats;
  /** The conversation this event belongs to, so a renderer looking at a
   *  different one can tell it is not for them. */
  sessionId?: string;
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
/**
 * A figure `create_diagram` or `create_prisma_diagram` drew, or one read off a
 * research run.
 *
 * Mirrors DiagramUpdate in core/agent/tools/diagram.ts by hand, for the same
 * reason DocumentUpdate above is mirrored: the renderer does not import core's
 * agent modules. `prisma` itself is not mirrored, the way `TableUpdate.table`
 * below is not: it is pure computation, no different from core/diagrams/* that
 * DiagramView.tsx already reads from directly, and hand-copying it would be
 * one more place for a field to drift out of sync with spec.ts.
 *
 * Exactly one of `source`/`prisma` is ever set -- a Mermaid-drawn diagram
 * carries the first, a PRISMA figure the second, and DiagramView.tsx branches
 * on which one arrived.
 */
export interface DiagramUpdate {
  id: string;
  title: string;
  /** Mermaid flowchart source, re-rendered here rather than shipped as an image. */
  source?: string | undefined;
  /** A PRISMA 2020 figure, placed directly rather than parsed from Mermaid. */
  prisma?: PrismaFigure | undefined;
  /** The conversation this was drawn in, stamped on by main when it is pushed
   *  -- not part of the core type, which knows nothing about sessions; see
   *  AgentEvent.sessionId for the identical shape on chat events. */
  sessionId?: string;
}

/**
 * A table `create_table` built.
 *
 * Mirrors TableUpdate in core/agent/tools/table.ts by hand, for the same
 * reason DiagramUpdate above is -- the renderer does not import core's agent
 * modules. `table` itself is the real `DataTable`, imported directly: that
 * type is pure computation (core/tabular/*, no different from
 * core/diagrams/* that DiagramView.tsx already reads from directly), and
 * hand-mirroring it a second time would be one more place for `Cell`'s
 * text/value split to drift out of sync with what parse.ts actually produces.
 */
export interface TableUpdate {
  id: string;
  title: string;
  table: DataTable;
  notes: string[];
  style: "booktabs" | "siunitx";
  /** The conversation this was built in, stamped on by main when it is
   *  pushed -- see DiagramUpdate.sessionId. */
  sessionId?: string;
}

/**
 * A figure `create_chart` built. Mirrors ChartUpdate in
 * core/agent/tools/chart.ts by hand, for the same reason as above -- with
 * `data` and `spec` imported directly for the same reason `table` is.
 */
export interface ChartUpdate {
  id: string;
  title: string;
  data: ChartData;
  spec: ChartSpec;
  /** The conversation this was drawn in, stamped on by main when it is
   *  pushed -- see DiagramUpdate.sessionId. */
  sessionId?: string;
}

/** One already-drawn diagram/table/chart, as `myra:session-artifacts` returns
 *  it for a panel that mounts after the turn that made it -- the artifact
 *  equivalent of what `liveTurn`'s `events` gives a chat view catching up. */
export type ArtifactRecord =
  | { kind: "diagram"; value: DiagramUpdate }
  | { kind: "table"; value: TableUpdate }
  | { kind: "chart"; value: ChartUpdate };

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
  method: "input" | "editor" | "confirm" | "choice" | "models" | "form";
  title: string;
  message?: string;
  prefill?: string;
  placeholder?: string;
  /** choice: the answers to offer. "Other" is added by the dialog, not sent. */
  options?: string[];
  /** choice: whether several of them can be picked at once. */
  multi?: boolean;
  /** choice: no Skip button, and Continue stays disabled until something is picked. */
  required?: boolean;
  /** models: one dropdown per entry. */
  slots?: { key: string; label: string; hint: string }[];
  /** models: what each slot is set to now. */
  current?: Record<string, string>;
  /** form: every field to show, already grouped and ordered by the caller. */
  fields?: PromptField[];
}

/**
 * One field of a `form` prompt -- generic, so this dialog stays reusable the
 * way `choice` and `models` already are. `create_prisma_diagram` is the first
 * caller and the only one that knows the word "PRISMA"; nothing here does.
 */
export interface PromptField {
  key: string;
  label: string;
  hint?: string;
  /** A section heading, shown once above the first field carrying it. */
  group: string;
  /** A textarea for a variable-length list, rather than one line per number. */
  kind?: "list";
  value?: string;
  /** Offered from a source the user has not yet confirmed -- shown and marked. */
  guessed?: boolean;
}

export type { Download } from "../core/downloads/download.ts";
import type { Download } from "../core/downloads/download.ts";
export type { ReviewRequest, StudyType } from "../core/review/prompt.ts";
import type { ReviewRequest, StudyType } from "../core/review/prompt.ts";

/** The research run executing right now, reported whatever page is showing. */
export interface ActiveRun {
  id: string;
  stage?: string;
  note?: string;
}

/**
 * A dropped image or document, held in the composer between the drop and
 * Send. Mirrors the discriminated shape `myra:chat-attach` resolves to.
 */
export type PendingAttachment =
  | { kind: "image"; id: string; name: string; mime: string; bytes: number; canSee: boolean; warning?: string }
  | { kind: "document"; name: string; words: number; tokens: number; text: string }
  | { kind: "data"; id: string; name: string; rows: number; columns: string[] };

export type ChatAttachResult =
  | ({ ok: true } & PendingAttachment)
  | { ok: false; error?: string; needsPandoc?: boolean };

export interface MyRAApi {
  send(text: string, attachments?: PendingAttachment[]): Promise<void>;
  abort(): Promise<void>;
  /** A dropped image or document, read and sized before Send is pressed. */
  chatAttach(name: string, bytes: ArrayBuffer): Promise<ChatAttachResult>;
  /** Removes a not-yet-sent image's file. A no-op for a document (nothing was saved). */
  chatAttachRemove(id: string): Promise<void>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  onDocument(cb: (doc: DocumentUpdate) => void): () => void;
  /** A figure the conversation drew; mirrors DiagramUpdate in tools/diagram.ts. */
  onDiagram(cb: (diagram: DiagramUpdate) => void): () => void;
  /** Writes the figure into the documents folder and answers with its path. */
  diagramSave(
    name: string,
    format: "svg" | "png",
    data: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Puts the rasterised figure on the clipboard, so it pastes as a picture. */
  diagramCopyImage(dataUrl: string): Promise<{ ok: boolean; error?: string }>;
  /** Reopens a drawn PRISMA figure's form, prefilled, and redraws it in place. */
  prismaEdit(id: string, title: string, figure: PrismaFigure): Promise<{ ok: boolean; error?: string }>;
  /** A table `create_table` built; mirrors TableUpdate in tools/table.ts. */
  onTable(cb: (table: TableUpdate) => void): () => void;
  /** Writes the table's LaTeX into the documents folder and answers with its path. */
  tableSave(name: string, data: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Puts the table on the clipboard as a real, editable table -- the HTML
   *  flavour Word and Sheets paste as one, with TSV riding alongside for
   *  whatever does not accept it. */
  tableCopyWord(html: string, text: string): Promise<{ ok: boolean; error?: string }>;
  /** A figure `create_chart` built; mirrors ChartUpdate in tools/chart.ts. */
  onChart(cb: (chart: ChartUpdate) => void): () => void;
  /** Writes the figure into the documents folder (SVG, PNG or PGFPlots
   *  source, by extension) and answers with its path. */
  chartSave(
    name: string,
    format: "svg" | "png" | "tex",
    data: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Puts the rasterised figure on the clipboard, so it pastes as a picture. */
  chartCopyImage(dataUrl: string): Promise<{ ok: boolean; error?: string }>;
  revealDocument(path: string): Promise<void>;

  newSession(): Promise<string>;
  listSessions(): Promise<SessionSummary[]>;
  openSession(id: string): Promise<unknown[]>;
  renameSession(id: string, title: string): Promise<{ ok: boolean; error?: string }>;
  /** The conversation still generating right now, if any, and everything it
   *  has said so far -- so opening it mid-turn can resume instead of showing
   *  a conversation that looks stalled. */
  liveTurn(): Promise<{ sessionId: string; events: AgentEvent[] } | undefined>;
  /** Every diagram/table/chart this conversation already produced, for a
   *  panel that mounts after they were drawn. */
  sessionArtifacts(id: string): Promise<ArtifactRecord[]>;
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
  unloadModel(model: string): Promise<{ ok: boolean; error?: string }>;
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
  appVersion(): Promise<string>;
  /** Asks GitHub what has been released. Called from the button and nowhere else. */
  checkUpdate(): Promise<UpdateCheckResult>;

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
  meetingActions(dir: string): Promise<{ ok: boolean; error?: string; actions?: ActionRecord[] }>;
  meetingActionToTask(
    dir: string,
    index: number,
  ): Promise<{ ok: boolean; error?: string; taskId?: string; actions?: ActionRecord[] }>;
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
  /** Draws this run's PRISMA flow diagram from the counts already on disk. */
  researchPrisma(id: string): Promise<{ ok: boolean; error?: string }>;
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
  onResearchStage(cb: (stage: string) => void): () => void;
  researchActive(): Promise<ActiveRun | null>;
  onResearchActive(cb: (run: ActiveRun | null) => void): () => void;
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
  /**
   * Whether this model takes a thinking setting, and what it calls it.
   *
   * `note` carries the reason when there is no control, because "no setting"
   * and "not checked yet" look identical as an absence and only one of them
   * is something the user can do anything about.
   */
  reasoningCapability(): Promise<{
    ok: boolean;
    error?: string;
    /** One control each, in the order they should be drawn. */
    dialects?: ReasoningDialect[];
    /** `none` and `always` are findings; `unchecked` and `unknown` are not. */
    reason?: "none" | "always" | "unchecked" | "unknown";
    note?: string;
    /** The level in force per dialect id, defaults already applied. */
    values?: Record<string, string>;
  }>;
  /** Choose a level for one dialect, or clear it by passing nothing. */
  setReasoning(dialectId: string, value?: string): Promise<{ ok: boolean; error?: string }>;
  /** This model's own persona, the key it is stored under, and the global one. */
  modelPrompt(model?: string): Promise<{ ok: boolean; key: string; text: string; fallback: string }>;
  setModelPrompt(model: string | undefined, value?: string): Promise<{ ok: boolean; error?: string; key?: string }>;
  /** The sampler settings this model's authors published, and where they came from. */
  modelFacts(model?: string): Promise<{
    ok: boolean;
    key: string;
    repo?: string;
    suggested: Record<string, number>;
    hasSuggested: boolean;
    ignoreSuggested: boolean;
    /** Whether MyRA could read the architecture, so the context is measured. */
    measured: boolean;
    /** The model's own layer count, when known -- the GPU-layers and MoE-CPU
     *  sliders' real bound. */
    layers?: number;
    /** How many experts a MoE model routes between, when known. Informative:
     *  it decides whether the MoE-CPU slider is offered, not what it goes to. */
    experts?: number;
    /** The full shape, when known, for the memory bar to size a context against. */
    shape?: ModelShape;
    /** The weights on disk, in bytes -- the other half the bar needs. */
    sizeBytes?: number;
    /** The `ctx_size` MyRA itself last wrote, if it did. See `ctxIsOurs`. */
    autoCtxSize?: number;
    /** Whether this model is allowed to spill off the card for a longer window. */
    allowOffload?: boolean;
  }>;
  setIgnoreSuggested(model: string | undefined, ignore: boolean): Promise<{ ok: boolean }>;
  setAllowOffload(model: string | undefined, allow: boolean): Promise<{ ok: boolean }>;
  /** What MyRA would size this model's context to, without writing it. */
  modelContextPreview(model?: string): Promise<{ ok: boolean; error?: string; auto?: AutoContext }>;
  /** Writes exactly what the preview above showed. */
  modelContextApply(model?: string): Promise<{ ok: boolean; error?: string; auto?: AutoContext }>;
  /** The build each backend is on, and the one Lemonade shipped with. */
  engineVersions(): Promise<{
    ok: boolean;
    error?: string;
    pins: Record<string, string>;
    shipped: Record<string, string>;
  }>;
  /** Asks GitHub what has been released. Called from the button and nowhere else. */
  engineUpdatesCheck(): Promise<{ ok: boolean; error?: string; check?: EngineUpdateCheck }>;
  /** Move a backend to a build; no version means back to the shipped one. */
  engineUpdate(
    recipe: string,
    backend: string,
    version?: string,
  ): Promise<{ ok: boolean; error?: string; version?: string; info?: MachineInfo }>;
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
  reviewExtract(
    name: string,
    bytes: ArrayBuffer,
  ): Promise<{
    ok: boolean;
    error?: string;
    needsPandoc?: boolean;
    text?: string;
    title?: string;
    words?: number;
  }>;
  /** The window of the model that would answer. Asking never loads one. */
  reviewContext(): Promise<{ ok: boolean; error?: string; contextTokens?: number }>;
  reviewRun(
    requests: ReviewRequest[],
    meta: { title: string; fileName?: string; studyTypeId?: string },
  ): Promise<{
    ok: boolean;
    error?: string;
    id?: string;
    text?: string;
    invented?: string[];
    stopped?: boolean;
  }>;
  reviewCancel(id?: string): Promise<{ ok: boolean }>;
  reviewSave(
    name: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string; saved?: boolean; path?: string }>;
  reviewList(): Promise<{ ok: boolean; reviews?: ReviewSummary[] }>;
  reviewOpen(id: string): Promise<{ ok: boolean; error?: string; review?: Review }>;
  reviewDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  onReviews(cb: (rows: ReviewSummary[]) => void): () => void;
  /**
   * The long job that is not a chat turn: a review panel, or a section.
   *
   * `workState` is what a page asks on mount, so returning to a run already in
   * progress draws the reviewer being written rather than an empty page.
   */
  workState(): Promise<JobSnapshot | null>;
  onWork(cb: (job: JobSnapshot | null) => void): () => void;
  recent(): Promise<{ ok: boolean; items?: (ItemRow & { kind: MemberKind; project: string })[] }>;
  downloadsList(): Promise<Download[]>;
  downloadPause(id: string): Promise<{ ok: boolean }>;
  downloadResume(id: string): Promise<{ ok: boolean }>;
  downloadCancel(id: string): Promise<{ ok: boolean }>;
  downloadDismiss(id?: string): Promise<{ ok: boolean }>;
  onDownloads(fn: (list: Download[]) => void): () => void;
  onModelsChanged(fn: () => void): () => void;
  /** One repository: its files, and the facts a person chooses on. */
  hfDetail(repo: string): Promise<{ ok: boolean; error?: string; detail?: RepoDetail }>;
  /**
   * A repository's model card, prepared for rendering.
   *
   * `ok` with no `card` means the repository has no README, which is common
   * and is not a failure.
   */
  hfCard(repo: string): Promise<{ ok: boolean; error?: string; card?: PreparedCard }>;
  /** Remove a model from this machine; main decides whose file it is. */
  lemonadeDeleteModel(id: string): Promise<{
    ok: boolean;
    error?: string;
    result?: { owner: Owner; removed: string[]; restarted: boolean };
  }>;
  /** Show a model's real file in the desktop's file manager. */
  modelReveal(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Browse Hugging Face directly: publisher, model kind, sort, full pages. */
  hfBrowse(q: {
    query?: string;
    authors?: string[];
    kind?: string;
    sort?: BrowseSort;
    ggufOnly?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    result?: { models: HfModel[]; url: string; crossed: boolean; dropped: number };
  }>;
  registryVariants(
    checkpoint: string,
    source: RegistrySource,
  ): Promise<{ ok: boolean; error?: string; variants?: RepoVariants }>;
  /**
   * Add a diffusion model by naming its parts.
   *
   * Registers the definition only; the download that follows is `registryPull`
   * with an empty checkpoint, the same call the Recommended list makes. `field`
   * comes back on a rejection so the dialog can point at the input that is
   * wrong rather than at all four.
   */
  registerImageModel(
    name: string,
    parts: Record<string, string>,
    source: RegistrySource,
  ): Promise<{ ok: boolean; error?: string; field?: string; name?: string }>;
  registryPull(
    name: string,
    /** Empty for a model the daemon already has in its own catalogue. */
    checkpoint: string,
    source: RegistrySource,
    recipe?: string,
    /** Whether the registry itself reports this repository as gated -- false
        when that is simply not known, such as a catalogue entry with no
        resolvable repository, never guessed from anything else. */
    gated?: boolean,
    /* Resolves once the transfer has STARTED, carrying its id. It used to
       resolve when the bytes finished arriving, which is why a download could
       not outlive the component awaiting it. */
  ): Promise<{ ok: boolean; error?: string; id?: string }>;
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
  /* ---- projects ---- */
  projectList(): Promise<{ ok: boolean; projects: ProjectSummary[] }>;
  projectCreate(name: string): Promise<{ ok: boolean; project?: Project }>;
  projectRename(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  projectOpen(id: string): Promise<{ ok: boolean; error?: string; detail?: ProjectDetail }>;
  /** Everything in every store, each row naming the project it is already in. */
  projectItems(): Promise<{
    ok: boolean;
    items: (ItemRow & { kind: MemberKind; project: string })[];
  }>;
  projectAdd(id: string, members: Member[]): Promise<{ ok: boolean; error?: string }>;
  projectRemove(id: string, members: Member[]): Promise<{ ok: boolean; error?: string }>;
  /**
   * Delete a project. `contents` true takes the items with it.
   *
   * `report.failed` is not an error: one member can refuse — a research run
   * written to seconds ago declines, because it looks like it is still going —
   * without abandoning the rest.
   */
  projectDelete(
    id: string,
    contents: boolean,
  ): Promise<{ ok: boolean; error?: string; report?: DeleteReport }>;
  projectSetActive(id: string): Promise<{ ok: boolean; settings: Settings }>;
  projectExport(id: string): Promise<{
    ok: boolean;
    error?: string;
    path?: string;
    counts?: { kind: MemberKind; count: number }[];
  }>;
  projectReveal(path: string): Promise<{ ok: boolean }>;
  onProjects(cb: (projects: ProjectSummary[]) => void): () => void;

  /* ---- paper drafter ---- */
  paperList(): Promise<{ ok: boolean; papers: PaperSummary[] }>;
  paperCreate(kind: PaperKind, title: string): Promise<{ ok: boolean; paper?: Paper }>;
  paperOpen(id: string): Promise<{ ok: boolean; error?: string; paper?: Paper }>;
  paperSave(paper: Paper): Promise<{ ok: boolean; error?: string; updatedAt?: string }>;
  paperDelete(id: string): Promise<{ ok: boolean; papers?: PaperSummary[] }>;
  /**
   * Draft or refine one section.
   *
   * `invented` is citation-shaped text the model produced despite being told it
   * has no sources. Reported, never removed: a stripped marker leaves the
   * sentence reading as the author's own established fact.
   */
  paperDraft(
    paperId: string,
    sectionId: string,
    request: DraftRequest,
  ): Promise<{ ok: boolean; error?: string; text?: string; invented?: string[] }>;
  paperCancel(id?: string): Promise<{ ok: boolean }>;
  paperExport(id: string, format: string): Promise<{ ok: boolean; error?: string; path?: string }>;
  paperReveal(path: string): Promise<{ ok: boolean }>;
  /** The record as main saved it, after it committed a finished section. */
  onPaperChanged(cb: (paper: Paper) => void): () => void;
  onRuntime(cb: (state: RuntimeState) => void): () => void;
  onRuntimeDownload(cb: (p: DownloadProgress | undefined) => void): () => void;

  /* ---- tasks ----
   * MyRA's own list, ticked off here and nowhere else. See
   * core/agent/tools/tasks.ts's header for why writing to it is a plain
   * `write` rather than the floor-classed system_of_record. */
  taskList(): Promise<{ ok: boolean; tasks: TaskSummary[] }>;
  taskCreate(
    task: { title: string; due?: string; notes?: string; remindAt?: string },
  ): Promise<{ ok: boolean; error?: string; task?: Task; tasks?: TaskSummary[] }>;
  taskComplete(id: string): Promise<{ ok: boolean; error?: string; task?: Task; tasks?: TaskSummary[] }>;
  taskReopen(id: string): Promise<{ ok: boolean; error?: string; task?: Task; tasks?: TaskSummary[] }>;
  taskDelete(id: string): Promise<{ ok: boolean; tasks?: TaskSummary[] }>;
  /** Pushed whenever the list changes, from either the page or the agent. */
  onTasks(cb: (tasks: TaskSummary[]) => void): () => void;
}

declare global {
  interface Window { myra: MyRAApi }
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
  /** Which databases this run searched, by label. */
  databases: string[];
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
    /** The model a message would actually go to, resolved by the main process. */
    chat?: LoadedModel;
    /** Every model the daemon is holding, by id. */
    resident?: string[];
    log: string[];
  };
}

/*
 * `LaunchSettings` / `LaunchBudget` / `LaunchPlan` / `CacheType` used to live
 * here, describing a launch command MyRA built itself. Deleted along with
 * their producer, `core/runtime/launch.ts`, in "Hand the whole inference
 * stack to Lemonade" -- the daemon builds the launch command now. Their
 * replacement is `MemoryBudget` in `core/runtime/fit.ts`, which draws the
 * same kind of bar against a model's real GGUF shape rather than a plan MyRA
 * no longer makes.
 */

export interface LocalModel {
  path: string;
  name: string;
  size?: number;
  /** The context it will start with, resolved from its settings. */
  context?: number;
  source?: string;
  shape?: { layers?: number; contextLength?: number; hasChatTemplate?: boolean; architecture?: string };
  fit?: ModelFit;
  /** The daemon's own labels, so the picker can badge vision and tool-calling. */
  labels?: string[];
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
