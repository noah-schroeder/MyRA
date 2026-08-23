/**
 * The renderer's entire view of the outside world.
 *
 * Nothing here exposes Node, the filesystem, or the network. The renderer can
 * only ask the main process to do specific, named things -- which is what makes
 * `sandbox: true` and the egress filter meaningful rather than decorative.
 */

import { contextBridge, ipcRenderer } from "electron";

const api = {
  getStatus: () => ipcRenderer.invoke("karen:get-status"),

  /** Send a pi RPC command (prompt, abort, set_model, ...). */
  rpc: (payload: unknown) => ipcRenderer.invoke("karen:rpc", payload),

  pauseResearch: () => ipcRenderer.invoke("karen:pause-research"),
  listSessions: () => ipcRenderer.invoke("karen:list-sessions"),
  deleteSession: (id: string) => ipcRenderer.invoke("karen:delete-session", id),
  deleteAllSessions: () => ipcRenderer.invoke("karen:delete-all-sessions"),
  setMode: (mode: string) => ipcRenderer.invoke("karen:set-mode", mode),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("karen:update-settings", patch),
  setSecret: (name: string, value: string) => ipcRenderer.invoke("karen:set-secret", name, value),

  probeModels: () => ipcRenderer.invoke("karen:probe-models"),
  getModelState: () => ipcRenderer.invoke("karen:get-model-state"),
  getModels: () => ipcRenderer.invoke("karen:get-models"),
  writeModels: (config: unknown) => ipcRenderer.invoke("karen:write-models", config),

  respondToApproval: (id: string, allowed: boolean, opts?: { alwaysAllowVerb?: string }) =>
    ipcRenderer.invoke("karen:approval-response", id, allowed, opts),

  getPairing: () => ipcRenderer.invoke("karen:get-pairing"),

  getSearchCategories: () => ipcRenderer.invoke("karen:get-search-categories"),
  setResearch: (config: unknown) => ipcRenderer.invoke("karen:set-research", config),

  networkActivity: () => ipcRenderer.invoke("karen:network-activity"),
  clearNetworkActivity: () => ipcRenderer.invoke("karen:clear-network-activity"),
  audit: () => ipcRenderer.invoke("karen:audit"),

  chooseDirectory: (opts: { title?: string; current?: string }) =>
    ipcRenderer.invoke("karen:choose-directory", opts),
  testTranscription: () => ipcRenderer.invoke("karen:test-transcription"),
  meetingState: () => ipcRenderer.invoke("karen:meeting-state"),
  meetingStart: (title: string) => ipcRenderer.invoke("karen:meeting-start", title),
  meetingStop: () => ipcRenderer.invoke("karen:meeting-stop"),
  meetingDiscard: () => ipcRenderer.invoke("karen:meeting-discard"),
  meetingDismiss: () => ipcRenderer.invoke("karen:meeting-dismiss"),
  onMeeting: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("karen:meeting", h);
    return () => ipcRenderer.removeListener("karen:meeting", h);
  },
  dictationState: () => ipcRenderer.invoke("karen:dictation-state"),
  dictationToggle: () => ipcRenderer.invoke("karen:dictation-toggle"),
  dictationCancel: () => ipcRenderer.invoke("karen:dictation-cancel"),
  audioSources: () => ipcRenderer.invoke("karen:audio-sources"),
  hotkeyState: () => ipcRenderer.invoke("karen:hotkey-state"),
  hotkeyInstall: (binding: string) => ipcRenderer.invoke("karen:hotkey-install", binding),
  hotkeyRemove: () => ipcRenderer.invoke("karen:hotkey-remove"),
  onDictation: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("karen:dictation", h);
    return () => ipcRenderer.removeListener("karen:dictation", h);
  },
  onDictationText: (cb: (t: string) => void) => {
    const h = (_e: unknown, t: string) => cb(t);
    ipcRenderer.on("karen:dictation-text", h);
    return () => ipcRenderer.removeListener("karen:dictation-text", h);
  },
  commitTask: (id: string) => ipcRenderer.invoke("karen:commit-task", id),
  dismissTask: (id: string) => ipcRenderer.invoke("karen:dismiss-task", id),

  /* --- push channels --- */
  onRpcEvent: (cb: (frame: unknown) => void) => {
    const h = (_e: unknown, frame: unknown) => cb(frame);
    ipcRenderer.on("karen:rpc-event", h);
    return () => ipcRenderer.off("karen:rpc-event", h);
  },
  onStatus: (cb: (status: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("karen:status", h);
    return () => ipcRenderer.off("karen:status", h);
  },
  onModelsChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on("karen:models-changed", h);
    return () => ipcRenderer.off("karen:models-changed", h);
  },
  onApprovalRequest: (cb: (req: unknown) => void) => {
    const h = (_e: unknown, r: unknown) => cb(r);
    ipcRenderer.on("karen:approval-request", h);
    return () => ipcRenderer.off("karen:approval-request", h);
  },
};

contextBridge.exposeInMainWorld("karen", api);

export type KarenApi = typeof api;
