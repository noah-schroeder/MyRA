/**
 * Karen main process.
 *
 * Privacy is applied here first and everywhere else second: the Chromium
 * hardening switches below must be set before app.whenReady(), and the egress
 * filter is installed on the session before any window loads.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  ActionRequestFrame,
  PermissionMode,
  PiFrame,
  PiOutbound,
  ResearchConfig,
} from "@karen/protocol";
import { DEFAULT_RESEARCH } from "@karen/protocol";
import { isSafeExternalUrl } from "../shared/safeUrl.ts";
import { ControlServer, type ControlCommand } from "./control.ts";
import { Dictation } from "./dictation.ts";
import { appFetch, useEgressFilter } from "./appFetch.ts";
import { defaultTracks, localDay, MeetingRecorder, type MeetingRecord } from "./meeting.ts";
import { runMeeting, type RunProgress, type RunResult } from "./meetingRun.ts";
import { defaultSink } from "./audio.ts";
import { conflicts, hotkeyState, installHotkey, removeHotkey } from "./hotkey.ts";
import { ConfigStore, type Settings } from "./config.ts";
import { SecretVault, type SecretName } from "./secrets.ts";
import { EgressFilter } from "./egress.ts";
import { BridgeServer } from "./bridge-server.ts";
import { Broker, type ApprovalRequest } from "./broker.ts";

/* ------------------------------------------------------------------ *
 * Chromium quietening. Electron itself is silent, but Chromium is not. *
 * These must precede app.whenReady().                                  *
 * ------------------------------------------------------------------ */
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("no-pings");
app.commandLine.appendSwitch("disable-features", "MediaRouter,OptimizationHints,Translate");
app.commandLine.appendSwitch("metrics-recording-only");
// Prefer the real keyring so safeStorage does not silently fall back to a
// hardcoded password. secrets.ts detects and reports it if this fails anyway.
app.commandLine.appendSwitch("password-store", "gnome-libsecret");

// crashReporter is deliberately never started: it uploads nothing unless it is.

const config = new ConfigStore();
const vault = new SecretVault();
const egress = new EgressFilter();
// The app's own fetches do not pass through webRequest, so they are decided and
// logged by the same filter explicitly. See appFetch.ts.
useEgressFilter(egress);

let win: BrowserWindow | undefined;
let bridge: BridgeServer | undefined;
let broker: Broker | undefined;

/**
 * The current research selection.
 *
 * Held here as well as in the VM so a renderer reload restores what the user
 * chose, rather than silently resetting the control while the agent keeps
 * behaving the old way.
 */
let research: ResearchConfig = { ...DEFAULT_RESEARCH };
async function config_setResearch(next: ResearchConfig): Promise<void> {
  research = next;
}

/**
 * The research config as the VM should see it.
 *
 * The renderer chooses the mode and category; the embeddings endpoint comes
 * from Settings and is attached here, so the control does not have to know
 * about it and cannot get it wrong. Only the env var NAME travels — the key
 * itself goes through the secrets channel.
 */
function researchFrame(): ResearchConfig {
  const e = config.current.embeddings;
  return {
    ...research,
    ...(e.baseUrl && e.model
      ? { embeddings: { baseUrl: e.baseUrl, envVar: e.envVar, model: e.model } }
      : {}),
  };
}

/** Pending approval prompts, keyed by request id. */
const approvals = new Map<string, (allowed: boolean) => void>();
/** Tasks the agent proposed, awaiting a human click. */
const reviewQueue: { id: string; verb: string; args: Record<string, unknown>; at: number }[] = [];
let dictation: Dictation | undefined;
let meeting: MeetingRecorder | undefined;
/** What the meeting panel is showing: recording, processing, or the result. */
let meetingState: {
  phase: "idle" | "recording" | "processing" | "done" | "failed";
  title?: string;
  elapsedMs?: number;
  progress?: RunProgress;
  error?: string;
  result?: {
    reportPath: string;
    transcriptPath: string;
    actions: number;
    unverified: number;
    audioDeleted: boolean;
  };
} = { phase: "idle" };
let meetingTicker: NodeJS.Timeout | undefined;
let control: ControlServer | undefined;

function push(channel: string, payload: unknown): void {
  // Sending to destroyed webContents throws, and these fire from timers and
  // background work that outlive the window during shutdown.
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushStatus(): void {
  push("karen:status", {
    bridgeConnected: bridge?.connected ?? false,
    mode: config.current.permissionMode,
    vault: vault.status(),
    settings: config.current,
    reviewQueue,
    research,
  });
}

/**
 * Send the permission mode to the VM.
 *
 * The host broker enforces policy for its own verbs, but pi's built-in tools --
 * bash, write, edit -- never reach the broker. They are policed by the guard
 * extension inside the VM, which therefore needs the current mode. Fire and
 * forget: a disconnected bridge re-seeds from the handshake when it returns.
 */
/**
 * The command GNOME should run for the hotkey.
 *
 * Packaged, karen-ctl is on PATH. Running from a checkout it is not, so the
 * built file is named directly -- otherwise the binding installs cleanly and
 * then does nothing, which is a miserable thing to debug.
 */
function ctlCommand(): string {
  if (app.isPackaged) return "karen-ctl dictate-toggle";
  const local = join(__dirname, "../../../ctl/dist/index.js");
  // Quoted, because GNOME parses this with shell-like splitting and a checkout
  // path containing a space (this repo's does) otherwise becomes two argv
  // entries. The binding installs cleanly and then silently does nothing --
  // exactly the failure that is hardest to attribute to the hotkey.
  return `${shellQuote(process.execPath)} ${shellQuote(local)} dictate-toggle`;
}

/** Single-quote for g_shell_parse_argv, which is what GNOME uses here. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pushPolicy(): void {
  if (!bridge?.connected) return;
  void bridge
    .ctl("set_policy", {
      config: {
        mode: config.current.permissionMode,
        workspaceRoot: config.current.workspaceRoot,
      },
    })
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Approvals                                                           *
 * ------------------------------------------------------------------ */

function requestApproval(req: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID();
    approvals.set(id, resolve);
    push("karen:approval-request", { id, ...req });
    // A prompt nobody answers must not wedge the agent forever.
    setTimeout(() => {
      if (approvals.delete(id)) resolve(false);
    }, 5 * 60_000);
  });
}

/* ------------------------------------------------------------------ *
 * Window                                                              *
 * ------------------------------------------------------------------ */

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0d0f12",
    title: "Karen",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  // Never navigate away, and never open a browser window from page content.
  //
  // The URL is handed to the user's own browser rather than loaded here: the
  // host app must never fetch web content, and a citation link is still web
  // content. The scheme check matters because these URLs now arrive from search
  // results, which are attacker-influenceable -- openExternal on a javascript:,
  // file: or custom-scheme URL hands the desktop a payload it will act on.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    // Parsed, not prefix-matched: "http://localhost".startsWith held true for
    // http://localhost.evil.com, which is a different host entirely.
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      /* unparseable is not navigable */
    }
    const allowed =
      parsed?.protocol === "file:" ||
      ((parsed?.protocol === "http:" || parsed?.protocol === "https:") &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"));
    if (!allowed) event.preventDefault();
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));

  win.on("closed", () => (win = undefined));
}

/* ------------------------------------------------------------------ *
 * IPC                                                                 *
 * ------------------------------------------------------------------ */

function registerIpc(): void {
  // Everything returned here crosses the structured-clone boundary, so it must
  // be plain data -- an un-awaited promise fails at runtime, not compile time.
  ipcMain.handle("karen:get-status", async () => ({
    bridgeConnected: bridge?.connected ?? false,
    mode: config.current.permissionMode,
    vault: vault.status(),
    settings: config.current,
    reviewQueue,
    research,
    secrets: await vault.present(),
  }));

  ipcMain.handle("karen:rpc", (_e, payload: PiOutbound) => {
    bridge?.sendRpc(payload);
    return { sent: bridge?.connected ?? false };
  });

  ipcMain.handle("karen:set-mode", async (_e, mode: PermissionMode) => {
    await config.update({ permissionMode: mode });
    broker?.clearSessionApprovals();
    // The VM polices pi's built-in tools itself, so it needs the new mode now.
    // Without this the handshake's copy goes stale and the control silently
    // stops applying to bash, write and edit.
    pushPolicy();
    pushStatus();
    return config.current.permissionMode;
  });

  ipcMain.handle("karen:update-settings", async (_e, patch: Partial<Settings>) => {
    const next = await config.update(patch);
    egress.setAllowedEndpoints(config.egressAllowlist());
    pushStatus();
    return next;
  });

  ipcMain.handle("karen:set-secret", async (_e, name: SecretName, value: string) => {
    const { persisted } = await vault.set(name, value);
    // pi reads credentials at spawn, so tell the bridge to pull the new value
    // and restart its child; otherwise the key would not apply until reconnect.
    if (name === "llmKey" && bridge?.connected) {
      await bridge.ctl("refresh_secrets").catch(() => undefined);
    }
    pushStatus();
    return { persisted, present: await vault.present() };
  });

  ipcMain.handle(
    "karen:approval-response",
    (_e, id: string, allowed: boolean, opts?: { alwaysAllowVerb?: string }) => {
      const resolve = approvals.get(id);
      if (!resolve) return { ok: false };
      approvals.delete(id);
      // "Always allow" is honoured only for non-floor verbs; Broker enforces that.
      if (allowed && opts?.alwaysAllowVerb) broker?.allowForSession(opts.alwaysAllowVerb);
      resolve(allowed);
      return { ok: true };
    },
  );

  // NOTE: there is deliberately no separate "allow this verb for the session"
  // channel. Session approval is granted only as part of answering an approval
  // prompt, above -- an IPC handler that widens permissions with no dialog
  // behind it is a thing to be wired up by accident later.

  // Model discovery happens in the VM: the host app is not permitted to contact
  // the LLM endpoint at all under the two-zone network model.
  ipcMain.handle("karen:probe-models", async () => {
    const s = config.current;
    return bridge?.ctl("probe_models", { baseUrl: s.llm.baseUrl, envVar: s.llm.envVar });
  });

  ipcMain.handle("karen:get-model-state", async () => bridge?.ctl("get_state"));

  ipcMain.handle("karen:get-models", async () => bridge?.ctl("get_models"));
  ipcMain.handle("karen:write-models", async (_e, cfg: unknown) => {
    const result = await bridge?.ctl("write_models", { config: cfg });
    // Tell the window straight away so the model dropdown reflects the new
    // catalogue without waiting for Settings to be closed.
    push("karen:models-changed", {});
    return result;
  });

  /**
   * The pairing secret for the VM.
   *
   * The token necessarily exists in plaintext inside the VM (the bridge must
   * present it), so revealing it here is not a new exposure -- it is the only
   * way to provision it. Kept behind an explicit user action rather than
   * written to disk automatically.
   */
  ipcMain.handle("karen:get-pairing", async () => {
    const token = await vault.ensureBridgeToken();
    return { token, port: config.current.bridgePort };
  });

  // Research controls. The category list comes from the running SearXNG so the
  // dropdown offers exactly what the user's own engine configuration supports,
  // rather than a list hardcoded here that would drift from reality.
  ipcMain.handle("karen:get-search-categories", async () =>
    bridge?.ctl("get_search_categories"),
  );
  ipcMain.handle("karen:list-sessions", async () => bridge?.ctl("list_sessions", {}));

  ipcMain.handle("karen:delete-session", async (_e, id: string) =>
    bridge?.ctl("delete_session", { id }));

  ipcMain.handle("karen:delete-all-sessions", async () =>
    bridge?.ctl("delete_all_sessions", {}));

  ipcMain.handle("karen:pause-research", async () => {
    return bridge?.ctl("pause_research", {});
  });

  ipcMain.handle("karen:set-research", async (_e, next: unknown) => {
    await config_setResearch(next as ResearchConfig);
    const result = await bridge?.ctl("set_research", { config: researchFrame() });
    pushStatus();
    return result;
  });

  ipcMain.handle("karen:network-activity", () => egress.activity);
  ipcMain.handle("karen:clear-network-activity", () => {
    egress.clearActivity();
    return true;
  });
  ipcMain.handle("karen:audit", async () => broker?.readAudit());

  /* ---------------- dictation ---------------- */

  ipcMain.handle("karen:dictation-state", () => dictation?.state() ?? { phase: "idle", elapsedMs: 0, level: 0 });
  ipcMain.handle("karen:dictation-toggle", async () => dictation?.toggle());
  ipcMain.handle("karen:dictation-cancel", async () => dictation?.cancel());
  ipcMain.handle("karen:audio-sources", async () => ({ sources: (await dictation?.sources()) ?? [] }));

  ipcMain.handle("karen:hotkey-state", async () => {
    const state = await hotkeyState();
    // Report the socket too: a perfectly installed binding still does nothing
    // if the app could not open the socket karen-ctl talks to.
    return { ...state, socket: control?.path, socketReady: Boolean(control) };
  });

  ipcMain.handle("karen:hotkey-install", async (_e, binding: string) => {
    const command = ctlCommand();
    const clashes = await conflicts(binding);
    const state = await installHotkey(binding, command);
    await config.update({ dictationHotkey: binding });
    pushStatus();
    return { ...state, conflicts: clashes };
  });

  ipcMain.handle("karen:hotkey-remove", async () => {
    const state = await removeHotkey();
    pushStatus();
    return state;
  });

  /**
   * A native folder picker.
   *
   * Typing a path into a text field is how you end up with a vault that is one
   * typo away from the real one and silently empty. The dialog also means the
   * path exists before it is saved.
   */
  ipcMain.handle("karen:choose-directory", async (_e, opts: { title?: string; current?: string }) => {
    if (!win) return { path: undefined };
    const result = await dialog.showOpenDialog(win, {
      title: opts?.title ?? "Choose a folder",
      properties: ["openDirectory", "createDirectory"],
      ...(opts?.current ? { defaultPath: opts.current } : {}),
    });
    return { path: result.canceled ? undefined : result.filePaths[0] };
  });

  /**
   * Ask the transcription endpoint what it serves.
   *
   * Separate from probe-models, which asks the VM to probe the LLM. This one
   * the app performs itself, because the app is what will be uploading audio --
   * so a success here means the path dictation actually uses works.
   */
  ipcMain.handle("karen:test-transcription", async () => {
    const endpoint = config.current.transcription;
    if (!endpoint.baseUrl) return { ok: false, error: "No base URL is set." };
    const base = endpoint.baseUrl.replace(/\/+$/, "");
    const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    try {
      const key = await vault.get("transcriptionKey").catch(() => undefined);
      const res = await appFetch(url, {
        signal: AbortSignal.timeout(15_000),
        ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      });
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const body = (await res.json().catch(() => undefined)) as { data?: { id?: string }[] } | undefined;
      const models = (body?.data ?? []).map((m) => String(m.id)).filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        error: e.name === "TimeoutError" ? "The endpoint did not answer within 15s." : e.message,
      };
    }
  });

  /* ---------------- meetings ---------------- */

  ipcMain.handle("karen:meeting-state", () => ({
    ...meetingState,
    ...(meeting?.recording ? { elapsedMs: meeting.elapsedMs } : {}),
  }));

  ipcMain.handle("karen:meeting-start", async (_e, title: string) => {
    if (!meeting) throw new Error("meetings are not available");
    const settings = config.current;
    // The default output device is resolved now rather than remembered, so
    // plugging in headphones between meetings does the right thing.
    const sink = settings.meetingCaptureSystemAudio ? await defaultSink().catch(() => undefined) : undefined;
    const tracks = defaultTracks({
      source: settings.dictationSource,
      systemAudio: settings.meetingCaptureSystemAudio,
      sink,
    });
    /*
     * What will go wrong later, said now.
     *
     * Everything that turns a recording into notes happens after the meeting
     * ends, so a missing endpoint or vault surfaces an hour too late to do
     * anything about it. This does not block recording -- a meeting cannot be
     * held again, and audio with no notes still beats no audio.
     */
    const missing: string[] = [];
    if (!settings.transcription.baseUrl) missing.push("no transcription endpoint is set");
    if (!settings.llm.baseUrl) missing.push("no language model endpoint is set");
    if (!settings.vaultRoot) missing.push("no vault is chosen, so notes have nowhere to go");
    if (tracks.length === 1 && settings.meetingCaptureSystemAudio) {
      missing.push("no output device was found, so only the microphone is being recorded");
    }

    await meeting.start(title, tracks);
    meetingState = {
      phase: "recording",
      title,
      elapsedMs: 0,
      ...(missing.length ? { error: `Recording, but ${missing.join("; ")}.` } : {}),
    };
    meetingTicker = setInterval(() => push("karen:meeting", {
      ...meetingState,
      elapsedMs: meeting?.elapsedMs ?? 0,
    }), 1000);
    push("karen:meeting", meetingState);
    return { tracks: tracks.length, systemAudio: tracks.length > 1, warnings: missing };
  });

  ipcMain.handle("karen:meeting-stop", async () => {
    if (!meeting?.recording) throw new Error("no meeting is being recorded");
    clearInterval(meetingTicker);
    const record = await meeting.stop();
    meetingState = { phase: "processing", title: record.title };
    push("karen:meeting", meetingState);
    // Deliberately not awaited: transcribing an hour of audio takes minutes,
    // and the window must stay usable throughout.
    void processMeeting(record);
    return { dir: record.dir, tracks: record.tracks.length };
  });

  ipcMain.handle("karen:meeting-discard", async () => {
    clearInterval(meetingTicker);
    await meeting?.discard();
    meetingState = { phase: "idle" };
    push("karen:meeting", meetingState);
    return true;
  });

  ipcMain.handle("karen:meeting-dismiss", () => {
    // Clear a finished or failed run from the panel.
    if (meetingState.phase === "done" || meetingState.phase === "failed") meetingState = { phase: "idle" };
    push("karen:meeting", meetingState);
    return true;
  });

  ipcMain.handle("karen:commit-task", async (_e, id: string) => {
    const idx = reviewQueue.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error("no such proposal");
    const entry = reviewQueue[idx]!;
    // Commit by VERB, so a calendar proposal is not silently filed as a task.
    // Removed only once it succeeds: a failed commit (Planify missing, EDS
    // down) must leave the proposal in the queue to retry, not drop it.
    const result =
      entry.verb === "calendar.propose_event"
        ? await broker!.commitProposedEvent(entry.args)
        : await broker!.commitProposedTask(entry.args);
    reviewQueue.splice(idx, 1);
    pushStatus();
    return result;
  });

  ipcMain.handle("karen:dismiss-task", (_e, id: string) => {
    const idx = reviewQueue.findIndex((t) => t.id === id);
    if (idx !== -1) reviewQueue.splice(idx, 1);
    pushStatus();
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Startup                                                             *
 * ------------------------------------------------------------------ */

/**
 * Export the pairing token to a file, when explicitly asked via
 * KAREN_EXPORT_TOKEN.
 *
 * This is the same disclosure as Settings -> Pairing -> Reveal token, just
 * scriptable. It is not a weakening: the token must exist in plaintext inside
 * the VM anyway (the bridge has to present it), so the only question is how it
 * gets there. Opt-in via env var, written 0600, never on by default.
 */
/**
 * Everything after the recording stops.
 *
 * Runs unattended for minutes. Failures land in the panel rather than being
 * thrown into the void, because the audio is still on disk and a failed run is
 * worth retrying -- unlike the meeting, which cannot be held again.
 */
async function processMeeting(record: MeetingRecord): Promise<void> {
  try {
    const settings = config.current;
    const result: RunResult = await runMeeting({
      record,
      context: {
        title: record.title,
        date: localDay(record.startedAt),
      },
      transcription: settings.transcription,
      llm: settings.llm,
      ...(await secretsFor()),
      reportDir: settings.meetingReportDir,
      deleteAudio: settings.deleteRawAudioAfterTranscription,
      save: (rel, content) => broker!.saveToVault(rel, content),
      onProgress: (progress) => {
        meetingState = { ...meetingState, phase: "processing", progress };
        push("karen:meeting", meetingState);
      },
    });

    // Verified actions become proposals. Unverified ones do not: an item whose
    // quote is not in the transcript may be invented, and the review queue is
    // the one place in this app where a click creates something real.
    let queued = 0;
    for (const action of result.actions) {
      if (action.sourcing === "unverified") continue;
      reviewQueue.push({
        id: randomUUID(),
        verb: "planify.propose",
        args: {
          content: action.title,
          ...(action.owner ? { description: `Owner: ${action.owner}` } : {}),
          ...(action.due ? { due: action.due } : {}),
          project: action.project,
          labels: "meeting",
        },
        at: Date.now(),
      });
      queued++;
    }

    meetingState = {
      phase: "done",
      title: record.title,
      result: {
        reportPath: result.reportPath,
        transcriptPath: result.transcriptPath,
        actions: queued,
        unverified: result.notes.items.filter((i) => i.sourcing === "unverified").length,
        audioDeleted: result.audioDeleted,
      },
    };
    push("karen:meeting", meetingState);
    pushStatus();
  } catch (err) {
    meetingState = {
      phase: "failed",
      title: record.title,
      // The recording survives a failed run; say where it is.
      error: `${(err as Error).message} — the recording is still at ${record.dir}`,
    };
    push("karen:meeting", meetingState);
  }
}

/** Endpoint keys, when the vault has them. */
async function secretsFor(): Promise<{ transcriptionKey?: string; llmKey?: string }> {
  const [transcriptionKey, llmKey] = await Promise.all([
    vault.get("transcriptionKey").catch(() => undefined),
    vault.get("llmKey").catch(() => undefined),
  ]);
  return {
    ...(transcriptionKey ? { transcriptionKey } : {}),
    ...(llmKey ? { llmKey } : {}),
  };
}

async function maybeExportToken(): Promise<void> {
  const dest = process.env["KAREN_EXPORT_TOKEN"];
  if (!dest) return;
  const token = await vault.ensureBridgeToken();
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, token, { mode: 0o600 });
  console.log(`[karen] pairing token exported to ${dest}`);
}

async function start(): Promise<void> {
  await config.load();
  // Probe before anything reads status(), so the UI reports the truth.
  await vault.checkPersistence();
  await maybeExportToken();
  egress.setAllowedEndpoints(config.egressAllowlist());
  egress.install(session.defaultSession);

  broker = new Broker({
    getSettings: () => config.current,
    requestApproval,
  });

  bridge = new BridgeServer({
    port: config.current.bridgePort,
    getToken: () => vault.ensureBridgeToken(),
    getAck: async () => ({
      protocolVersion: 1,
      mode: config.current.permissionMode,
      workspaceRoot: config.current.workspaceRoot,
    }),
    getSecrets: () => vault.envForBridge(),
    onRpcFrame: (frame: PiFrame) => push("karen:rpc-event", frame),
    onAction: async (frame: ActionRequestFrame) => {
      const result = await broker!.handle(frame);
      // A proposal is not an action; park it for the user to decide on.
      if (frame.verb === "planify.propose") {
        reviewQueue.push({ id: randomUUID(), verb: frame.verb, args: frame.args, at: Date.now() });
        pushStatus();
      }
      return result;
    },
    onStatusChange: () => {
      // Re-assert the selection on every (re)connect: a bridge that restarted
      // has no idea what the user chose, and a control that lies is worse than
      // no control.
      // Embeddings settings must reach the VM even with research off, so the
      // pipeline is ready the moment it is switched on.
      if (bridge?.connected && (research.mode !== "off" || config.current.embeddings.baseUrl)) {
        void bridge.ctl("set_research", { config: researchFrame() }).catch(() => undefined);
      }
      pushPolicy();
      pushStatus();
    },
  });

  await bridge.start();

  /*
   * Dictation.
   *
   * The control socket is what makes the hotkey work on Wayland: GNOME runs
   * karen-ctl, which writes one line here. Failing to open it must not stop the
   * app -- everything else still works without a hotkey.
   */
  dictation = new Dictation({
    config,
    secrets: vault,
    onState: (state) => push("karen:dictation", state),
    onText: (text) => push("karen:dictation-text", text),
  });

  meeting = new MeetingRecorder({
    // Read per meeting, not captured once: the Settings field for this would
    // otherwise appear to work and change nothing until the app restarted.
    root: () => config.current.meetingsRoot,
    onTrackLost: (id, reason) => push("karen:meeting", { ...meetingState, error: `${id}: ${reason}` }),
  });

  control = new ControlServer({
    handle: async (command: ControlCommand) => {
      switch (command) {
        case "ping":
          return "karen is running";
        case "dictate-start":
          return dictation!.start();
        case "dictate-stop":
          return dictation!.stop();
        case "dictate-toggle":
          return dictation!.toggle();
      }
    },
  });
  try {
    await control.start();
  } catch (err) {
    control = undefined;
    console.error(`[karen] control socket unavailable, hotkey will not work: ${(err as Error).message}`);
  }

  registerIpc();
  createWindow();
  pushStatus();
}

app.whenReady().then(start).catch((err) => {
  console.error("Karen failed to start:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  void bridge?.stop();
  void control?.stop();
  // A recording left running would keep pw-record alive after the window goes.
  // A meeting is the worse case of the two: two recorders, and a six-hour cap
  // rather than ten minutes, so quitting mid-meeting would leave them writing
  // to disk for the rest of the afternoon.
  void dictation?.cancel();
  if (meeting?.recording) void meeting.discard();
});
