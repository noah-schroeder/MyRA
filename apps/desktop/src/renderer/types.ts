export type Role = "user" | "assistant";

export interface TextBlock { kind: "text"; text: string }
export interface ThinkingBlock { kind: "thinking"; text: string }
export type Block = TextBlock | ThinkingBlock;

export interface UserItem { id: string; kind: "user"; text: string }

export interface AssistantItem {
  id: string;
  kind: "assistant";
  /** Keyed by contentIndex, since deltas arrive interleaved. */
  blocks: Map<number, Block>;
  done: boolean;
}

/**
 * A source a citation marker can point at.
 *
 * Comes from the tools, never from model output: web_search assigns numbers per
 * URL for the whole session, and deep_research hands over the same table its
 * citation audit ran against. So a [n] in the transcript resolves to something
 * that was really retrieved.
 */
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

export interface DictationState {
  phase: "idle" | "recording" | "transcribing";
  elapsedMs: number;
  /** Input level, 0..1, already scaled and smoothed by the main process. */
  level: number;
  /** The microphone has been producing nothing for a few seconds. */
  silent?: boolean;
  /** Input gain is too high and samples are hitting full scale. */
  clipping?: boolean;
  error?: string;
}

export interface MeetingProgress {
  stage: "transcribing" | "assembling" | "extracting" | "verifying" | "writing" | "filing" | "done";
  detail?: string;
  fraction: number;
}

export interface MeetingState {
  phase: "idle" | "recording" | "processing" | "done" | "failed";
  title?: string;
  elapsedMs?: number;
  progress?: MeetingProgress;
  error?: string;
  result?: {
    reportPath: string;
    transcriptPath: string;
    actions: number;
    unverified: number;
    audioDeleted: boolean;
  };
}

export interface AudioSource {
  id: number;
  name: string;
  description: string;
}

export interface HotkeyState {
  supported: boolean;
  installed: boolean;
  binding?: string;
  command?: string;
  reason?: string;
  socket?: string;
  socketReady?: boolean;
}

export interface ToolItem {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: "running" | "ok" | "error";
}

export type Item = UserItem | AssistantItem | ToolItem;

export interface Usage {
  input: number; output: number; totalTokens: number;
  cost?: { total: number };
}

export interface VaultStatus { usable: boolean; backend: string; reason: string }

export type ResearchMode = "off" | "web" | "deep";

export interface ResearchConfig {
  mode: ResearchMode;
  category: string;
  timeRange?: string;
}

export interface SearchCategory {
  name: string;
  engines: number;
  /** Whether a time filter does anything here. No scholarly engine supports one. */
  timeRange?: boolean;
}

export interface Status {
  bridgeConnected: boolean;
  mode: "manual" | "guarded" | "yolo";
  vault: VaultStatus;
  research?: ResearchConfig;
  settings: Settings;
  reviewQueue: { id: string; verb: string; args: Record<string, unknown>; at: number }[];
}

export interface EndpointSettings {
  baseUrl: string; envVar: string; model?: string; timeoutMs: number;
}

export interface Settings {
  bridgePort: number;
  permissionMode: "manual" | "guarded" | "yolo";
  llm: EndpointSettings;
  transcription: EndpointSettings;
  /** Separate from llm: embeddings are usually a different server and endpoint. */
  embeddings: EndpointSettings;
  workspaceRoot: string;
  vaultRoot: string;
  vaultWriteSubdir: string;
  dictationHotkey: string;
  dictationSource: string;
  dictationLanguage: string;
  deleteRawAudioAfterTranscription: boolean;
  /** On the host: where meeting recordings are kept until transcribed. */
  meetingsRoot: string;
  /** Vault-relative folder the meeting notes are filed in. */
  meetingReportDir: string;
  /** Record the system's output alongside the microphone. */
  meetingCaptureSystemAudio: boolean;
}

/** One past conversation, as the sidebar shows it. */
export interface SessionSummary {
  id: string;
  path: string;
  title: string;
  at: string;
  updatedAt: string;
  messages: number;
  /** Research runs started in this chat; deleted along with it. */
  runs: string[];
}

export interface ApprovalReq {
  id: string;
  verb: string;
  args: Record<string, unknown>;
  verdict: { risk: string; decision: string; reason: string; floor: boolean };
}

/**
 * A pi extension asking for interactive UI.
 *
 * The dialog methods BLOCK the extension until a matching response comes back,
 * so an unhandled one is not a missing feature — it is a hung agent.
 */
export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | string;
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  placeholder?: string;
  timeout?: number;
}

export interface KarenApi {
  getStatus(): Promise<Status & { secrets: Record<string, boolean> }>;
  rpc(payload: unknown): Promise<{ sent: boolean }>;
  setMode(mode: string): Promise<string>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  setSecret(name: string, value: string): Promise<{ persisted: boolean; present: Record<string, boolean> }>;
  probeModels(): Promise<{ models: { id: string; name: string }[] }>;
  getModels(): Promise<{ models?: unknown[] }>;
  getModelState(): Promise<{ model?: { id: string; provider: string } }>;
  writeModels(config: unknown): Promise<unknown>;
  respondToApproval(id: string, allowed: boolean, opts?: { alwaysAllowVerb?: string }): Promise<unknown>;
  getPairing(): Promise<{ token: string; port: number }>;
  getSearchCategories(): Promise<{ categories?: SearchCategory[] }>;
  setResearch(config: ResearchConfig): Promise<unknown>;
  pauseResearch(): Promise<unknown>;
  listSessions(): Promise<{ sessions?: SessionSummary[] }>;
  deleteSession(id: string): Promise<{ session: string; runsDeleted: string[] }>;
  deleteAllSessions(): Promise<{ sessions: number; runsDeleted: number }>;
  networkActivity(): Promise<{ at: number; url: string; allowed: boolean; reason: string }[]>;
  clearNetworkActivity(): Promise<boolean>;
  audit(): Promise<unknown[]>;
  chooseDirectory(opts: { title?: string; current?: string }): Promise<{ path?: string }>;
  testTranscription(): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  meetingState(): Promise<MeetingState>;
  meetingStart(title: string): Promise<{ tracks: number; systemAudio: boolean; warnings: string[] }>;
  meetingStop(): Promise<{ dir: string; tracks: number }>;
  meetingDiscard(): Promise<boolean>;
  meetingDismiss(): Promise<boolean>;
  onMeeting(cb: (s: MeetingState) => void): () => void;
  dictationState(): Promise<DictationState>;
  dictationToggle(): Promise<string>;
  dictationCancel(): Promise<string>;
  audioSources(): Promise<{ sources: AudioSource[] }>;
  hotkeyState(): Promise<HotkeyState>;
  hotkeyInstall(binding: string): Promise<HotkeyState & { conflicts?: string[] }>;
  hotkeyRemove(): Promise<HotkeyState>;
  onDictation(cb: (s: DictationState) => void): () => void;
  onDictationText(cb: (t: string) => void): () => void;
  commitTask(id: string): Promise<unknown>;
  dismissTask(id: string): Promise<boolean>;
  onRpcEvent(cb: (frame: any) => void): () => void;
  onStatus(cb: (s: Status) => void): () => void;
  onModelsChanged(cb: () => void): () => void;
  onApprovalRequest(cb: (r: ApprovalReq) => void): () => void;
}

declare global {
  interface Window { karen: KarenApi }
}
