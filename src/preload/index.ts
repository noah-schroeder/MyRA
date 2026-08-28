/**
 * The renderer's entire view of the outside world.
 *
 * Nothing here exposes Node, the filesystem, or the network. The renderer can
 * only ask the main process to do specific, named things -- which is what makes
 * `sandbox: true` meaningful rather than decorative.
 *
 * Smaller than v1's, because v1 also had to carry the bridge: pairing codes,
 * connection status, host-verb approvals and a network activity log all existed
 * because the agent lived on another machine. None of that is here.
 */

import { contextBridge, ipcRenderer } from "electron";

/** Mirrors AgentEvent in core. Duplicated rather than imported: the preload is
 *  bundled for the renderer and must not pull the main-process tree in. */
export interface AgentEventPayload {
  type: "text" | "tool_start" | "tool_update" | "tool_end" | "tool_error" | "done" | "error";
  text?: string;
  toolCallId?: string;
  tool?: string;
  params?: Record<string, unknown>;
  result?: string;
}

/** Subscribe to a main→renderer channel, returning an unsubscribe. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  /* ---- conversation ---- */
  send: (text: string) => ipcRenderer.invoke("karen:send", text),
  abort: () => ipcRenderer.invoke("karen:abort"),
  onAgentEvent: (cb: (event: AgentEventPayload) => void) => on("karen:agent-event", cb),

  /* ---- sessions ---- */
  newSession: () => ipcRenderer.invoke("karen:new-session"),
  listSessions: () => ipcRenderer.invoke("karen:list-sessions"),
  openSession: (id: string) => ipcRenderer.invoke("karen:open-session", id),
  deleteSession: (id: string) => ipcRenderer.invoke("karen:delete-session", id),
  deleteAllSessions: () => ipcRenderer.invoke("karen:delete-all-sessions"),

  /* ---- settings ---- */
  getSettings: () => ipcRenderer.invoke("karen:get-settings"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("karen:update-settings", patch),
  setSecret: (name: string, value: string) => ipcRenderer.invoke("karen:set-secret", name, value),
  secretsBackend: () => ipcRenderer.invoke("karen:secrets-backend"),
  discoverModels: (which: "llm" | "transcription" | "embeddings") =>
    ipcRenderer.invoke("karen:discover-models", which),
  testEndpoint: (which: "llm" | "transcription" | "embeddings") =>
    ipcRenderer.invoke("karen:test-endpoint", which),
  chooseDirectory: (opts: { title?: string; current?: string }) =>
    ipcRenderer.invoke("karen:choose-directory", opts),
  setResearch: (config: unknown) => ipcRenderer.invoke("karen:set-research", config),
  getResearch: () => ipcRenderer.invoke("karen:get-research"),
  engines: () => ipcRenderer.invoke("karen:engines"),
  mediaAccess: () => ipcRenderer.invoke("karen:media-access"),
  requestMicrophone: () => ipcRenderer.invoke("karen:request-microphone"),
  installPandoc: () => ipcRenderer.invoke("karen:install-pandoc"),
  onSetupProgress: (cb: (p: unknown) => void) => on("karen:setup-progress", cb),
  privacy: () => ipcRenderer.invoke("karen:privacy"),

  /* ---- meetings ----
   * Capture happens in the renderer, because device access is a Web API. The
   * renderer downsamples to mono 16 kHz s16le and pushes chunks here. */
  meetingState: () => ipcRenderer.invoke("karen:meeting-state"),
  meetingStart: (title: string, tracks: { id: string; label: string; source?: string }[]) =>
    ipcRenderer.invoke("karen:meeting-start", title, tracks),
  meetingAudio: (trackId: string, pcm: ArrayBuffer) =>
    ipcRenderer.invoke("karen:meeting-audio", trackId, pcm),
  meetingStop: () => ipcRenderer.invoke("karen:meeting-stop"),
  meetingDiscard: () => ipcRenderer.invoke("karen:meeting-discard"),
  meetingLevels: () => ipcRenderer.invoke("karen:meeting-levels"),
  onMeeting: (cb: (state: unknown) => void) => on("karen:meeting", cb),
  onMeetings: (cb: (list: unknown) => void) => on("karen:meetings", cb),
  meetingList: () => ipcRenderer.invoke("karen:meeting-list"),
  meetingTranscribe: (dir: string) => ipcRenderer.invoke("karen:meeting-transcribe", dir),
  meetingNotes: (dir: string) => ipcRenderer.invoke("karen:meeting-notes", dir),
  meetingRun: (dir: string) => ipcRenderer.invoke("karen:meeting-run", dir),
  meetingCancel: () => ipcRenderer.invoke("karen:meeting-cancel"),
  meetingInstructions: (dir: string, text: string) =>
    ipcRenderer.invoke("karen:meeting-instructions", dir, text),
  meetingRead: (dir: string, which: "notes" | "transcript") =>
    ipcRenderer.invoke("karen:meeting-read", dir, which),
  meetingReveal: (path: string) => ipcRenderer.invoke("karen:meeting-reveal", path),
  meetingDelete: (dir: string) => ipcRenderer.invoke("karen:meeting-delete", dir),

  /* ---- transcription runtime ----
   *
   * A second runtime beside llama.cpp, because llama.cpp cannot produce the
   * segment timestamps a two-track meeting is assembled from. Nothing here is
   * reachable by the model. */

  /* The renderer is the only thing that can enumerate capture devices, so it
   * reports them up rather than main asking down. */
  reportDevices: (devices: unknown[]) => ipcRenderer.invoke("karen:report-devices", devices),

  /* ---- dictation ---- */
  dictationStart: () => ipcRenderer.invoke("karen:dictation-start"),
  dictationAudio: (pcm: ArrayBuffer) => ipcRenderer.invoke("karen:dictation-audio", pcm),
  dictationStop: () => ipcRenderer.invoke("karen:dictation-stop"),
  dictationCancel: () => ipcRenderer.invoke("karen:dictation-cancel"),
  onDictationText: (cb: (text: string) => void) => on("karen:dictation-text", cb),

  /* ---- runtime ----
   * The bundled llama.cpp: opt-in, driven entirely by buttons in Settings.
   * Nothing here is reachable by the model -- no tool installs a runtime,
   * downloads a model, or starts a process. */
  runtimeState: () => ipcRenderer.invoke("karen:runtime-state"),
  runtimeConfig: (patch: unknown) => ipcRenderer.invoke("karen:runtime-config", patch),
  /** Why no GPU was found: the driver\u2019s own answer plus the raw probe output. */
  lemonadeEnsure: () => ipcRenderer.invoke("karen:lemonade-ensure"),
  lemonadeInfo: () => ipcRenderer.invoke("karen:lemonade-info"),
  lemonadeInstallBackend: (recipe: string, backend: string) =>
    ipcRenderer.invoke("karen:lemonade-install-backend", recipe, backend),
  lemonadeDownloads: () => ipcRenderer.invoke("karen:lemonade-downloads"),
  lemonadeCatalog: () => ipcRenderer.invoke("karen:lemonade-catalog"),
  lemonadeModels: () => ipcRenderer.invoke("karen:lemonade-models"),
  lemonadeRescan: () => ipcRenderer.invoke("karen:lemonade-rescan"),

  /* The API server. `apiKeyCreate` is the one call in the whole bridge that
     returns a secret, and it does so exactly once. */
  trayAvailable: () => ipcRenderer.invoke("karen:tray-available"),
  apiState: () => ipcRenderer.invoke("karen:api-state"),
  apiConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("karen:api-config", patch),
  apiStart: () => ipcRenderer.invoke("karen:api-start"),
  apiStop: () => ipcRenderer.invoke("karen:api-stop"),
  apiKeyCreate: (label: string) => ipcRenderer.invoke("karen:api-key-create", label),
  apiKeyRevoke: (id: string) => ipcRenderer.invoke("karen:api-key-revoke", id),
  apiRequests: () => ipcRenderer.invoke("karen:api-requests"),
  apiCancel: (id: string) => ipcRenderer.invoke("karen:api-cancel", id),
  apiClearLog: () => ipcRenderer.invoke("karen:api-clear-log"),
  onApi: (cb: (state: unknown) => void) => {
    const fn = (_e: unknown, state: unknown): void => cb(state);
    ipcRenderer.on("karen:api", fn);
    return () => ipcRenderer.removeListener("karen:api", fn);
  },
  onApiLog: (cb: (entries: unknown) => void) => {
    const fn = (_e: unknown, entries: unknown): void => cb(entries);
    ipcRenderer.on("karen:api-log", fn);
    return () => ipcRenderer.removeListener("karen:api-log", fn);
  },
  lemonadeLoad: (name: string) => ipcRenderer.invoke("karen:lemonade-load", name),
  lemonadeUnload: () => ipcRenderer.invoke("karen:lemonade-unload"),
  lemonadePull: (name: string, checkpoint?: string) =>
    ipcRenderer.invoke("karen:lemonade-pull", name, checkpoint),
  onRuntime: (cb: (state: unknown) => void) => on("karen:runtime", cb),
  onRuntimeDownload: (cb: (p: unknown) => void) => on("karen:runtime-download", cb),

  /* ---- model search ---- */

  /* ---- research ---- */
  /** Academic search the user runs directly. No model in the loop. */
  academicSearch: (query: string, opts: { page?: number; sort?: string }) =>
    ipcRenderer.invoke("karen:academic-search", query, opts),
  /** Open a link in the user's own browser, never in a window of ours. */
  openExternal: (url: string) => ipcRenderer.invoke("karen:open-external", url),
  researchRuns: () => ipcRenderer.invoke("karen:research-runs"),
  researchRun: (id: string) => ipcRenderer.invoke("karen:research-run", id),
  researchSource: (id: string, n: number) => ipcRenderer.invoke("karen:research-source", id, n),
  researchReveal: (id: string) => ipcRenderer.invoke("karen:research-reveal", id),
  onResearchProgress: (cb: (note: string) => void) => on("karen:research-progress", cb),
  /** Answer a clarifying question the pipeline asked. */
  answerPrompt: (id: string, answer: string | undefined) =>
    ipcRenderer.invoke("karen:answer-prompt", id, answer),
  onPrompt: (cb: (request: { id: string; title: string; method: "input" | "editor" | "confirm"; message?: string; prefill?: string }) => void) =>
    on("karen:prompt", cb),
};

contextBridge.exposeInMainWorld("karen", api);

export type KarenApi = typeof api;
