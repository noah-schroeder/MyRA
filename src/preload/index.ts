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
  /** The conversation this event belongs to, so a renderer looking at a
   *  different one can tell it is not for them. */
  sessionId?: string;
}

/** Subscribe to a main→renderer channel, returning an unsubscribe. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  /* ---- conversation ---- */
  send: (text: string, attachments?: unknown[]) => ipcRenderer.invoke("myra:send", text, attachments ?? []),
  abort: () => ipcRenderer.invoke("myra:abort"),
  onAgentEvent: (cb: (event: AgentEventPayload) => void) => on("myra:agent-event", cb),
  /** A dropped image or document, read and sized before Send is pressed. */
  chatAttach: (name: string, bytes: ArrayBuffer) => ipcRenderer.invoke("myra:chat-attach", name, bytes),
  chatAttachRemove: (id: string) => ipcRenderer.invoke("myra:chat-attach-remove", id),

  /* ---- sessions ---- */
  newSession: () => ipcRenderer.invoke("myra:new-session"),
  listSessions: () => ipcRenderer.invoke("myra:list-sessions"),
  openSession: (id: string) => ipcRenderer.invoke("myra:open-session", id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke("myra:rename-session", id, title),
  /** Whatever conversation is still generating right now, and every event it
   *  has emitted so far -- so reopening it mid-turn can catch up. */
  liveTurn: () => ipcRenderer.invoke("myra:live-turn"),
  /** Every diagram/table/chart this conversation already produced, for a
   *  panel that mounts after they were drawn. */
  sessionArtifacts: (id: string) => ipcRenderer.invoke("myra:session-artifacts", id),
  deleteSession: (id: string) => ipcRenderer.invoke("myra:delete-session", id),
  deleteAllSessions: () => ipcRenderer.invoke("myra:delete-all-sessions"),

  /* ---- settings ---- */
  getSettings: () => ipcRenderer.invoke("myra:get-settings"),
  /* Settings the main process changed on its own account -- loading a local
     model stands down a hosted choice, and the bar has to hear about it. */
  onSettings: (cb: (settings: unknown) => void) => on("myra:settings", cb),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("myra:update-settings", patch),
  setSecret: (name: string, value: string) => ipcRenderer.invoke("myra:set-secret", name, value),
  secretsBackend: () => ipcRenderer.invoke("myra:secrets-backend"),
  discoverModels: (which: "llm" | "embeddings") =>
    ipcRenderer.invoke("myra:discover-models", which),
  testEndpoint: (which: "llm" | "embeddings") =>
    ipcRenderer.invoke("myra:test-endpoint", which),
  chooseDirectory: (opts: { title?: string; current?: string }) =>
    ipcRenderer.invoke("myra:choose-directory", opts),
  /* Every save of a written document, including the draft flow's per-section
     ones. Carries the text, so the panel showing it never races the writer. */
  onDocument: (cb: (doc: unknown) => void) => on("myra:document", cb),
  onDiagram: (cb: (diagram: unknown) => void) => on("myra:diagram", cb),
  diagramSave: (name: string, format: string, data: string) =>
    ipcRenderer.invoke("myra:diagram-save", name, format, data),
  diagramCopyImage: (dataUrl: string) => ipcRenderer.invoke("myra:diagram-copy-image", dataUrl),
  /** Reopen a drawn PRISMA figure's form, prefilled, and redraw it in place. */
  prismaEdit: (id: string, title: string, figure: unknown) =>
    ipcRenderer.invoke("myra:prisma-edit", id, title, figure),
  onTable: (cb: (table: unknown) => void) => on("myra:table", cb),
  tableSave: (name: string, data: string) => ipcRenderer.invoke("myra:table-save", name, data),
  tableCopyWord: (html: string, text: string) => ipcRenderer.invoke("myra:table-copy-word", html, text),
  onChart: (cb: (chart: unknown) => void) => on("myra:chart", cb),
  chartSave: (name: string, format: string, data: string) =>
    ipcRenderer.invoke("myra:chart-save", name, format, data),
  chartCopyImage: (dataUrl: string) => ipcRenderer.invoke("myra:chart-copy-image", dataUrl),
  revealDocument: (path: string) => ipcRenderer.invoke("myra:document-reveal", path),

  copy: (text: string) => ipcRenderer.invoke("myra:copy", text),

  /* ---- audio: the transcription and voice models ---- */
  audioModels: (role: "transcription" | "voice") =>
    ipcRenderer.invoke("myra:audio-models", role),
  audioLoad: (model: string) => ipcRenderer.invoke("myra:audio-load", model),
  /* Naming the model, so ejecting Whisper does not also drop the model the
     conversation is using. */
  /* Any model, not only a speech one: the chat menu ejects through this
     too, and a name that said "audio" would be a lie the next reader has
     to check. */
  unloadModel: (model: string) => ipcRenderer.invoke("myra:model-unload", model),
  onAudioProgress: (cb: (p: unknown) => void) => on("myra:audio-progress", cb),
  /* Returns the audio itself rather than a path. The window is sandboxed and
     has no filesystem, and an utterance written to disk would leave a record of
     what was said in the one feature that is spoken and gone. */
  speak: (text: string) => ipcRenderer.invoke("myra:audio-speak", text),
  previewVoice: (voice?: string) => ipcRenderer.invoke("myra:audio-preview", voice),

  /* ---- images ---- */
  imageModels: () => ipcRenderer.invoke("myra:image-models"),
  imageLoad: (model: string) => ipcRenderer.invoke("myra:image-load", model),
  onImageProgress: (cb: (p: unknown) => void) => on("myra:image-progress", cb),
  /* Returns the bytes AND files the picture. Unlike an utterance, a generated
     figure is a thing somebody wants next week -- so the gallery reads the
     folder while the window gets something it can draw immediately. */
  imageGenerate: (request: { prompt: string; negative?: string; preset?: string }) =>
    ipcRenderer.invoke("myra:image-generate", request),
  imageCancel: () => ipcRenderer.invoke("myra:image-cancel"),
  imageList: () => ipcRenderer.invoke("myra:image-list"),
  imageRead: (id: string) => ipcRenderer.invoke("myra:image-read", id),
  imageDelete: (id: string) => ipcRenderer.invoke("myra:image-delete", id),
  imageReveal: (id: string) => ipcRenderer.invoke("myra:image-reveal", id),
  imageSaveCopy: (id: string) => ipcRenderer.invoke("myra:image-save-copy", id),
  imageFolder: () => ipcRenderer.invoke("myra:image-folder"),
  /* ---- projects ----
   * A project is an index over the other five stores, not a sixth store: the
   * files never move, and "all of it together" is what Export writes. */
  projectList: () => ipcRenderer.invoke("myra:project-list"),
  /** `research` true starts the project with its memory "pending" -- the setup chat runs on its first message. */
  projectCreate: (name: string, research?: boolean) =>
    ipcRenderer.invoke("myra:project-create", name, research === true),
  projectRename: (id: string, name: string) =>
    ipcRenderer.invoke("myra:project-rename", id, name),
  projectOpen: (id: string, visit?: boolean) => ipcRenderer.invoke("myra:project-open", id, visit === true),
  projectSetCollections: (id: string, collections: { key: string; name: string }[]) =>
    ipcRenderer.invoke("myra:project-set-collections", id, collections),
  projectSources: (id: string) => ipcRenderer.invoke("myra:project-sources", id),
  projectPapersStatus: (id: string) => ipcRenderer.invoke("myra:project-papers-status", id),
  sourceAdd: (projectId: string, name: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke("myra:source-add", projectId, name, bytes),
  sourceEdit: (id: string, edit: { title?: string; authors?: string; year?: string; doi?: string }) =>
    ipcRenderer.invoke("myra:source-edit", id, edit),
  sourceDelete: (id: string) => ipcRenderer.invoke("myra:source-delete", id),
  sourceOpen: (id: string) => ipcRenderer.invoke("myra:source-open", id),
  onProjectSourcesChanged: (cb: (payload: { projectId: string }) => void) => on("myra:project-sources-changed", cb),
  /** Everything in every store, each row naming the project it is already in. */
  projectItems: () => ipcRenderer.invoke("myra:project-items"),
  projectAdd: (id: string, members: unknown) =>
    ipcRenderer.invoke("myra:project-add", id, members),
  projectRemove: (id: string, members: unknown) =>
    ipcRenderer.invoke("myra:project-remove", id, members),
  /** `contents` true deletes the items as well; false keeps them where they are. */
  projectDelete: (id: string, contents: boolean) =>
    ipcRenderer.invoke("myra:project-delete", id, contents),
  projectSetActive: (id: string) => ipcRenderer.invoke("myra:project-active", id),
  projectExport: (id: string) => ipcRenderer.invoke("myra:project-export", id),
  projectReveal: (path: string) => ipcRenderer.invoke("myra:project-reveal", path),
  onProjects: (cb: (list: unknown) => void) => on("myra:projects", cb),

  /* ---- project memory ----
   * A research project's notes, kept across the conversations filed to it.
   * Optional -- a plain project's memory is just an empty, already-settled
   * record, and every one of these still answers for it. */
  projectMemory: (id: string) => ipcRenderer.invoke("myra:project-memory", id),
  projectMemoryStartSetup: (id: string) => ipcRenderer.invoke("myra:project-memory-start-setup", id),
  projectMemoryAdd: (id: string, slot: string, text: string) =>
    ipcRenderer.invoke("myra:project-memory-add", id, slot, text),
  projectMemoryEdit: (id: string, itemId: string, text: string) =>
    ipcRenderer.invoke("myra:project-memory-edit", id, itemId, text),
  projectMemoryRemove: (id: string, itemId: string) =>
    ipcRenderer.invoke("myra:project-memory-remove", id, itemId),
  projectMemorySetAuto: (id: string, auto: boolean) =>
    ipcRenderer.invoke("myra:project-memory-set-auto", id, auto),
  projectMemorySupersede: (id: string, itemId: string, text: string) =>
    ipcRenderer.invoke("myra:project-memory-supersede", id, itemId, text),
  projectMemoryResolve: (id: string, itemId: string, by?: { text: string } | { id: string }) =>
    ipcRenderer.invoke("myra:project-memory-resolve", id, itemId, by),
  projectMemoryReopen: (id: string, itemId: string) =>
    ipcRenderer.invoke("myra:project-memory-reopen", id, itemId),
  projectMemorySuggestion: (id: string, itemId: string, accept: boolean) =>
    ipcRenderer.invoke("myra:project-memory-suggestion", id, itemId, accept),
  /** Grounds whatever the current conversation offers, shows a review dialog, saves what is approved. */
  projectMemoryUpdate: (id: string) => ipcRenderer.invoke("myra:project-memory-update", id),
  /** A memory changed somewhere other than this call -- the auto pass, or the update button. */
  onProjectMemoryChanged: (cb: (payload: { projectId: string }) => void) =>
    on("myra:project-memory-changed", cb),

  /* ---- paper drafter ----
   * Notes in, first-draft prose out, one section at a time. No endpoint and no
   * key of its own: it writes with whatever model the bar names. */
  paperList: () => ipcRenderer.invoke("myra:paper-list"),
  paperCreate: (kind: "paper" | "section", title: string) =>
    ipcRenderer.invoke("myra:paper-create", kind, title),
  paperOpen: (id: string) => ipcRenderer.invoke("myra:paper-open", id),
  paperSave: (paper: unknown) => ipcRenderer.invoke("myra:paper-save", paper),
  paperDelete: (id: string) => ipcRenderer.invoke("myra:paper-delete", id),
  /* The request is built in the window and sent whole, so the preview dialog
     renders the very object that goes to the model rather than a copy of the
     rules it was built from. */
  paperDraft: (paperId: string, sectionId: string, request: unknown) =>
    ipcRenderer.invoke("myra:paper-draft", paperId, sectionId, request),
  paperCancel: (id?: string) => ipcRenderer.invoke("myra:paper-cancel", id ?? null),
  paperExport: (id: string, format: string) =>
    ipcRenderer.invoke("myra:paper-export", id, format),
  paperReveal: (path: string) => ipcRenderer.invoke("myra:paper-reveal", path),
  /* The record as main saved it, because main is what commits a finished
     section now -- the page reflects the file rather than owning it. */
  onPaperChanged: (cb: (paper: unknown) => void) => on("myra:paper-changed", cb),

  /* ---- tasks ----
   * MyRA's own list. Never the calendar, and never any other program's task
   * list -- see core/agent/tools/tasks.ts's header for why that is what lets
   * these stay a plain `write` instead of the floor-classed system_of_record. */
  taskList: () => ipcRenderer.invoke("myra:task-list"),
  taskCreate: (task: { title: string; due?: string; notes?: string; remindAt?: string }) =>
    ipcRenderer.invoke("myra:task-create", task),
  taskComplete: (id: string) => ipcRenderer.invoke("myra:task-complete", id),
  taskReopen: (id: string) => ipcRenderer.invoke("myra:task-reopen", id),
  taskDelete: (id: string) => ipcRenderer.invoke("myra:task-delete", id),
  /** Pushed whenever the list changes, from either the page or the agent. */
  onTasks: (cb: (tasks: unknown) => void) => on("myra:tasks", cb),

  providerModels: (opts: { baseUrl: string; id?: string; apiKey?: string }) =>
    ipcRenderer.invoke("myra:provider-models", opts),
  providerReasoning: (opts: { baseUrl: string; id?: string; model: string; apiKey?: string }) =>
    ipcRenderer.invoke("myra:provider-reasoning", opts),
  setProviderKey: (id: string, value: string) =>
    ipcRenderer.invoke("myra:provider-key", id, value),
  providerKeysPresent: () => ipcRenderer.invoke("myra:provider-keys-present"),
  zoteroCollections: () => ipcRenderer.invoke("myra:zotero-collections"),
  zoteroStatus: () => ipcRenderer.invoke("myra:zotero-status"),
  setResearch: (config: unknown) => ipcRenderer.invoke("myra:set-research", config),
  getResearch: () => ipcRenderer.invoke("myra:get-research"),
  engines: () => ipcRenderer.invoke("myra:engines"),
  mediaAccess: () => ipcRenderer.invoke("myra:media-access"),
  requestMicrophone: () => ipcRenderer.invoke("myra:request-microphone"),
  installPandoc: () => ipcRenderer.invoke("myra:install-pandoc"),
  onSetupProgress: (cb: (p: unknown) => void) => on("myra:setup-progress", cb),
  privacy: () => ipcRenderer.invoke("myra:privacy"),
  appVersion: () => ipcRenderer.invoke("myra:app-version"),
  /* Leaves the machine, and only when the button in Settings → About is pressed. */
  checkUpdate: () => ipcRenderer.invoke("myra:check-update"),

  /* ---- meetings ----
   * Capture happens in the renderer, because device access is a Web API. The
   * renderer downsamples to mono 16 kHz s16le and pushes chunks here. */
  meetingState: () => ipcRenderer.invoke("myra:meeting-state"),
  meetingStart: (title: string, tracks: { id: string; label: string; source?: string }[]) =>
    ipcRenderer.invoke("myra:meeting-start", title, tracks),
  meetingAudio: (trackId: string, pcm: ArrayBuffer) =>
    ipcRenderer.invoke("myra:meeting-audio", trackId, pcm),
  meetingStop: () => ipcRenderer.invoke("myra:meeting-stop"),
  meetingDiscard: () => ipcRenderer.invoke("myra:meeting-discard"),
  meetingLevels: () => ipcRenderer.invoke("myra:meeting-levels"),
  onMeeting: (cb: (state: unknown) => void) => on("myra:meeting", cb),
  onMeetings: (cb: (list: unknown) => void) => on("myra:meetings", cb),
  meetingList: () => ipcRenderer.invoke("myra:meeting-list"),
  meetingTranscribe: (dir: string) => ipcRenderer.invoke("myra:meeting-transcribe", dir),
  meetingNotes: (dir: string) => ipcRenderer.invoke("myra:meeting-notes", dir),
  meetingRun: (dir: string) => ipcRenderer.invoke("myra:meeting-run", dir),
  meetingCancel: () => ipcRenderer.invoke("myra:meeting-cancel"),
  meetingInstructions: (dir: string, text: string) =>
    ipcRenderer.invoke("myra:meeting-instructions", dir, text),
  meetingRead: (dir: string, which: "notes" | "transcript") =>
    ipcRenderer.invoke("myra:meeting-read", dir, which),
  /* The note's action items, and turning one into a MyRA task -- see
     core/agent/tools/tasks.ts's header for why that list stays a plain
     `write` and never touches a real calendar or task manager. */
  meetingResearchProjects: () => ipcRenderer.invoke("myra:meeting-research-projects"),
  meetingToProjectNotes: (dir: string) => ipcRenderer.invoke("myra:meeting-to-project-notes", dir),
  meetingActions: (dir: string) => ipcRenderer.invoke("myra:meeting-actions", dir),
  meetingActionToTask: (dir: string, index: number) =>
    ipcRenderer.invoke("myra:meeting-action-to-task", dir, index),
  meetingReveal: (path: string) => ipcRenderer.invoke("myra:meeting-reveal", path),
  meetingDelete: (dir: string) => ipcRenderer.invoke("myra:meeting-delete", dir),

  /* ---- transcription runtime ----
   *
   * A second runtime beside llama.cpp, because llama.cpp cannot produce the
   * segment timestamps a two-track meeting is assembled from. Nothing here is
   * reachable by the model. */

  /* The renderer is the only thing that can enumerate capture devices, so it
   * reports them up rather than main asking down. */
  reportDevices: (devices: unknown[]) => ipcRenderer.invoke("myra:report-devices", devices),

  /* ---- dictation ---- */
  dictationStart: () => ipcRenderer.invoke("myra:dictation-start"),
  dictationAudio: (pcm: ArrayBuffer) => ipcRenderer.invoke("myra:dictation-audio", pcm),
  dictationStop: () => ipcRenderer.invoke("myra:dictation-stop"),
  dictationCancel: () => ipcRenderer.invoke("myra:dictation-cancel"),
  onDictationText: (cb: (text: string) => void) => on("myra:dictation-text", cb),

  /* ---- runtime ----
   * The bundled llama.cpp: opt-in, driven entirely by buttons in Settings.
   * Nothing here is reachable by the model -- no tool installs a runtime,
   * downloads a model, or starts a process. */
  runtimeState: () => ipcRenderer.invoke("myra:runtime-state"),
  runtimeConfig: (patch: unknown) => ipcRenderer.invoke("myra:runtime-config", patch),
  /** Why no GPU was found: the driver\u2019s own answer plus the raw probe output. */
  lemonadeEnsure: () => ipcRenderer.invoke("myra:lemonade-ensure"),
  lemonadeInfo: () => ipcRenderer.invoke("myra:lemonade-info"),
  lemonadeInstallBackend: (recipe: string, backend: string) =>
    ipcRenderer.invoke("myra:lemonade-install-backend", recipe, backend),
  lemonadeDownloads: () => ipcRenderer.invoke("myra:lemonade-downloads"),
  /* What the chosen model can be told about thinking, and the choice itself.
     Both are per model: the vocabulary belongs to the endpoint. */
  reasoningCapability: () => ipcRenderer.invoke("myra:reasoning-capability"),
  /* Main derives the key: three per-model records share it, and the window has
     been wrong about which one a loaded model uses before. */
  modelPrompt: (model?: string) => ipcRenderer.invoke("myra:model-prompt", model ?? null),
  /* What the model's authors published: shown as each field's placeholder, so an
     untouched box says where its value comes from. */
  modelFacts: (model?: string) => ipcRenderer.invoke("myra:model-facts", model ?? null),
  setIgnoreSuggested: (model: string | undefined, ignore: boolean) =>
    ipcRenderer.invoke("myra:model-facts-ignore", model ?? null, ignore),
  setAllowOffload: (model: string | undefined, allow: boolean) =>
    ipcRenderer.invoke("myra:model-facts-allow-offload", model ?? null, allow),
  /* Read-only: what MyRA would size the context to, for the tuning panel's
     "Recompute" offer, shown before anyone presses it. */
  modelContextPreview: (model?: string) => ipcRenderer.invoke("myra:model-context-preview", model ?? null),
  /* Writes exactly what the preview above showed. */
  modelContextApply: (model?: string) => ipcRenderer.invoke("myra:model-context-apply", model ?? null),
  setModelPrompt: (model: string | undefined, value?: string) =>
    ipcRenderer.invoke("myra:set-model-prompt", model ?? null, value ?? null),
  setReasoning: (dialectId: string, value?: string) =>
    ipcRenderer.invoke("myra:set-reasoning", dialectId, value ?? null),
  /* Engine builds. `engineUpdatesCheck` is the only one of the three that
     leaves the machine, and only when a button is pressed. */
  engineVersions: () => ipcRenderer.invoke("myra:engine-versions"),
  engineUpdatesCheck: () => ipcRenderer.invoke("myra:engine-updates-check"),
  engineUpdate: (recipe: string, backend: string, version?: string) =>
    ipcRenderer.invoke("myra:engine-update", recipe, backend, version ?? null),
  lemonadeCatalog: () => ipcRenderer.invoke("myra:lemonade-catalog"),
  lemonadeModels: () => ipcRenderer.invoke("myra:lemonade-models"),
  lemonadeRescan: () => ipcRenderer.invoke("myra:lemonade-rescan"),

  /* The API server. `apiKeyCreate` is the one call in the whole bridge that
     returns a secret, and it does so exactly once. */
  trayAvailable: () => ipcRenderer.invoke("myra:tray-available"),
  apiState: () => ipcRenderer.invoke("myra:api-state"),
  apiConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("myra:api-config", patch),
  apiStart: () => ipcRenderer.invoke("myra:api-start"),
  apiStop: () => ipcRenderer.invoke("myra:api-stop"),
  apiKeyCreate: (label: string) => ipcRenderer.invoke("myra:api-key-create", label),
  apiKeyRevoke: (id: string) => ipcRenderer.invoke("myra:api-key-revoke", id),
  apiRequests: () => ipcRenderer.invoke("myra:api-requests"),
  apiCancel: (id: string) => ipcRenderer.invoke("myra:api-cancel", id),
  apiClearLog: () => ipcRenderer.invoke("myra:api-clear-log"),
  onApi: (cb: (state: unknown) => void) => {
    const fn = (_e: unknown, state: unknown): void => cb(state);
    ipcRenderer.on("myra:api", fn);
    return () => ipcRenderer.removeListener("myra:api", fn);
  },
  onApiLog: (cb: (entries: unknown) => void) => {
    const fn = (_e: unknown, entries: unknown): void => cb(entries);
    ipcRenderer.on("myra:api-log", fn);
    return () => ipcRenderer.removeListener("myra:api-log", fn);
  },
  lemonadeLoad: (name: string) => ipcRenderer.invoke("myra:lemonade-load", name),
  lemonadeUnload: () => ipcRenderer.invoke("myra:lemonade-unload"),
  hfDetail: (repo: string) => ipcRenderer.invoke("myra:hf-detail", repo),
  hfCard: (repo: string) => ipcRenderer.invoke("myra:hf-card", repo),
  lemonadeDeleteModel: (id: string) => ipcRenderer.invoke("myra:lemonade-delete-model", id),
  modelReveal: (id: string) => ipcRenderer.invoke("myra:model-reveal", id),
  /*
   * A manuscript, as bytes.
   *
   * The dropped file's CONTENT crosses, never its path: the renderer reads it
   * with the standard `arrayBuffer()`, so nothing here needs filesystem access
   * and MyRA never learns where a confidential manuscript is stored.
   */
  reviewExtract: (name: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke("myra:review-extract", name, bytes),
  reviewContext: () => ipcRenderer.invoke("myra:review-context"),
  reviewRun: (requests: unknown, meta: unknown) =>
    ipcRenderer.invoke("myra:review-run", requests, meta),
  reviewCancel: (id?: string) => ipcRenderer.invoke("myra:review-cancel", id ?? null),
  reviewSave: (name: string, text: string) => ipcRenderer.invoke("myra:review-save", name, text),
  reviewList: () => ipcRenderer.invoke("myra:review-list"),
  reviewOpen: (id: string) => ipcRenderer.invoke("myra:review-open", id),
  reviewDelete: (id: string) => ipcRenderer.invoke("myra:review-delete", id),
  onReviews: (cb: (rows: unknown) => void) => on("myra:reviews", cb),

  /*
   * The long job that is not a chat turn, in one shape for both features.
   *
   * `workState` is the half that matters: a page mounted in the middle of a run
   * asks once and draws what has arrived so far, rather than sitting blank until
   * the next reviewer starts.
   */
  workState: () => ipcRenderer.invoke("myra:work-state"),
  onWork: (cb: (job: unknown) => void) => on("myra:work", cb),
  recent: () => ipcRenderer.invoke("myra:recent"),

  /* Every transfer, pushed whenever the list changes. Independent of any
     page: the registry lives in main precisely so a download outlives the
     screen it was started from. */
  downloadsList: () => ipcRenderer.invoke("myra:downloads-list"),
  downloadPause: (id: string) => ipcRenderer.invoke("myra:download-pause", id),
  downloadResume: (id: string) => ipcRenderer.invoke("myra:download-resume", id),
  downloadCancel: (id: string) => ipcRenderer.invoke("myra:download-cancel", id),
  downloadDismiss: (id?: string) => ipcRenderer.invoke("myra:download-dismiss", id ?? ""),
  onDownloads: (fn: (list: unknown) => void) => {
    const handler = (_e: unknown, list: unknown): void => fn(list);
    ipcRenderer.on("myra:downloads", handler);
    return () => ipcRenderer.removeListener("myra:downloads", handler);
  },
  onModelsChanged: (fn: () => void) => {
    const handler = (): void => fn();
    ipcRenderer.on("myra:models-changed", handler);
    return () => ipcRenderer.removeListener("myra:models-changed", handler);
  },
  hfBrowse: (q: {
    query?: string;
    authors?: string[];
    kind?: string;
    sort?: string;
    ggufOnly?: boolean;
  }) => ipcRenderer.invoke("myra:hf-browse", q),
  registryVariants: (checkpoint: string, source: string) =>
    ipcRenderer.invoke("myra:registry-variants", checkpoint, source),
  registryPull: (name: string, checkpoint: string, source: string, recipe?: string, gated?: boolean) =>
    ipcRenderer.invoke("myra:registry-pull", name, checkpoint, source, recipe, gated ?? false),
  registerImageModel: (name: string, parts: Record<string, string>, source: string) =>
    ipcRenderer.invoke("myra:register-image-model", name, parts, source),
  modelOptions: (name: string) => ipcRenderer.invoke("myra:model-options", name),
  modelOptionsSet: (name: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("myra:model-options-set", name, patch),
  modelOptionsReset: (name: string) => ipcRenderer.invoke("myra:model-options-reset", name),
  onRuntime: (cb: (state: unknown) => void) => on("myra:runtime", cb),
  onRuntimeDownload: (cb: (p: unknown) => void) => on("myra:runtime-download", cb),

  /* ---- model search ---- */

  /* ---- research ---- */
  /** Academic search the user runs directly. No model in the loop. */
  academicSearch: (query: string, opts: { page?: number; sort?: string }) =>
    ipcRenderer.invoke("myra:academic-search", query, opts),
  /** Open a link in the user's own browser, never in a window of ours. */
  openExternal: (url: string) => ipcRenderer.invoke("myra:open-external", url),
  researchRuns: () => ipcRenderer.invoke("myra:research-runs"),
  researchRun: (id: string) => ipcRenderer.invoke("myra:research-run", id),
  researchSource: (id: string, n: number) => ipcRenderer.invoke("myra:research-source", id, n),
  researchReveal: (id: string) => ipcRenderer.invoke("myra:research-reveal", id),
  researchPrisma: (id: string) => ipcRenderer.invoke("myra:research-prisma", id),
  researchFootprint: (id: string) => ipcRenderer.invoke("myra:research-footprint", id),
  researchDelete: (id: string) => ipcRenderer.invoke("myra:research-delete", id),
  onResearchProgress: (cb: (note: string) => void) => on("myra:research-progress", cb),
  onResearchStage: (cb: (stage: string) => void) => on("myra:research-stage", cb),
  /** The run in flight, for a page that has just mounted into the middle of one. */
  researchActive: () => ipcRenderer.invoke("myra:research-active-state"),
  /** The research run executing right now, or null. Independent of the page. */
  onResearchActive: (
    cb: (run: { id: string; stage?: string; note?: string } | null) => void,
  ) => on("myra:research-active", cb),
  /** Answer a clarifying question the pipeline asked. */
  answerPrompt: (id: string, answer: string | undefined) =>
    ipcRenderer.invoke("myra:answer-prompt", id, answer),
  onPrompt: (
    cb: (request: {
      id: string;
      title: string;
      method: "input" | "editor" | "confirm" | "choice" | "models" | "form";
      message?: string;
      prefill?: string;
      options?: string[];
      multi?: boolean;
      required?: boolean;
      slots?: { key: string; label: string; hint: string }[];
      current?: Record<string, string>;
      fields?: {
        key: string; label: string; hint?: string; group: string;
        kind?: "list"; value?: string; guessed?: boolean;
      }[];
    }) => void,
  ) => on("myra:prompt", cb),
};

contextBridge.exposeInMainWorld("myra", api);

export type MyRAApi = typeof api;
