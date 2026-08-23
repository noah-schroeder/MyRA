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

export interface EndpointSettings {
  baseUrl: string;
  envVar: string;
  model?: string;
  timeoutMs: number;
}

export interface Settings {
  permissionMode: "manual" | "guarded" | "yolo";
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
  method: "input" | "editor";
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
  engines(): Promise<{ pandoc: boolean; libreoffice: boolean }>;

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

  researchRuns(): Promise<string[]>;
  onResearchProgress(cb: (note: string) => void): () => void;
  answerPrompt(id: string, answer: string | undefined): Promise<void>;
  onPrompt(cb: (request: PromptRequest) => void): () => void;
}

declare global {
  interface Window { karen: KarenApi }
}
