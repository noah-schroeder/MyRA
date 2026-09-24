/**
 * The application.
 *
 * v1's main process was 785 lines, most of which existed because the agent ran
 * on another machine: a WebSocket server, token auth, a supersede protocol, an
 * egress filter that rewrote QEMU's gateway address, a host broker with its own
 * verb allowlist, and a control socket for a GNOME keybinding. All of that is
 * gone. What is left is a window, a settings store, a keyring, and an agent
 * loop running in this same process.
 */

import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, nativeImage, session, shell, systemPreferences } from "electron";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  ConfigStore, configuredEndpoints, DEFAULT_SETTINGS, LEGACY_REASONING,
  type EndpointSettings,
} from "../core/config.ts";
import { DESTINATIONS } from "../core/destinations.ts";
import { isSecretName, SecretVault, type SecretName } from "./secrets.ts";
import { ToolRegistry } from "../core/agent/registry.ts";
import { runTurn, type AgentEvent } from "../core/agent/loop.ts";
import { decide } from "../core/policy.ts";
import { RESEARCH_TOOL_DEFS, setResearchHost, beginResearchTurn,
} from "../core/agent/tools/research.ts";
import {
  DOCUMENT_TOOL_DEFS, resolveInJail, setDocumentWatcher, setDraftHost,
} from "../core/agent/tools/documents.ts";
import { LIBRARY_TOOL_DEFS, setLibraryHost } from "../core/agent/tools/library.ts";
import {
  DIAGRAM_TOOL_DEFS, resetDiagramIds, setDiagramWatcher, type DiagramUpdate,
} from "../core/agent/tools/diagram.ts";
import { maxDrawnId } from "../core/agent/tools/artifactWatch.ts";
import { beginPrismaTurn, PRISMA_TOOL_DEFS, setPrismaHost } from "../core/agent/tools/prisma.ts";
import {
  figureFormFields, figureFromFormAnswers, figureIsBlank, type PrismaFigure,
} from "../core/prisma/spec.ts";
import {
  resetTableIds, setDataHost, setTableWatcher, TABLE_TOOL_DEFS, type DataSource, type TableUpdate,
} from "../core/agent/tools/table.ts";
import {
  CHART_TOOL_DEFS, resetChartIds, setChartWatcher, type ChartUpdate,
} from "../core/agent/tools/chart.ts";
import { parse } from "../core/tabular/parse.ts";
import { rowCount } from "../core/tabular/table.ts";
import { setTaskHost, TASK_TOOL_DEFS } from "../core/agent/tools/tasks.ts";
import { MEMORY_TOOL_DEFS, setMemoryToolHost } from "../core/agent/tools/memory.ts";
import {
  libraryCollections, librarySearch, libraryRoute, libraryStatus,
} from "./runtime/zoteroLibrary.ts";
import { forgetZoteroSnapshot, setZoteroDataDir } from "./runtime/zoteroSqlite.ts";
import { collectionTree } from "../core/library/zotero.ts";
import { resetCitations, resumeCitations } from "../core/research/ledger.ts";
import {
  isExternal, isUsable, newProviderId, orphanedSecrets, parseModelRef, providerFor, providerSecret,
  qualify, standsDownForLocal, urlIsLocal, type Provider,
} from "../core/providers.ts";
import { samplingForRequest } from "../core/llm/sampling.ts";
import { pricesFrom } from "../core/pricing.ts";
import { ASK_FOR_REASONING, describeProbe, probeReasoning } from "../core/llm/reasoningProbe.ts";
import { DEFAULT_PERSONA, systemPrompt } from "../core/agent/systemPrompt.ts";
import {
  dialectById, dialectForHost, effectiveLevel, mergeReasoningFields, reasoningFields,
  type ReasoningDialect,
} from "../core/llm/reasoningDialect.ts";
import {
  cachedLocalDialects, forgetReasoning, hostedCapability, localCapability,
} from "./llm/reasoning.ts";
import { setPdfRenderer, engines, documentsDir, setWorkspaceRoot } from "../core/documents/office.ts";
import { fileName } from "../core/projects/render.ts";
import { setDeviceResolver, type AudioSource } from "../core/meetings/capture.ts";
import type { ChatMessage } from "../core/llm/chat.ts";
import { composeMessageContent, type Attachment } from "../core/llm/attach.ts";
import { hasVision } from "../core/models/roles.ts";
import { estimateTokens } from "../core/agent/compact.ts";
import { REPLY_TOKENS } from "../core/review/manuscript.ts";
import { sniffImage } from "../core/images/generate.ts";
import { extractDocument, extensionOfName } from "./extract.ts";
import { PendingPrompts } from "../core/agent/pending.ts";
import {
  deleteAllAttachments, deleteAttachment, deleteSessionAttachments, readDataText, readImageDataUri,
  saveDataAttachment, saveImageAttachment,
} from "./attachments.ts";

/**
 * What the composer sends alongside the typed words: an image's saved
 * reference, or a document's already-extracted text.
 *
 * Mirrors the discriminated result `myra:chat-attach` returns, minus `ok` --
 * this is exactly what a successful attach produced, held in the renderer
 * until Send and handed back unchanged.
 */
type PendingAttachment =
  | { kind: "image"; id: string; name: string; mime: string }
  | { kind: "document"; name: string; text: string }
  | { kind: "data"; id: string; name: string; rows: number; columns: string[] };
import {
  deleteAllSessions, deleteSession, listSessions, loadSession, saveSession,
  sessionId, titleFrom, type Session,
} from "../core/sessions.ts";
import { installMeetingIpc } from "./meetings.ts";
import { installDictationIpc } from "./dictation.ts";
import { installAudioIpc, resolveAudio } from "./audio.ts";
import { installImageIpc } from "./images.ts";
import { installPaperIpc } from "./papers.ts";
import { installReviewIpc } from "./review.ts";
import { installTaskIpc, taskHost } from "./tasks.ts";
import { startReminders } from "./reminders.ts";
import { createJobs, type Jobs } from "./work.ts";
import { factsFor, setAllowOffload, setIgnoreSuggested, suggestedFor } from "./runtime/modelFacts.ts";
import { defaultStores, installProjectIpc } from "./projects.ts";
import { fileInActiveProject, filedRefs, readAll as readAllProjects } from "./projectStore.ts";
import { ownerOf, type Project } from "../core/projects/project.ts";
import { installMemoryIpc, runProjectSetup, scheduleAutoUpdate, SETUP_GREETING } from "./projectMemory.ts";
import { hasMemory, readMemory, writeMemory } from "./memoryStore.ts";
import { addAuto, type ProjectMemory } from "../core/projects/memory.ts";
import { explainModelFailure } from "./models.ts";
import { installPdfRenderer } from "./pdf.ts";
import { RuntimeManager } from "./runtime/manager.ts";
import { installRuntimeIpc } from "./runtime/ipc.ts";
import { ApiManager } from "./api/manager.ts";
import { installApiIpc } from "./api/ipc.ts";
import { MyraTray, claimSingleInstance, reveal } from "./tray.ts";
import { displayModelName } from "../core/runtime/foreign.ts";
import { runSubagent, setEndpointResolver } from "../core/llm/chat.ts";
import { SUMMARY_SYSTEM, summaryPrompt } from "../core/agent/compact.ts";
import { ResearchRun, deleteRun, listRuns, readRun, readRunSource, runFootprint } from "../core/research/run.ts";
import { figureFromCounts, prismaCounts } from "../core/research/prisma.ts";
import { academicLookup, type LookupOptions } from "../core/research/lookup.ts";
import { setDatabaseKeys } from "../core/research/keys.ts";
import {
  readResearchConfig, readsDocuments, readsLibrary, researchConfigPath, researchRoot, searches,
  serializeResearchConfig,
} from "../core/research/config.ts";
import { access, writeFile } from "node:fs/promises";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE, tightenTree } from "../core/paths.ts";

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Chromium is not quiet by default, and this is where most Electron apps leak.
 *
 * The spellchecker one is the important line: Chromium otherwise fetches
 * dictionaries from Google the first time anyone types in a text field.
 */
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("no-pings");
app.commandLine.appendSwitch("disable-features", "MediaRouter,OptimizationHints");
// Real keyring-backed storage rather than the hardcoded-password fallback.
app.commandLine.appendSwitch("password-store", "gnome-libsecret");

/*
 * Pin the application name before anything asks Electron where to put things.
 *
 * `app.getPath("userData")` derives from it, and the name differs between how
 * the app is launched: electron-vite dev takes package.json's "myra", a
 * packaged build takes electron-builder's productName "MyRA", and running the
 * built main directly gets the default "Electron". Three different data
 * directories for one app, which strands a downloaded model in whichever one
 * happened to be current -- a 30 GB file the app then reports as missing.
 *
 * Setting it explicitly also stops Chromium's caches being written into
 * ~/.config/myra, where MyRA keeps settings, sessions and the encrypted
 * secrets file. Those had been sharing a directory with Cookies and GPUCache.
 */
app.setName("MyRA");

const config = new ConfigStore();
const vault = new SecretVault();
const registry = new ToolRegistry();
const runtime = new RuntimeManager();

/**
 * The gateway that serves MyRA's model to other apps.
 *
 * It is handed accessors rather than the runtime itself: what it needs is
 * "where do I forward to, right now" and "what may I say exists", and both
 * change under it as the daemon restarts and models load. Nothing else about
 * the runtime is its business -- in particular it has no way to reach
 * `installBackend` or `pullModel`, which is the whole point of the design.
 */
const api = new ApiManager({
  upstream: () => runtime.chatEndpoint(),
  models: async () => {
    const loaded = runtime.lemonade.status.health?.modelLoaded;
    /* Only what is downloaded. Offering the whole 228-entry catalogue would
       invite a client to ask for something that is not here, and MyRA does
       not expose model loading through the API. */
    const models = await runtime.api.listModels().catch(() => []);
    return models
      .filter((m) => m.downloaded !== false)
      .map((m) => ({ id: m.id, loaded: m.id === loaded }));
  },
  /* Loading is reached only this way -- through the model a client names in a
     normal request, checked against what is already downloaded. Lemonade's own
     `/load`, `/pull` and `/install` stay unreachable, so an API client can
     switch between models the user already has and can do nothing else. */
  loadModel: (id) => runtime.loadModel(id),
});

let window_: BrowserWindow | undefined;
/**
 * Whether the app is on its way out, as opposed to the window merely closing.
 *
 * With a tray, those stopped being the same event: closing the window hides it
 * and MyRA keeps serving. This flag is what tells the close handler which one
 * is happening, and it is set only by the tray's Quit and by `before-quit`.
 */
let quitting = false;
let tray: MyraTray | undefined;
let session_: Session | undefined;
let inFlight: AbortController | undefined;
/**
 * The conversation object the turn in flight is writing into, kept
 * independently of `session_`.
 *
 * `session_` is what the renderer is currently looking at, and switching
 * conversations mid-turn moves it elsewhere -- `myra:open-session` used to
 * reassign `session_` to a copy freshly read from disk even when the id
 * matched the one still generating, so returning to it handed back a version
 * missing the message that turn was about to save, and the next `saveSession`
 * from that stale copy overwrote the finished reply the turn itself had
 * already written. Keeping the live object reachable by id, independent of
 * where `session_` has wandered off to, is what lets a session reopened
 * mid-turn resume from the real thing instead of a stale read.
 */
let inFlightConversation: Session | undefined;
/**
 * What actually crosses to the renderer over `myra:agent-event`: every event
 * the agent loop itself can emit, plus the two this file adds once the loop
 * has finished -- the loop reports completion by returning or throwing
 * rather than emitting, so `AgentEvent` alone does not name them.
 */
type ChatEvent = AgentEvent | { type: "done"; result: string } | { type: "error"; text: string };
/** Every event this turn has emitted so far, replayed to a session reopened
 *  while its own turn is still running -- see `myra:live-turn`. */
let liveEvents: ChatEvent[] = [];

/**
 * A diagram, table or chart a conversation has drawn, tagged with which one.
 *
 * The push itself (`myra:diagram`/`myra:table`/`myra:chart`) carries the same
 * tag for a panel that is open right now to filter by; this is the same
 * information kept so a panel that mounts *later* -- reopening a conversation
 * that already drew something -- can catch up, the way `liveEvents` already
 * lets a session reopened mid-turn catch up on its chat messages.
 */
type ArtifactRecord =
  | { kind: "diagram"; value: DiagramUpdate }
  | { kind: "table"; value: TableUpdate }
  | { kind: "chart"; value: ChartUpdate };

/** Per conversation, oldest first. Capped so a very long-lived conversation
 *  cannot grow this without bound; a panel only ever needs enough to seed its
 *  tabs, not a full history. */
const sessionArtifacts = new Map<string, ArtifactRecord[]>();
const MAX_BUFFERED_ARTIFACTS = 50;

function bufferArtifact(sessionId: string | undefined, record: ArtifactRecord): void {
  if (!sessionId) return;
  const list = sessionArtifacts.get(sessionId) ?? [];
  list.push(record);
  if (list.length > MAX_BUFFERED_ARTIFACTS) list.shift();
  sessionArtifacts.set(sessionId, list);
}

/**
 * Seed the id counters from whatever this conversation has already drawn, so
 * a figure drawn next continues the sequence instead of relabelling one that
 * was just replayed into the panel.
 *
 * Only safe to call when no turn is in flight anywhere: the counters are one
 * shared sequence, not one per conversation, so reseeding them while a
 * DIFFERENT conversation's turn is still running would pull the sequence out
 * from under it -- its next figure could relabel one it already drew. Every
 * caller checks `!inFlightConversation` first.
 */
function reseedArtifactIds(sessionId: string): void {
  const buffered = sessionArtifacts.get(sessionId) ?? [];
  const idsOf = (kind: ArtifactRecord["kind"]): string[] =>
    buffered.filter((a): a is Extract<ArtifactRecord, { kind: typeof kind }> => a.kind === kind)
      .map((a) => a.value.id);
  resetDiagramIds(maxDrawnId("diagram", idsOf("diagram")));
  resetTableIds(maxDrawnId("table", idsOf("table")));
  resetChartIds(maxDrawnId("chart", idsOf("chart")));
}
/*
 * Which research run is executing right now.
 *
 * The pipeline runs in this process and is entirely indifferent to which page
 * the window is showing, but every sign of it -- the stage card, the progress
 * line -- lived inside the conversation, which is hidden on every other page.
 * So leaving the chat mid-run looked exactly like the run stopping, and the
 * Research runs page, the obvious place to go and check, listed it as
 * "unfinished at screen": the same words it uses for a run that died.
 *
 * Naming the live run is what lets both places say "still going" instead.
 */
let activeRun: { id: string; stage?: string; note?: string } | undefined;

/**
 * Requests the window tried to make and was not allowed to make.
 *
 * Kept so Settings can show them. An empty list is the expected state and the
 * one worth being able to see: it is the difference between "we do not phone
 * home" as a promise and as an observation.
 */
const blocked: { url: string; at: string }[] = [];

function send(channel: string, payload?: unknown): void {
  if (window_ && !window_.isDestroyed()) window_.webContents.send(channel, payload);
}

/** The live run, or null for "nothing is running", on one channel. */
function publishActiveRun(): void {
  send("myra:research-active", activeRun ?? null);
}

/**
 * The same thing, asked for rather than pushed.
 *
 * The push alone is not enough for a page that mounts in the middle of a run: a
 * stage can take minutes, so the Research runs page opened during one sat
 * saying nothing until the next stage began -- indistinguishable from a run that
 * had died. `myra:meeting-state` has answered this question for meetings all
 * along, and `myra:work-state` now answers it for reviews and drafts.
 */
function installActiveRunQuestion(): void {
  ipcMain.handle("myra:research-active-state", () => activeRun ?? null);
}

/* ---------------------------------------------------------------- window -- */

function createWindow(): void {
  window_ = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#101014",
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /*
       * Off, and this is a privacy decision rather than a feature one.
       *
       * Chromium downloads hunspell dictionaries FROM GOOGLE the first time
       * anyone types in a text field -- the leak most Electron apps ship with.
       * v1 planned to neutralise it with setSpellCheckerDictionaryDownloadURL(''),
       * but Electron 43 rejects an empty string as an invalid URL and the call
       * throws, which is how this was found. Disabling the spellchecker removes
       * the fetch entirely rather than trying to redirect it.
       */
      spellcheck: false,
    },
  });

  window_.once("ready-to-show", () => window_?.show());

  /*
   * Closing the window hides it; quitting is done from the tray.
   *
   * Guarded three ways, because an application that hides with no way back is
   * worse than one that quits when you did not mean it to: the setting has to
   * be on, the app must not already be quitting, and a tray icon must actually
   * have been created. On a desktop with no status area the last of those is
   * false and the window closes normally.
   */
  window_.on("close", (event) => {
    if (quitting) return;
    if (!config.current.keepRunningInTray) return;
    if (!tray?.available) return;
    event.preventDefault();
    window_?.hide();
    noteHidden();
  });

  /*
   * System audio, and the reason there was none.
   *
   * The meeting recorder captures two tracks -- the microphone, and the
   * system's output, which is the only way to get the far side of a call. The
   * renderer asks for the second with `getDisplayMedia`, and Chromium will not
   * answer that at all unless the main process handles the request. Without
   * this handler installed the call fails outright, which is why the recorder's
   * "recording your side only" warning was the normal outcome rather than a
   * rare one.
   *
   * Three things were then measured here, on Linux, and each one changed the
   * shape of this handler. The first two are corrections to what the note in
   * DISTRIBUTION.md said; a fourth finding, about gain control, belongs to the
   * renderer and is written up beside the request itself.
   *
   * **Linux does have loopback capture.** Electron documents `audio:
   * "loopback"` for Windows only, but the Chromium underneath carries
   * `media/audio/pulse/pulse_loopback_manager.cc`, which records the default
   * sink's monitor through PulseAudio -- which is also what PipeWire serves.
   * Measured: a track labelled "System audio" carrying the tone that was
   * playing, at the same level a `pw-record` of the monitor captured. No
   * virtual audio device, no portal, no prerequisite of any kind.
   *
   * **The request must not ask for video.** Electron refuses the whole request
   * if video was requested and no video stream is handed back ("Video was
   * requested, but no video stream was provided"), and the screen was not ours
   * to hand back: `desktopCapturer.getSources` never resolves under a Wayland
   * session, so asking for one hung the request for as long as the deadline
   * that used to guard it. Audio alone is answered immediately, and it is what
   * a meeting recorder wants in any case -- MyRA records the room, never the
   * screen. So video is refused here rather than sourced, and the renderer asks
   * for audio only.
   *
   * **No user gesture is needed**, measured: the request is answered even with
   * transient activation expired. So the recorder may await the microphone
   * first without the display request going stale behind it.
   *
   * Windows and macOS are still unverified here -- see DISTRIBUTION.md. What
   * changes for them is that the screen is no longer captured alongside the
   * audio, which on macOS also means Screen Recording is no longer being asked
   * for in order to record sound.
   */
  window_.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Refused rather than sourced; see above. A request for video is not one
      // this app makes, and granting one would be capturing the user's screen.
      if (request.videoRequested) return callback({});
      /*
       * `loopback` rather than `loopbackWithMute`: the user is on a call and
       * needs to keep hearing it. Muting their own speakers to record the other
       * side would be an odd definition of success.
       */
      callback({ audio: "loopback" });
    },
    // The renderer is our own page; there is no third party to ask about here,
    // and macOS still gates the capture behind its own permission.
    { useSystemPicker: false },
  );

  // Links open in the user's browser, never in a window of ours: a page loaded
  // in-app would run with the app's origin and the app's permissions.
  window_.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  /*
   * And the same rule for navigating the window itself, not just opening a new
   * one.
   *
   * `setWindowOpenHandler` covers `target="_blank"` and `window.open`. It does
   * not cover a plain link, a `location.assign`, or a form post, any of which
   * would replace MyRA's own page with the destination -- which then runs
   * inside the window that has MyRA's preload bridge attached to it. The
   * renderer's request filter matches http and https URLs and so stops the
   * fetch, but it does not match `file://`, and a navigation to a local HTML
   * file is exactly the shape a malicious document would take.
   *
   * So: the page MyRA loaded is the only page this window ever shows.
   * Anything else is cancelled, and an http(s) address is handed to the
   * browser instead, which is where a person clicking a citation link expects
   * it to open anyway.
   */
  const rendererOrigin = process.env["ELECTRON_RENDERER_URL"];
  const contents = window_.webContents;
  contents.on("will-navigate", (event, url) => {
    if (url === contents.getURL()) return;
    // electron-vite's full reload after a main-process edit is a real
    // navigation, and blocking it would break the dev loop for no gain.
    if (rendererOrigin && url.startsWith(rendererOrigin)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  /*
   * Whoever was going to answer is gone.
   *
   * A question outstanding when the window reloads -- the dev server's own
   * reload, or a crashed renderer coming back -- left `approve()` awaiting a
   * promise nothing would ever resolve, and the turn hung with no way out but
   * restarting the app. `undefined` denies, which is the right answer for a
   * permission prompt nobody is looking at.
   */
  contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    const dropped = pending.cancelAll();
    if (dropped > 0) {
      console.warn(`the window navigated with ${dropped} question(s) outstanding; they were declined.`);
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window_.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window_.loadFile(join(here, "../renderer/index.html"));
  }
}

/* ---------------------------------------------------------------- agent --- */

/**
 * How a chat turn finds out where to send itself.
 *
 * Assigned once, in main(), because the resolver closes over the runtime
 * manager and the vault. Throwing before that happens is right: a turn that
 * arrives before the app has finished starting has no endpoint to use, and
 * inventing a fallback here would be inventing a second answer to the question
 * this exists to have only one answer to.
 */
type EndpointResolution = {
  endpoint: EndpointSettings;
  apiKey?: string;
  label?: string;
  sampling?: Record<string, number>;
  /** Extra request fields this endpoint needs, e.g. asking for reasoning. */
  extra?: Record<string, unknown>;
  /**
   * The persona this model answers as, when the user has set one for it.
   *
   * Returned rather than applied, and read in exactly ONE place: the chat turn.
   * This resolver also serves the paper drafter, the reviewer, meetings and
   * every research stage, and a user's "be terse, answer in Danish" quietly
   * rewriting a PRISMA checklist is precisely the failure to prevent. Wiring it
   * in anywhere else would be a bug, however helpful it looks.
   */
  persona?: string;
  /**
   * Whether this endpoint is the bundled runtime, and so may be asked to
   * report how far it has read the prompt (`return_progress`).
   *
   * Measured: llama-server b10375 answers with `prompt_progress` frames, and
   * lemond 11.8.0 passes the field through. Never set for anything else -- a
   * hosted API may refuse a whole request over a field it does not know.
   */
  promptProgress?: boolean;
};
let resolveEndpoint: () => Promise<EndpointResolution> = () => {
  throw new Error("The app is still starting up.");
};

/**
 * The lease on long work, shared with the paper drafter and the reviewer.
 *
 * A local const inside `main()` until now, which was fine for everything that
 * only ever ran after `main()` had returned it -- but the automatic memory
 * updater needs to ask "is something else using the model right now" from a
 * timer that outlives any one call, the same reason `resolveEndpoint` above
 * is a reassigned module-level binding rather than a local one.
 */
let jobs: Jobs | undefined;

/**
 * The project and transcript the `remember` tool may write from, for the turn
 * in flight -- or nothing, which is also what keeps the tool off the list.
 *
 * Set only for a conversation in a project that keeps notes and lets them grow
 * on their own; see core/agent/tools/memory.ts for why each condition is there.
 */
let rememberTurn: { projectId: string; sessionId: string; messages: ChatMessage[] } | undefined;

/**
 * Which project this conversation belongs to, if any.
 *
 * The project that already owns it wins; a brand-new conversation may not
 * have one yet -- `handleSend` files it as its first message is sent, without
 * waiting for the write -- so the active project stands in for it, the same
 * fallback `fileInActiveProject` uses to decide where a turn's conversation,
 * image or run will land.
 */
async function projectForSession(sessionId: string): Promise<Project | undefined> {
  const projects = await readAllProjects();
  const owner = ownerOf(projects, { kind: "chat", ref: sessionId });
  if (owner) return owner;
  const active = config.current.activeProject;
  return active ? projects.find((p) => p.id === active) : undefined;
}

function currentSession(): Session {
  if (!session_) {
    const now = new Date().toISOString();
    session_ = {
      id: sessionId(),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      messages: 0,
      messages_: [],
    };
  }
  return session_;
}

/**
 * Whether a tool call may proceed, under the current permission mode.
 *
 * The floor classes cannot be auto-approved in any mode, which is why this asks
 * `decide` rather than comparing the mode itself.
 *
 * What that means in practice, given this tool set: Guarded never prompts,
 * because there is no shell and every write is already jailed. Manual prompts
 * on everything, searches included -- deliberately, since "manual" that quietly
 * exempted a category would not be manual. The boundary is the registry; this
 * is a second opinion for people who want one.
 */
async function approve(tool: string, params: Record<string, unknown>): Promise<boolean> {
  const def = registry.all().find((t) => t.name === tool);
  if (!def) return false;
  if (decide(config.current.permissionMode, def.risk) === "auto") return true;

  const detail = Object.entries(params)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")
    .slice(0, 400);
  const answer = await ask(
    "confirm",
    `Allow ${tool}?`,
    undefined,
    detail || "No parameters.",
  );
  return answer === "yes";
}

/**
 * Every image ever attached anywhere in this conversation, read once and
 * turned into a synchronous lookup `buildRequest` can call.
 *
 * Deliberately simple: a stateless HTTP API means the whole history is resent
 * every turn, so a model asked about an image three messages back still needs
 * it in this request -- there is no server-side memory of having "already
 * seen" it. Re-reading a handful of small local files each turn is cheap
 * enough not to be worth a cache.
 */
async function imageResolver(
  sessionId: string,
  messages: ChatMessage[],
): Promise<(id: string) => string | undefined> {
  const wanted = new Map<string, string>();
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.kind === "image" && a.mime) wanted.set(a.id, a.mime);
    }
  }
  const uris = new Map<string, string>();
  for (const [id, mime] of wanted) {
    const uri = await readImageDataUri(sessionId, id, mime);
    if (uri) uris.set(id, uri);
  }
  return (id) => uris.get(id);
}

async function handleSend(text: string, attachments: PendingAttachment[] = []): Promise<void> {
  const settings = config.current;
  const conversation = currentSession();

  const documents = attachments.filter((a): a is Extract<PendingAttachment, { kind: "document" }> =>
    a.kind === "document",
  );
  const images = attachments.filter((a): a is Extract<PendingAttachment, { kind: "image" }> => a.kind === "image");
  const data = attachments.filter((a): a is Extract<PendingAttachment, { kind: "data" }> => a.kind === "data");
  /* Both a document's text and a data attachment's shape line are inlined as
     ordinary words in the message, and both wrapped as untrusted content --
     somebody else's writing, dropped in for one question, whether it arrived
     as prose or as a pasted table's own column headers. See
     composeMessageContent's own header for why the data side gets the same
     wrapping the document side always has; the numbers themselves still reach
     a tool only through data_id, never through this message's content -- see
     core/agent/tools/table.ts's header for why that split is the whole point. */
  const content = composeMessageContent(text, documents, data);

  conversation.messages_.push({
    role: "user",
    content,
    ...(images.length || data.length
      ? {
          attachments: [
            ...images.map((i): Attachment => ({ id: i.id, kind: "image", name: i.name, mime: i.mime })),
            ...data.map((d): Attachment => ({
              id: d.id, kind: "data", name: d.name, rows: d.rows, columns: d.columns,
            })),
          ],
        }
      : {}),
  });
  /* Whether this is the very first thing said in this conversation, decided
     before the greeting (setup's own, unshifted below) can change the count. */
  const isFirstMessage = conversation.messages_.length === 1;
  if (isFirstMessage) conversation.title = titleFrom(conversation.messages_);
  /*
   * Saved and filed now, as well as when the turn ends.
   *
   * Filing waited for the turn to finish, because a conversation has no file
   * until it is saved -- and a research project's setup turn runs for minutes
   * across several dialogs. For all of that time the rail showed the project
   * twice, once in Projects and once as an empty "Nothing in this project yet"
   * list under its name, beside the very conversation that belonged in it: a
   * blank second folder, as far as anyone looking could tell. With the user's
   * message in it, the conversation is real enough to save and to file.
   */
  conversation.messages = conversation.messages_.length;
  await saveSession(conversation).catch(() => {});
  void fileInActiveProject(config, "chat", conversation.id);

  const project = await projectForSession(conversation.id);
  const memory = project ? await readMemory(project.id) : undefined;
  /* The research project's own setup chat, run once: the first message in a
     conversation filed to a project whose memory is still "pending". Every
     later message in the same project is an ordinary turn, project block and
     all -- see the `else` branch below. */
  const runsSetup = Boolean(project && memory?.setup === "pending" && isFirstMessage);
  /* Identity, not a flag: a turn that was aborted by this one reaches its own
     `finally` after this line runs, and must not clear what this turn set. */
  const turnMemory =
    project && memory && memory.auto && !runsSetup && (await hasMemory(project.id))
      ? { projectId: project.id, sessionId: conversation.id, messages: conversation.messages_ }
      : undefined;
  rememberTurn = turnMemory;

  inFlight?.abort();
  inFlight = new AbortController();
  inFlightConversation = conversation;
  liveEvents = [];
  /* Tagged with the conversation it belongs to, and kept, so a session
     reopened mid-turn (`myra:live-turn`) can replay exactly what a
     subscriber who never left would have seen. Untagged events used to be
     applied to whatever conversation happened to be on screen, which is how
     one conversation's reply could bleed into another's. */
  const emit = (event: ChatEvent): void => {
    /* Progress is not replayed: it says "still working" only while it is, and
       a token counter ticking four times a second would make the replay list
       for a long reply mostly counter. The next one arrives within a second. */
    if (event.type !== "progress") liveEvents.push(event);
    send("myra:agent-event", { ...event, sessionId: conversation.id });
  };
  /* One deep research run per turn. The model is otherwise free to call the
     tool again after reading its own report, and did -- three times on one
     question, each from zero, so the scoping questions and the plan came back
     each time in front of a user who had been told they could walk away. */
  beginResearchTurn();
  // Same rule, same reason, for the PRISMA figure's own dialogs.
  beginPrismaTurn();
  /* Before anything that can take time -- resolving the endpoint may load a
     model, which on a large one is minutes -- so the window has something to
     say from the moment Send is pressed. */
  emit({ type: "progress", progress: { phase: "waiting" } });

  try {
    if (runsSetup) {
      /*
       * Code runs the setup, not the model -- the same discipline
       * documents/draft.ts's own header names. `runTurn` never sees this
       * message at all; the loop it would have run is replaced outright, the
       * way `deep_research`'s own scoping stage replaces an ordinary reply.
       */
      conversation.messages_.unshift({ role: "assistant", content: SETUP_GREETING });
      let narrative = "";
      await runProjectSetup(project!.id, text, {
        say: (delta) => {
          narrative += delta;
          emit({ type: "text", text: delta });
        },
        /* Shown, never kept: `narrative` is what the conversation stores, and
           reasoning stays out of it the way it stays out of every turn. */
        think: (delta) => emit({ type: "text", text: delta, kind: "thinking" }),
        progress: (progress) => emit({ type: "progress", progress }),
      }, inFlight.signal);
      if (narrative.trim()) conversation.messages_.push({ role: "assistant", content: narrative });
      /* The window reads "setup pending" once, when the project is opened, and
         went on believing it -- hiding the notes button and greeting every new
         conversation as a setup chat -- until another project was chosen. */
      send("myra:project-memory-changed", { projectId: project!.id });
      emit({ type: "done", result: JSON.stringify({}) });
    } else {
    /*
     * Resolved by the one resolver, not a second copy of its reasoning.
     *
     * This used to work it out inline -- managed runtime first, configured
     * endpoint otherwise -- alongside an identical passage further down that
     * meetings, research and subagents use. They agreed right up until
     * providers arrived, at which point choosing a hosted model changed where
     * every one of those went and left the actual conversation, the one thing
     * the picker is above, still answering from whatever was resident.
     */
    const { endpoint, apiKey, sampling, extra, persona, promptProgress } = await resolveEndpoint();
    const managed = runtime.chatEndpoint();
    /*
     * How big the window actually is, when that is knowable.
     *
     * Read from llama-server's own `/props` by way of the daemon's health, so
     * it is what the server did rather than what anything intended. For an
     * endpoint someone else runs there is still no honest number, and the
     * meter and compaction both stand down rather than act on a guess -- an
     * invented limit would summarise at the wrong moment and overflow anyway.
     *
     * This stood at `undefined` for both cases on the belief that Lemonade
     * reported no per-conversation window. It does; the figure was simply not
     * being read.
     */
    const limit = managed?.contextTokens;

    const resolveImage = await imageResolver(conversation.id, conversation.messages_);

    const result = await runTurn({
      registry,
      endpoint,
      messages: conversation.messages_,
      resolveImage,
      /* The ONE place a user's persona is applied -- see EndpointResolution.
         The rules that follow it are not the user's to remove: they are what
         keeps a [1] from pointing at nothing. */
      system: systemPrompt({
        ...(persona ? { persona } : {}),
        mode: readResearchConfig().mode,
        spoken: config.current.audio.speechToSpeech,
        /* The ONE place a project's memory is read -- see systemPrompt's own
           note on why nowhere else may. `memory` is read once, above, before
           branching on `runsSetup`, so a project just set up on this very
           turn is still empty here -- correct, since its notes did not exist
           before this message arrived either. */
        ...(project && memory
          ? {
              project: {
                name: project.name, memory,
                ...(limit ? { contextTokens: limit } : {}),
                ...(turnMemory ? { remembers: true } : {}),
              },
            }
          : {}),
      }),
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(sampling ?? {}).length ? { sampling: sampling! } : {}),
      ...(extra ? { extra } : {}),
      signal: inFlight.signal,
      approve,
      onEvent: emit,
      ...(limit ? { contextLimit: limit } : {}),
      ...(promptProgress ? { promptProgress: true } : {}),
      contextUsed: conversation.contextTokens ?? 0,
      ...(conversation.compaction ? { compaction: conversation.compaction } : {}),
      /*
       * Summarised by the same model that is holding the conversation, on
       * purpose: it already has the vocabulary of this particular exchange, and
       * introducing a second model here would mean a second endpoint to
       * configure for a step the user never asked to think about.
       */
      summarise: async (messages) => {
        const { text } = await runSubagent({
          endpoint,
          ...(apiKey ? { apiKey } : {}),
          /* `endpoint.model`, not `settings.llm.model`: for a model MyRA is
             serving, the configured name is empty and the daemon rejects a
             request that does not name one. Compaction would therefore have
             failed the first time it fired -- the same fault the chat turn
             itself had, one call further down. */
          model: endpoint.model ?? "",
          system: SUMMARY_SYSTEM,
          prompt: summaryPrompt(messages),
          signal: inFlight!.signal,
        });
        return text;
      },
    });
    conversation.messages_.push(...result.messages);
    conversation.contextTokens = result.contextTokens;
    if (result.compaction) conversation.compaction = result.compaction;
    emit({
      type: "done",
      result: JSON.stringify({
        ...result.usage,
        contextTokens: result.contextTokens,
        ...(limit ? { contextLimit: limit } : {}),
      }),
    });
    }
  } catch (err) {
    emit({ type: "error", text: (err as Error).message });
  } finally {
    conversation.messages = conversation.messages_.length;
    await saveSession(conversation).catch(() => {});
    /*
     * Filed again here, never when the session id was minted.
     *
     * A conversation with no messages has no file on disk, so a project filing
     * one at creation held a member that the next read -- correctly -- pruned
     * as deleted. The turn's start already filed it once it had a message;
     * repeating is free, since adding a member that is already there changes
     * nothing and writes nothing.
     */
    void fileInActiveProject(config, "chat", conversation.id);
    /* Restarted on every turn in a project, setup included -- a quiet
       stretch of conversation is what the automatic pass waits for, and
       "quiet" only means anything measured from the turn that just
       finished. See projectMemory.ts's own header for why this is not read
       until the conversation has actually gone idle. */
    if (project) scheduleAutoUpdate(project.id, conversation);
    if (rememberTurn === turnMemory) rememberTurn = undefined;
    inFlight = undefined;
    inFlightConversation = undefined;
    liveEvents = [];
    /* Whatever the turn was doing, it is not doing it any more -- including a
       run that threw rather than reaching its last stage. */
    activeRun = undefined;
    publishActiveRun();
  }
}

/* ------------------------------------------------------- pipeline prompts -- */

/**
 * The research pipeline sometimes needs to ask the user something mid-run.
 *
 * It must actually ask. A pipeline that answers its own clarifying questions
 * produces a confident report on the wrong question, which is worse than no
 * report because it looks like work.
 */
const pending = new PendingPrompts();

function ask(
  method: "input" | "editor" | "confirm",
  title: string,
  prefill?: string,
  message?: string,
): Promise<string | undefined> {
  return prompt({ method, title, ...(prefill ? { prefill } : {}), ...(message ? { message } : {}) });
}

/**
 * One request to the window, whatever shape it takes.
 *
 * `ask` was three fixed arguments, which was enough while the pipeline only
 * ever wanted a line of text or a document. A choice carries its options and a
 * model question carries its slots, so the payload is built by the caller and
 * this only owns the id and the promise.
 */
function prompt(request: Record<string, unknown>): Promise<string | undefined> {
  const { id, answer } = pending.open();
  send("myra:prompt", { id, ...request });
  return answer;
}

/* ------------------------------------------------------------------ ipc --- */

/**
 * What each thinking control should show as chosen.
 *
 * The defaults live here rather than in the control, because the control is
 * not the only reader: `reasoningExtra` builds the request from the same rule,
 * and while the two were written separately the composer drew
 * `enable_thinking` as unset on every model whose requests were carrying
 * `true`. One function, both readers, no way for the lit button and the wire
 * to disagree.
 */
function levelsFor(
  dialects: readonly ReasoningDialect[],
  stored: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dialect of dialects) {
    out[dialect.id] = effectiveLevel(
      dialect,
      stored?.[dialect.id] ?? stored?.[LEGACY_REASONING],
    );
  }
  return out;
}

function installIpc(): void {
  ipcMain.handle("myra:send", async (_e, text: string, attachments: unknown) => {
    void handleSend(String(text ?? ""), Array.isArray(attachments) ? (attachments as PendingAttachment[]) : []);
  });
  ipcMain.handle("myra:abort", () => {
    inFlight?.abort();
  });

  /**
   * A dropped file, read and sized before anything is sent.
   *
   * One channel for both kinds, because the renderer does not know which it
   * has until the bytes are sniffed -- see extractDocument, which is tried
   * whenever the bytes do not sniff as one of sniffImage's formats.
   */
  ipcMain.handle("myra:chat-attach", async (_e, name: unknown, bytes: unknown) => {
    const buffer = bytes as ArrayBuffer | Uint8Array | undefined;
    if (!buffer) return { ok: false, error: "Nothing was dropped." };
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const fileName = String(name ?? "file");

    if (sniffImage(view)) {
      try {
        const saved = await saveImageAttachment(currentSession().id, view);
        /* A local model's own labels, when one is loaded. No local model
           loaded means either a hosted endpoint is in use or nothing has
           loaded yet -- both report no labels at all, and `hasVision`'s own
           rule is that no label is a reason to WARN, never a reason to
           silently assume yes: a hosted model's vision support is exactly as
           unknown as a local custom-labelled one's. */
        const loaded = runtime.chatModel();
        const installed = loaded ? await runtime.installedModels().catch(() => []) : [];
        const canSee = hasVision(installed.find((m) => m.id === loaded?.id)?.labels);
        return {
          ok: true,
          kind: "image" as const,
          id: saved.id,
          name: fileName,
          mime: saved.mime,
          bytes: saved.bytes,
          canSee,
          ...(canSee
            ? {}
            : { warning: "This model is not marked as reading images. MyRA will send it anyway." }),
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message || "That image could not be read." };
      }
    }

    /* A table, dropped as a file rather than pasted. Checked by extension,
       ahead of extractDocument, so it never takes the "inlined as untrusted
       prose" path a document does -- kept as a reference instead, for exactly
       the reason an image is: so the model reaches the numbers only through a
       tool call, never by having them typed into its own context. */
    const ext = extensionOfName(fileName);
    if (ext === ".csv" || ext === ".tsv") {
      const text = new TextDecoder().decode(view);
      const parsed = parse(text);
      if (!parsed.ok) {
        return {
          ok: false,
          error:
            `Row ${parsed.row}${parsed.column !== undefined ? `, column ${parsed.column + 1}` : ""}: ` +
            parsed.error,
        };
      }
      try {
        const columns = parsed.table.columns.map((c) => c.name);
        const rows = rowCount(parsed.table);
        /* The same guard the document branch below makes, against the same
           shape-summary line handleSend actually builds and sends -- before
           anything is written to disk, the same order that branch checks
           in. A table with very many or very long column headers can blow a
           small model's context with no upfront error otherwise; unlike a
           document, nothing here would even be over the byte-size cap
           saveDataAttachment enforces, since this line's length tracks
           column count and header length, not row count. */
        const summary =
          `[data 0000000000000000: "${fileName}" -- ${columns.length} columns (${columns.join(", ")}), ` +
          `${rows} rows]`;
        const tokens = estimateTokens([{ role: "user", content: summary }]);
        const limit = runtime.chatEndpoint()?.contextTokens;
        if (limit && tokens + REPLY_TOKENS > limit) {
          return {
            ok: false,
            error:
              `${fileName}'s column list alone is ${tokens.toLocaleString()} tokens and this model ` +
              `holds ${limit.toLocaleString()}. Raise the context window in the model's settings, or ` +
              "paste fewer columns.",
          };
        }
        const saved = await saveDataAttachment(currentSession().id, text);
        return {
          ok: true,
          kind: "data" as const,
          id: saved.id,
          name: fileName,
          rows,
          columns,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message || "That table could not be read." };
      }
    }

    const extracted = await extractDocument(fileName, view);
    if (!extracted.ok || !extracted.text) {
      return { ok: false, error: extracted.error, ...(extracted.needsPandoc ? { needsPandoc: true } : {}) };
    }
    /* The same estimate compaction uses, so "does this fit" answers the
       question the model will actually be asked -- not a rougher one that
       disagrees with it by the time the request is built. */
    const tokens = estimateTokens([{ role: "user", content: extracted.text }]);
    const limit = runtime.chatEndpoint()?.contextTokens;
    if (limit && tokens + REPLY_TOKENS > limit) {
      return {
        ok: false,
        error:
          `${fileName} is ${tokens.toLocaleString()} tokens and this model holds ` +
          `${limit.toLocaleString()}. Raise the context window in the model's settings, or drop a ` +
          "shorter document.",
      };
    }
    return {
      ok: true,
      kind: "document" as const,
      name: fileName,
      words: extracted.words ?? 0,
      tokens,
      text: extracted.text,
    };
  });

  ipcMain.handle("myra:chat-attach-remove", async (_e, id: unknown) => {
    await deleteAttachment(currentSession().id, String(id ?? "")).catch(() => {});
  });

  ipcMain.handle("myra:new-session", async () => {
    if (session_ && session_.messages_.length) {
      await saveSession(session_).catch(() => {});
    } else if (session_) {
      // Never saved -- an attachment dropped in and then abandoned, with no
      // message ever sent to keep it for. Nothing else will ever clean this up.
      await deleteSessionAttachments(session_.id).catch(() => {});
    }
    session_ = undefined;
    // A fresh conversation starts at [1] again. Nothing on screen refers to the
    // old numbers any more, and carrying them over would start every thread at
    // a different, arbitrary place.
    resetCitations();
    // Same reasoning for a figure or a table's own id: "diagram-1" in a new
    // conversation must not silently replace a "diagram-1" tab still open
    // from the one just left. Guarded on nothing being in flight, the same as
    // `open-session` below: the counters are one sequence shared by whichever
    // conversation's turn is running, so resetting them while a DIFFERENT
    // conversation is still generating would pull the sequence out from under
    // it. A brand-new conversation has nothing buffered either way, so this
    // only ever seeds it to zero.
    if (!inFlightConversation) reseedArtifactIds(currentSession().id);
    return currentSession().id;
  });
  ipcMain.handle("myra:list-sessions", () => listSessions());
  ipcMain.handle("myra:open-session", async (_e, id: string) => {
    const wanted = String(id);
    /* A turn for this exact conversation is running right now. The live
       object already holds whatever it has written so far -- a disk read
       would hand back a version missing exactly that, and `session_` a
       second later would be a stale copy the turn's own finished save can no
       longer reach. */
    if (inFlightConversation?.id === wanted) {
      session_ = inFlightConversation;
      resumeCitations(
        session_.messages_.filter((m) => m.role === "tool").map((m) => String(m.content ?? "")),
      );
      // No id reseed here: this conversation's own turn is still running and
      // is the thing actually using the counters right now.
      return session_.messages_;
    }
    if (session_ && session_.messages_.length) await saveSession(session_).catch(() => {});
    const loaded = await loadSession(wanted);
    if (loaded) session_ = loaded;
    /* Above whatever this thread already printed, not from one: the renderer
       rebuilds its source table from the stored tool output, so numbers on
       screen are live again the moment it opens. */
    resumeCitations(
      (loaded?.messages_ ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content ?? "")),
    );
    // Ids restart with the thread here too -- see reseedArtifactIds's own
    // comment for why this is skipped whenever some OTHER conversation's turn
    // is still running: the counters are one sequence, not one per
    // conversation, and reseeding them out from under a live turn could hand
    // its next figure an id it already used.
    if (!inFlightConversation) reseedArtifactIds(wanted);
    return loaded?.messages_ ?? [];
  });
  /* What a session reopened mid-turn needs to catch up: which conversation is
     still generating, and every event it has produced so far, in order. The
     renderer's own live subscription tags future events the same way, so a
     session opened here and one that never left agree on everything from this
     point on. */
  ipcMain.handle("myra:live-turn", () => {
    return inFlightConversation
      ? { sessionId: inFlightConversation.id, events: liveEvents }
      : undefined;
  });
  /* The same catch-up, for a diagram/table/chart already drawn rather than a
     turn still running: a panel that opens after the fact -- reopening a
     conversation that drew a figure earlier -- gets it back instead of an
     empty tab. */
  ipcMain.handle("myra:session-artifacts", (_e, id: string) => {
    return sessionArtifacts.get(String(id)) ?? [];
  });
  ipcMain.handle("myra:rename-session", async (_e, id: unknown, title: unknown) => {
    const wanted = String(id);
    const t = String(title ?? "").trim();
    if (!t) return { ok: false, error: "A conversation needs a title." };
    /* Mutated and saved in place, on whichever object actually holds this
       conversation right now -- the live one if its turn is still running,
       `session_` if it is merely the one on screen, a fresh read otherwise --
       for the same reason `open-session` above does not always reload from
       disk: a stale copy saved back would either race the turn's own save or
       simply not be this conversation's freshest state. */
    const live = inFlightConversation?.id === wanted ? inFlightConversation : undefined;
    const current = session_?.id === wanted ? session_ : undefined;
    const target = live ?? current ?? (await loadSession(wanted));
    if (!target) return { ok: false, error: "That conversation could not be found." };
    target.title = t;
    await saveSession(target).catch(() => {});
    return { ok: true };
  });
  ipcMain.handle("myra:delete-session", async (_e, id: string) => {
    await deleteSession(String(id));
    await deleteSessionAttachments(String(id)).catch(() => {});
    if (session_?.id === id) session_ = undefined;
    sessionArtifacts.delete(String(id));
  });
  ipcMain.handle("myra:delete-all-sessions", async () => {
    /* Every conversation the rail's list actually shows, which is every one
       NOT filed into a project -- see `deleteAllSessions`. Asked here rather
       than passed in from the window: what survives a delete must not depend
       on a list the window drew some time ago. */
    const filed = await filedRefs("chat");
    await deleteAllSessions(filed);
    await deleteAllAttachments(filed).catch(() => {});
    session_ = undefined;
    for (const id of [...sessionArtifacts.keys()]) {
      if (!filed.has(id)) sessionArtifacts.delete(id);
    }
  });

  ipcMain.handle("myra:get-settings", () => config.current);

  /* The Zotero folder the user named, handed to the module that looks for the
     library. Set here rather than read there, so the search path does not
     depend on settings having been loaded first -- and re-set on every change,
     because the whole point of the control is that it takes effect when you
     press the button and not at the next launch. */
  setZoteroDataDir(config.current.zoteroDataDir);

  /* The documents folder, handed to the module that jails against it, on the
     same terms and for the same reason. */
  setWorkspaceRoot(config.current.workspaceRoot);

  /* Same shape again: whether "always send my token" is on decides what the
     NEXT daemon start carries, so the runtime has to know it before settings
     have necessarily finished loading, and again the moment the switch is
     flipped -- not at the next restart, which for a daemon nobody restarts on
     purpose could be days away. */
  runtime.setHfTokenAlways(config.current.hfTokenUse === "always");

  /* Whether this desktop actually shows a tray icon, which decides whether
     "keep running when closed" can do anything at all. Linux answers this
     differently per desktop, so it is reported rather than assumed. */
  ipcMain.handle("myra:tray-available", () => tray?.available ?? false);
  ipcMain.handle("myra:update-settings", async (_e, patch: unknown) => {
    const before = config.current.providers;
    const beforeDir = config.current.zoteroDataDir;
    const next = await config.update(patch as Partial<typeof config.current>);
    /*
     * A removed provider's API key goes with it.
     *
     * Done here rather than in the pane's Remove button, because this is the
     * one place every provider change passes through and a key left behind is
     * not a tidiness problem: it is a credential still on disk that the person
     * believes they deleted, and -- before ids stopped being reused -- it was
     * the key a later provider for a different vendor would have been given.
     */
    for (const name of orphanedSecrets(before, next.providers)) {
      await vault.set(name as SecretName, "").catch(() => undefined);
    }
    setZoteroDataDir(next.zoteroDataDir);
    setWorkspaceRoot(next.workspaceRoot);
    runtime.setHfTokenAlways(next.hfTokenUse === "always");
    /* A different folder is a different library, so the snapshot taken from
       the old one must not answer the next search. */
    if (next.zoteroDataDir !== beforeDir) forgetZoteroSnapshot();
    return next;
  });
  ipcMain.handle("myra:set-secret", (_e, name: string, value: string) => {
    /* Checked rather than cast. The renderer is MyRA's own code, but this
       handler takes a name off the wire and writes it into the vault, and the
       set of things that may be written there should be stated somewhere
       rather than being whatever a caller passes. */
    const requested = String(name);
    if (!isSecretName(requested)) {
      throw new Error("Refusing to store a secret under an unknown name.");
    }
    /* Provider keys go through myra:provider-key, which checks that the
       provider exists. Allowing them here too would leave a second door into
       the vault with the check on only one of them -- and a key written for a
       provider that does not exist belongs to nothing and is cleaned up by
       nothing until the next startup sweep. */
    if (requested.startsWith("provider:")) {
      throw new Error("Use the provider key channel for provider keys.");
    }
    return vault.set(requested, String(value));
  });
  ipcMain.handle("myra:secrets-backend", async () => ({
    ...vault.status(),
    persistent: await vault.checkPersistence(),
    present: await vault.present(),
  }));

  /* No "transcription" any more: it is a model chosen from a list, not an
     endpoint someone types a URL into, so there is nothing here to discover. */
  ipcMain.handle("myra:discover-models", async (_e, which: "llm" | "embeddings") => {
    const endpoint = config.current[which];
    /*
     * The daemon already has these, and asking for an endpoint first was wrong.
     *
     * Embedding models run on llama.cpp like any other local model -- the
     * catalogue lists five, all `recipe: llamacpp`, all labelled `embeddings`
     * -- so a user who has downloaded one has it available with nothing to
     * configure. This returned "No base URL is set for this endpoint" instead,
     * sending somebody to Settings to describe a server they are already
     * running through MyRA.
     *
     * Both sources are offered when both exist, local first, because the
     * question the picker asks is "which model", not "whose server".
     */
    const local = which === "embeddings" ? await localEmbeddingModels() : [];
    if (!endpoint.baseUrl) {
      return local.length
        ? { ok: true, models: local }
        : { ok: false, error: "No base URL is set for this endpoint." };
    }
    const base = endpoint.baseUrl.replace(/\/+$/, "");
    const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const key = await vault.get(which === "llm" ? "llmKey" : "embedKey");
    try {
      const res = await fetch(url, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const served = (body.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, models: [...local, ...served.filter((m) => !local.includes(m))] };
    } catch (err) {
      /* An endpoint that will not answer does not take the local models down
         with it: they are a separate fact and still a usable answer. */
      return local.length
        ? { ok: true, models: local, error: (err as Error).message }
        : { ok: false, error: (err as Error).message };
    }
  });

  /**
   * The embedding models this machine can actually run, downloaded first.
   *
   * The catalogue is read as well as the installed list so that somebody with
   * none yet still sees what they could have; `downloaded` is what tells the
   * two apart and the picker shows the list in that order.
   */
  async function localEmbeddingModels(): Promise<string[]> {
    const wanted = (labels: readonly string[] | undefined): boolean =>
      (labels ?? []).some((l) => l === "embeddings" || l === "embedding");
    const installed = runtime.lemonade.status.state === "ready"
      ? await runtime.installedModels().catch(() => [])
      : [];
    const here = installed.filter((m) => wanted(m.labels) && m.downloaded !== false).map((m) => m.id);
    const catalog = await runtime.catalog().catch(() => []);
    const rest = catalog
      .filter((e) => wanted(e.labels) && !here.includes(e.id))
      .map((e) => e.id);
    return [...here, ...rest];
  }

  /*
   * List what a provider serves, so the user can tick the ones they want.
   *
   * Takes the base URL and key from the ARGUMENTS rather than from stored
   * settings, because this is used while adding a provider that has not been
   * saved yet -- making someone save an endpoint before they can find out
   * whether it answers is how you end up with a list of broken entries.
   *
   * The key is only read from the vault when the caller does not supply one,
   * which is the editing case: a provider already saved should not have to have
   * its key retyped to refresh its model list.
   */
  ipcMain.handle(
    "myra:provider-models",
    async (_e, opts: { baseUrl?: unknown; id?: unknown; apiKey?: unknown }) => {
      const baseUrl = String(opts?.baseUrl ?? "").trim();
      if (!baseUrl) return { ok: false, error: "No base URL is set for this provider." };
      const base = baseUrl.replace(/\/+$/, "");
      const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;

      const supplied = String(opts?.apiKey ?? "");
      const id = String(opts?.id ?? "");
      const key = supplied || (id ? await vault.get(providerSecret(id)) : undefined);

      try {
        const res = await fetch(url, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          return {
            ok: false,
            error:
              res.status === 401 || res.status === 403
                ? `${res.status}: the endpoint refused the key. Check the API key for this provider.`
                : `${res.status} ${res.statusText}`,
          };
        }
        const body = (await res.json()) as { data?: { id?: string }[] };
        const models = (body.data ?? []).map((m) => m.id).filter(Boolean) as string[];
        return {
          ok: true,
          models: [...new Set(models)].sort((a, b) => a.localeCompare(b)),
          /* Whatever the listing said about cost, which for most endpoints is
             nothing. Read here rather than remembered anywhere, so a price can
             only ever be this provider's own current answer. */
          prices: pricesFrom(body.data),
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /*
   * Ask a provider, in one request, whether it sends the model's reasoning.
   *
   * The answer cannot be worked out from the outside -- "the model did not
   * reason", "the provider withholds it", "it needs asking" and "MyRA does not
   * know that field name" all look identical from the chat window. So MyRA
   * asks, twice if the first answer is nothing: once plainly, once with the
   * fields that ask for reasoning. If asking is what worked, the switch is
   * turned on for that provider and stays on.
   *
   * The prompt is a fixed arithmetic question. No part of the user's
   * conversation is sent, and no part of the reply is stored -- the report is
   * field names and character counts.
   */
  /**
   * What the model in front of the user can be told about thinking.
   *
   * Asked by the composer whenever the model changes. Cheap for a hosted
   * provider (a lookup) and cheap enough for a local one (two or three
   * template renders, no inference), and cached per model either way.
   */
  ipcMain.handle("myra:reasoning-capability", async () => {
    try {
      const chosen = config.current.llm.model ?? "";
      const provider = providerFor(config.current.providers, chosen);
      if (provider) {
        const cap = hostedCapability(provider);
        return {
          ok: true,
          ...cap,
          values: levelsFor(cap.dialects, config.current.reasoning[chosen]),
        };
      }
      const loaded = runtime.chatModel();
      if (!loaded) {
        return {
          ok: true,
          dialects: [],
          reason: "unchecked" as const,
          note: "No model is loaded, so there is nothing to ask yet.",
        };
      }
      const cap = await localCapability(loaded);
      /* Keyed by the model that will answer, which is what resolveLlm uses to
         look the choice back up. A key taken from the picker's setting instead
         would miss when the two differ. */
      const key = chosen.trim() || loaded.id;
      return {
        ok: true,
        ...cap,
        values: levelsFor(cap.dialects, config.current.reasoning[key]),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * The persona a given model answers as, and the key it is stored under.
   *
   * Main derives the key, the way `myra:set-reasoning` does and for the same
   * reason: a hosted choice is keyed `provider::model` while a local one is
   * keyed by the model that actually answers, and the window has been wrong
   * about which is which before. Three per-model records now share that key --
   * sampling, reasoning and this -- so a second copy of the rule in the renderer
   * would be a drift with three ways to show up.
   */
  const modelKey = (ref?: string): string => {
    const chosen = (ref ?? config.current.llm.model ?? "").trim();
    if (chosen && providerFor(config.current.providers, chosen)) return chosen;
    return chosen || runtime.chatModel()?.id || "";
  };

  ipcMain.handle("myra:model-prompt", (_e, ref?: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    return {
      ok: true,
      key,
      /* The model's own, if it has one, and otherwise nothing -- NOT the global
         persona. The editor shows that as the placeholder, so "inherits the
         global one" and "has been given the same words" stay different states. */
      text: config.current.systemPrompts[key] ?? "",
      fallback: config.current.persona,
    };
  });

  /**
   * What the model's authors published, for the editor to show as the starting
   * point each field falls back to.
   *
   * Keyed the same way everything per-model is keyed, and derived in the same
   * one place: `modelKey` above.
   */
  ipcMain.handle("myra:model-facts", async (_e, ref?: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    const facts = await factsFor(key);
    /* The renderer already imports fit.ts to draw a fit chip on the models
       list, so this hands it the shape and the file size rather than a
       precomputed budget -- one round trip lets the tuning panel's memory bar
       recompute live as someone edits the context box, instead of an IPC call
       per keystroke. */
    const sizeBytes = await runtime.modelFileBytes(key).catch(() => undefined);
    return {
      ok: true,
      key,
      ...(facts?.repo ? { repo: facts.repo } : {}),
      suggested: facts?.ignoreSuggested ? {} : (facts?.suggested ?? {}),
      /* Reported separately from `suggested` being empty: "the authors set
         nothing" and "you told these to stop applying" are different states and
         the switch has to be able to say which. */
      hasSuggested: Boolean(facts?.suggested && Object.keys(facts.suggested).length),
      ignoreSuggested: Boolean(facts?.ignoreSuggested),
      measured: Boolean(facts?.shape),
      /* The GPU-layers and MoE-CPU sliders' real bound, when it is known --
         absent means the panel falls back to a plain number box, the way
         every other integer flag already does without a measured model. */
      ...(facts?.shape?.layers ? { layers: facts.shape.layers } : {}),
      ...(facts?.shape?.experts ? { experts: facts.shape.experts } : {}),
      ...(facts?.shape ? { shape: facts.shape } : {}),
      ...(sizeBytes ? { sizeBytes } : {}),
      ...(facts?.autoCtxSize !== undefined ? { autoCtxSize: facts.autoCtxSize } : {}),
      ...(facts?.allowOffload ? { allowOffload: true } : {}),
    };
  });

  ipcMain.handle("myra:model-facts-ignore", async (_e, ref: unknown, ignore: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    await setIgnoreSuggested(key, Boolean(ignore));
    return { ok: true };
  });

  /**
   * Deliberately trade GPU residency for a longer context window, or stop.
   *
   * A separate handler rather than folded into `myra:model-options-set`: this
   * is not a daemon field at all, it is MyRA's own record of a choice that
   * changes how MyRA's own auto-tuner sizes the NEXT load -- it takes effect
   * on reload, the same as every other field in this panel.
   */
  ipcMain.handle("myra:model-facts-allow-offload", async (_e, ref: unknown, allow: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    await setAllowOffload(key, Boolean(allow));
    return { ok: true };
  });

  /**
   * What MyRA would size this model's context to right now, without writing
   * it -- the number the tuning panel's "Recompute" offer shows before anyone
   * presses it.
   */
  ipcMain.handle("myra:model-context-preview", async (_e, ref?: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    if (!key) return { ok: false, error: "No model is chosen." };
    try {
      const auto = await runtime.recomputeContext(key, false);
      return { ok: true, auto };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Write what the preview above showed. See `RuntimeManager.recomputeContext`
   * for why this is the one path allowed to overwrite a `ctx_size` MyRA does
   * not already own.
   */
  ipcMain.handle("myra:model-context-apply", async (_e, ref?: unknown) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    if (!key) return { ok: false, error: "No model is chosen." };
    try {
      const auto = await runtime.recomputeContext(key, true);
      return { ok: true, auto };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:set-model-prompt", async (_e, ref: unknown, value?: string | null) => {
    const key = modelKey(typeof ref === "string" ? ref : undefined);
    if (!key) return { ok: false, error: "No model is chosen." };
    const next = { ...config.current.systemPrompts };
    const text = typeof value === "string" ? value.trim() : "";
    if (text) next[key] = text;
    else delete next[key];
    await config.update({ systemPrompts: next });
    return { ok: true, key };
  });

  /**
   * Choose a level for one dialect, or clear it. Against the model, never
   * globally, and never across dialects: a model reading two switches has two
   * independent answers, and writing one of them must not disturb the other.
   */
  ipcMain.handle(
    "myra:set-reasoning",
    async (_e, dialectId: unknown, value?: string | null) => {
      const chosen = config.current.llm.model ?? "";
      const key = chosen.trim() || runtime.chatModel()?.id || "";
      if (!key) return { ok: false, error: "No model is chosen." };
      const dialect = String(dialectId ?? "");
      if (!dialect) return { ok: false, error: "No thinking setting was named." };
      const levels = { ...(config.current.reasoning[key] ?? {}) };
      if (value) levels[dialect] = String(value);
      else delete levels[dialect];
      /* The legacy single-value entry goes as soon as anything explicit is
         written, so it cannot outlive the model it was migrated from and turn
         up later against a dialect that happens to list the same word. */
      delete levels[LEGACY_REASONING];
      await config.update({ reasoning: { ...config.current.reasoning, [key]: levels } });
      return { ok: true };
    },
  );

  /*
   * A newly loaded model has its own template, so the previous answer is about
   * something else.
   *
   * Only when the model actually changes. `onChange` also fires on every
   * health refresh, and clearing the cache on those would make the composer
   * re-render a template every few seconds to be told what it already knew.
   */
  let lastChatModel = runtime.chatModel()?.id;
  runtime.onChange(() => {
    const now = runtime.chatModel()?.id;
    if (now === lastChatModel) return;
    lastChatModel = now;
    forgetReasoning();
  });

  ipcMain.handle(
    "myra:provider-reasoning",
    async (_e, opts: { baseUrl?: unknown; id?: unknown; model?: unknown; apiKey?: unknown }) => {
      const baseUrl = String(opts?.baseUrl ?? "").trim();
      const model = String(opts?.model ?? "").trim();
      if (!baseUrl) return { ok: false, error: "No base URL is set for this provider." };
      if (!model) return { ok: false, error: "Tick a model first; the check has to ask one." };

      const id = String(opts?.id ?? "");
      const supplied = String(opts?.apiKey ?? "");
      const key = supplied || (id ? await vault.get(providerSecret(id)) : undefined);
      const endpoint = { baseUrl, model, envVar: "", timeoutMs: 60_000 };

      const plain = await probeReasoning({ endpoint, ...(key ? { apiKey: key } : {}) });
      const found = (r: typeof plain): boolean => r.read.length > 0 || r.inline || r.unread.length > 0;
      let asked: typeof plain | undefined;
      if (plain.ok && !found(plain)) {
        asked = await probeReasoning({
          endpoint,
          ...(key ? { apiKey: key } : {}),
          extra: ASK_FOR_REASONING,
        });
      }

      /* Remembered only when asking is what made the difference, and only for
         a provider that exists to remember it against. */
      const helps = Boolean(asked?.ok && found(asked) && !found(plain));

      /*
       * The second question, asked in the same trip: will this endpoint take
       * the field that says HOW HARD to think?
       *
       * MyRA knows what each vendor calls it. What it cannot know from the
       * documentation is whether the address in this box will accept it -- a
       * proxy, a gateway or an older deployment may not -- and a strict server
       * refuses the whole request over one unknown field. So it is sent once,
       * here, where a failure costs a line of text rather than somebody's next
       * chat, and the control in the composer stays hidden until it comes back
       * clean.
       *
       * The cheapest level is the one used: this is a real request against a
       * real account, and a probe should not be the most expensive turn of
       * somebody's day.
       */
      const known = dialectForHost(baseUrl);
      let effort: string | undefined;
      if (plain.ok && known) {
        const level = known.levels[0];
        const trial = level
          ? await probeReasoning({
              endpoint,
              ...(key ? { apiKey: key } : {}),
              extra: reasoningFields(known, level.value),
            })
          : undefined;
        if (trial?.ok) effort = known.id;
      }
      if (id && config.current.providers.some((p) => p.id === id)) {
        const patch = {
          ...(helps ? { askReasoning: true } : {}),
          ...(effort ? { reasoningParam: effort } : {}),
        };
        if (Object.keys(patch).length) {
          await config.update({
            providers: config.current.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
          });
        }
      }
      return {
        ok: plain.ok || Boolean(asked?.ok),
        message:
          describeProbe(plain, asked) +
          (known
            ? effort
              ? ` This endpoint also accepts “${known.param}”, so the thinking control is now ` +
                "available in the composer."
              : ` It did not accept “${known.param}”, so there is no thinking control for it.`
            : ""),
        asking: helps,
      };
    },
  );

  /** A provider's API key. Write-only from the renderer, like every other secret. */
  ipcMain.handle("myra:provider-key", async (_e, id: unknown, value: unknown) => {
    const target = String(id ?? "");
    /* Only a provider that exists. Otherwise this writes keys for providers
       nobody can see and nothing will ever clean up. */
    if (!config.current.providers.some((p) => p.id === target)) {
      throw new Error("No such provider.");
    }
    return vault.set(providerSecret(target), String(value ?? ""));
  });

  /**
   * WHETHER a provider has a key, never what it is.
   *
   * The field is write-only, which is right, but with nothing reported back a
   * saved key and no key look identical -- so the honest thing to do about a
   * provider that is refusing requests is retype the key, every time.
   */
  ipcMain.handle("myra:provider-keys-present", async () => {
    const out: Record<string, boolean> = {};
    for (const provider of config.current.providers) {
      out[provider.id] = Boolean(await vault.get(providerSecret(provider.id)));
    }
    return out;
  });

  ipcMain.handle("myra:test-endpoint", async (_e, which: "llm" | "embeddings") => {
    const endpoint = config.current[which];
    if (!endpoint.baseUrl) return { ok: false, error: "No base URL is set." };
    try {
      const res = await fetch(endpoint.baseUrl, { signal: AbortSignal.timeout(8_000) });
      // Any answer at all proves something is listening; the status does not
      // matter, because a bare base URL is not required to be a real route.
      return { ok: true, status: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:choose-directory", async (_e, opts: { title?: string; current?: string }) => {
    const result = await dialog.showOpenDialog(window_!, {
      title: opts?.title ?? "Choose a folder",
      ...(opts?.current ? { defaultPath: opts.current } : {}),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  /*
   * What macOS has actually granted, so a refusal can be explained.
   *
   * On macOS the microphone and screen recording are gated by TCC, and a denial
   * does not raise an error: `getUserMedia` resolves, the track exists, and it
   * carries silence. That is the worst possible failure for a meeting recorder,
   * because it looks exactly like a recording until someone reads the
   * transcript. Asking first turns it into a sentence the user can act on.
   *
   * Every other platform answers "granted" because there is nothing of the kind
   * to check: Linux and Windows gate this at the device, and a refusal there
   * does raise an error.
   *
   * WRITTEN BLIND -- see DISTRIBUTION.md. The API is documented as
   * macOS-and-Windows only, and "not-determined" is the state before the first
   * prompt, which is why it is reported rather than treated as a refusal.
   */
  ipcMain.handle("myra:media-access", () => {
    if (process.platform !== "darwin") return { microphone: "granted", screen: "granted" };
    return {
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
      screen: systemPreferences.getMediaAccessStatus("screen"),
    };
  });

  /**
   * Ask for the microphone, once.
   *
   * Only macOS has anything to ask; elsewhere this is a no-op that answers yes,
   * so the caller does not have to know which platform it is on. A second call
   * after a refusal returns false without prompting -- macOS shows the prompt
   * once and then requires System Settings -- which is why the UI says where to
   * go rather than offering the button again.
   */
  ipcMain.handle("myra:request-microphone", async () => {
    if (process.platform !== "darwin") return true;
    return await systemPreferences.askForMediaAccess("microphone");
  });

  ipcMain.handle("myra:engines", () => engines());

  /*
   * Installing pandoc, on a gesture.
   *
   * Not a tool, not on a timer, and not reachable by the model: the only caller
   * is the setup screen. One install can be in flight at a time, so pressing
   * the button twice does not fetch 34 MB twice.
   */
  let pandocInstall: AbortController | undefined;
  ipcMain.handle("myra:install-pandoc", async () => {
    if (pandocInstall) return { ok: false, error: "An install is already running." };
    pandocInstall = new AbortController();
    try {
      const { installPandoc } = await import("./tools/pandoc.ts");
      const result = await installPandoc({
        signal: pandocInstall.signal,
        onProgress: (p) => send("myra:setup-progress", p),
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      pandocInstall = undefined;
      send("myra:setup-progress", undefined);
    }
  });

  /** The version bundled at build time, for the rail and the About tab. */
  ipcMain.handle("myra:app-version", () => app.getVersion());

  /**
   * Ask GitHub whether a newer MyRA release exists.
   *
   * Its own channel, not folded into `myra:app-version`, for the same reason
   * `myra:engine-updates-check` is separate from `myra:engine-versions`: this
   * one leaves the machine and that one does not. Nothing calls it except the
   * button in Settings → About.
   */
  ipcMain.handle("myra:check-update", async () => {
    const { checkForUpdate } = await import("./appUpdate.ts");
    return checkForUpdate(app.getVersion());
  });

  /*
   * What Settings shows under "what leaves this machine".
   *
   * Rendered from the table rather than written out in the UI, so the claim
   * cannot drift from the code -- test/destinations.test.ts fails if a host
   * appears in a fetch and not in the table.
   */
  ipcMain.handle("myra:privacy", () => ({
    destinations: DESTINATIONS,
    blocked,
    endpoints: configuredEndpoints(config.current),
  }));

  ipcMain.handle("myra:report-devices", (_e, devices: AudioSource[]) => {
    setDeviceResolver(async () => devices);
  });

  ipcMain.handle("myra:answer-prompt", (_e, id: string, answer: string | undefined) => {
    pending.answer(String(id), answer === undefined ? undefined : String(answer));
  });

  /* The run directory is the audit trail, and until now it was reachable from
   * nowhere in the app: every run wrote its search log, screening reasons,
   * source hashes and verification table to disk and no screen ever showed
   * them. These three handlers are read-only by construction -- there is no
   * verb here that can change a completed run. */
  /*
   * Academic search, run by the user rather than by the model.
   *
   * No LLM is involved: this calls OpenAlex and arXiv and hands back what they
   * said. Wanting to look something up is not the same as wanting to talk to a
   * language model about it.
   */
  ipcMain.handle("myra:academic-search", (_e, query: string, opts: LookupOptions) =>
    academicLookup(String(query ?? ""), {
      page: Number(opts?.page) || 1,
      sort: opts?.sort === "citations" || opts?.sort === "newest" ? opts.sort : "relevance",
    }),
  );

  /**
   * Open a link in the user's own browser.
   *
   * The user's browser, never a window of ours: rendering an arbitrary page
   * inside the app would put untrusted web content in the same process tree as
   * the vault and undo the CSP and sandbox the rest of the app is built on.
   *
   * Restricted to http(s) because shell.openExternal will happily hand a
   * `file://` to the desktop, and on some platforms other schemes launch
   * applications. This is reachable only from a click in the results list --
   * no tool exposes it, so the model cannot ask for it.
   */
  ipcMain.handle("myra:open-external", async (_e, url: string) => {
    const raw = String(url ?? "");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, error: "not a URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `${parsed.protocol.replace(":", "")} links are not opened` };
    }
    await shell.openExternal(parsed.href);
    return { ok: true };
  });

  ipcMain.handle("myra:research-runs", () => listRuns());
  ipcMain.handle("myra:research-run", (_e, id: string) => readRun(String(id)));
  ipcMain.handle("myra:research-source", (_e, id: string, n: number) =>
    readRunSource(String(id), Number(n)),
  );
  /** Reveal a run's directory, so the raw files are one click away. */
  /**
   * Draw this run's own PRISMA flow diagram.
   *
   * Every number in it is already on disk -- each stage writes its output there
   * and that file is the stage's done-marker -- so this reads them rather than
   * asking a model to produce a diagram whose counts it would be inventing.
   *
   * Announced down the same channel `create_diagram` uses, so a figure drawn
   * from a run and one drawn in conversation are the same artifact with the
   * same export buttons.
   */
  ipcMain.handle("myra:research-prisma", async (_e, id: unknown) => {
    try {
      const runId = String(id ?? "");
      const run = await ResearchRun.open(runId, researchRoot());
      // Six reads, none depending on another's result -- only the early-return
      // check below depends on two of their lengths, which is a post-processing
      // step, not a reason to serialise the reads themselves.
      const [candidates, snowballRaw, screenedA, screenedB, sourcesRaw, question] = await Promise.all([
        run.readJsonl<{ dedupeKey?: string }>("candidates.jsonl"),
        run.readJsonl<{ dedupeKey?: string }>("snowball.jsonl"),
        run.readJsonl<{ include?: boolean; keep?: boolean }>("screened.jsonl"),
        run.readJsonl<{ include?: boolean; keep?: boolean }>("screened-snowball.jsonl"),
        run.sources(),
        run.readJson<{ question?: string }>("question.json"),
      ]);
      const screened = [...screenedA, ...screenedB].map((d) => ({ include: d.include === true || d.keep === true }));
      if (!candidates.length && !snowballRaw.length) {
        return { ok: false, error: "This run has no search results to draw a flow diagram from." };
      }
      /* undefined, not an empty array, for a stage that never ran -- readJsonl
         cannot tell "missing file" from "empty file" apart, but the stage's own
         output file existing can. See prismaCounts's own header for why this
         distinction is the whole point. */
      const snowball = run.isDone("snowball") ? snowballRaw : undefined;
      const sources = run.isDone("retrieve") ? sourcesRaw : undefined;
      /* A record with no dedupe key stands for itself rather than collapsing
         with every other keyless one -- the same guard `counts()` makes. Always
         computed from the raw arrays: de-duplication counts what was found,
         whether or not the snowball stage counts as "run" for the figure. */
      const distinct = new Set(
        [...candidates, ...snowballRaw].map((c, i) => c.dedupeKey ?? `__${i}`),
      ).size;
      const counts = prismaCounts({ candidates, snowball, screened, sources, distinct });
      const title = question?.question ? `PRISMA — ${question.question.slice(0, 60)}` : "PRISMA flow diagram";
      send("myra:diagram", { id: `prisma-${runId}`, title, prisma: figureFromCounts(counts, title) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:research-reveal", async (_e, id: string) => {
    const run = await ResearchRun.open(String(id));
    await shell.openPath(run.dir);
  });

  /**
   * What deleting a run would cost, asked before the confirmation is shown.
   *
   * A run holds the stored copy of every paper it read, so "delete" is not the
   * small act it looks like next to deleting a chat. The number of files and
   * the size on disk are the two facts that make that concrete.
   */
  ipcMain.handle("myra:research-footprint", async (_e, id: string) => {
    try {
      return { ok: true, footprint: await runFootprint(String(id)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("myra:research-delete", async (_e, id: string) => {
    try {
      const gone = await deleteRun(String(id));
      return { ok: true, deleted: gone, runs: await listRuns() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /*
   * Open the folder a written document is in.
   *
   * Through resolveInJail rather than on the path as given: this arrives from
   * the renderer, and the renderer got it from an event, but a path that opens
   * a file manager somewhere is worth checking against the same jail the
   * writing side enforces rather than trusting the round trip.
   */
  ipcMain.handle("myra:document-reveal", async (_e, path: unknown) => {
    const abs = await resolveInJail(documentsDir(), String(path ?? ""));
    await shell.openPath(dirname(abs));
  });

  /*
   * The user's Zotero collections, for the picker beside the Library button.
   *
   * Answers with the failure TEXT rather than throwing, because the two ways
   * this fails -- Zotero closed, or its local API switched off -- are things
   * the user fixes in Zotero, and a picker that was merely empty would be
   * indistinguishable from a library with no collections in it.
   */
  ipcMain.handle("myra:zotero-collections", async () => {
    try {
      const collections = collectionTree(await libraryCollections());
      /* Which way in answered, so the picker can say when it is reading the
         file rather than talking to Zotero. Those two do not search the same
         thing, and only one of them reaches the text inside PDFs. */
      return { ok: true, collections, via: libraryRoute() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /*
   * Both ways into the library, probed on demand.
   *
   * For the panel in Settings → Library. It exists because the failure a user
   * actually reports is "it says it cannot reach Zotero", which is one message
   * covering two unrelated problems -- a switch inside Zotero, and a library
   * folder somewhere MyRA did not look. This says which, names every place it
   * looked, and reports what Zotero's own profile said about where the library
   * is, so the answer does not depend on anyone reading source.
   */
  ipcMain.handle("myra:zotero-status", async () => {
    try {
      return { ok: true, ...(await libraryStatus()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /*
   * Copy, through the main process rather than navigator.clipboard.
   *
   * The Clipboard API is available in the renderer -- Electron treats the
   * file:// document as a secure context -- but it is conditional on focus and
   * a permission, and signals failure by rejecting a promise. This one is
   * unconditional. A copy button that fails is worse than none, because the
   * user walks away believing they have the text.
   */
  ipcMain.handle("myra:copy", (_e, text: unknown) => {
    clipboard.writeText(String(text ?? ""));
  });

  /**
   * Save a figure -- from create_diagram, create_table or create_chart --
   * into the documents folder, one helper for all three.
   *
   * Written here rather than in the window for the reason nothing else in
   * this app writes from the window either: a blob download would depend on
   * the request filter not matching `blob:`, which is a thing that happens
   * to be true rather than a thing that is guaranteed. The renderer hands
   * over bytes and main decides where they land -- inside the documents
   * jail, beside the documents a draft would have written.
   *
   * `fileName` rather than `slugName`: this is a document a person goes
   * looking for later in an ordinary file manager, the same reasoning
   * `fileName`'s own doc comment gives, not an id that only ever has to be
   * unique.
   *
   * A PNG arrives base64 because only the window has a canvas to rasterise
   * with; SVG and PGFPlots/LaTeX source arrive as the text they already are.
   */
  async function saveFigure(
    name: unknown, ext: "svg" | "png" | "tex", data: unknown, fallback: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const safe = fileName(String(name ?? fallback), fallback);
    try {
      const dir = documentsDir();
      await makeOwnDir(dir);
      /* Through the jail like every other path, although this one is built
         here: `resolveInJail` is what the rule says, not what the caller
         happens to have constructed. */
      const abs = await resolveInJail(dir, `${safe}.${ext}`);
      const body = String(data ?? "");
      await writeFile(
        abs,
        ext === "png" ? Buffer.from(body.replace(/^data:image\/png;base64,/, ""), "base64") : body,
        { mode: 0o600 },
      );
      return { ok: true, path: abs };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  ipcMain.handle(
    "myra:diagram-save",
    async (_e, name: unknown, format: unknown, data: unknown) => {
      const kind = String(format ?? "svg") === "png" ? "png" : "svg";
      return saveFigure(name, kind, data, "diagram");
    },
  );

  /**
   * The figure itself on the clipboard, so it pastes into Word or a slide.
   *
   * `writeText` with the SVG source would paste the markup as a wall of text.
   * An image on the clipboard is what "copy this figure" means everywhere else.
   */
  ipcMain.handle("myra:diagram-copy-image", (_e, dataUrl: unknown) => {
    const image = nativeImage.createFromDataURL(String(dataUrl ?? ""));
    if (image.isEmpty()) return { ok: false, error: "The figure could not be rasterised." };
    clipboard.writeImage(image);
    return { ok: true };
  });

  /**
   * Reopen a drawn PRISMA figure's form and redraw it in place.
   *
   * The variant is already decided -- it is the figure on screen -- so this
   * skips straight to the form, prefilled from what is already there and
   * carrying no "guessed" marker: these are the user's own confirmed numbers,
   * not a model's reading of the conversation. Answering resends on the SAME
   * id, which is what makes `arrive()` in useArtifacts replace the panel
   * entry in place rather than opening a second tab for one figure.
   */
  ipcMain.handle(
    "myra:prisma-edit",
    async (_e, id: unknown, title: unknown, figure: unknown) => {
      /* App.tsx holds exactly one prompt on screen. Firing a second one here
         while, say, a research run's own scoping question is up would
         silently displace it -- orphaning that promise until the next
         navigation resolves it via cancelAll(). */
      if (pending.size > 0) {
        return { ok: false, error: "MyRA is already asking about something else." };
      }
      const fig = figure as PrismaFigure;
      const fields = figureFormFields(fig.variant, { counts: fig.counts ?? {}, items: fig.items ?? {} }, false);
      const answer = await prompt({
        method: "form",
        title: "Edit the figure's numbers",
        message: "A blank field draws no box for it; type 0 to show zero.",
        fields,
      });
      if (answer === undefined) return { ok: false, error: "Cancelled." };
      let answers: Record<string, string>;
      try {
        const parsed = JSON.parse(answer) as unknown;
        answers = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
      } catch {
        return { ok: false, error: "Cancelled." };
      }
      const next = figureFromFormAnswers(fig.variant, String(title ?? fig.title ?? "PRISMA flow diagram"), answers);
      if (figureIsBlank(next)) return { ok: false, error: "Every field was left blank." };
      send("myra:diagram", { id: String(id ?? ""), title: next.title, prisma: next });
      return { ok: true };
    },
  );

  /**
   * Save a table's LaTeX into the documents folder -- always `.tex`, since
   * that is the one format this button produces text for. Word goes through
   * the clipboard instead (below), never through this path.
   */
  ipcMain.handle("myra:table-save", async (_e, name: unknown, data: unknown) => {
    return saveFigure(name, "tex", data, "table");
  });

  /**
   * A table on the clipboard as a real, editable table -- the `text/html`
   * flavour is what Word, Google Docs and Sheets each paste as an actual
   * table rather than as a wall of pipes and dashes. `text/plain` rides
   * alongside as TSV, for whatever the receiving cell does not accept HTML
   * into. Both flavours have to be written in the same call: `clipboard.write`
   * replaces the whole clipboard, so writing them separately would leave only
   * the second one behind.
   */
  ipcMain.handle("myra:table-copy-word", (_e, html: unknown, text: unknown) => {
    clipboard.write({ html: String(html ?? ""), text: String(text ?? "") });
    return { ok: true };
  });

  /**
   * Save a figure the conversation charted -- SVG, PNG or PGFPlots source,
   * chosen by the caller's own extension. The same helper as
   * `myra:diagram-save`, and deliberately so: a figure is a figure whether
   * it came from Mermaid or from a pasted table.
   */
  ipcMain.handle("myra:chart-save", async (_e, name: unknown, format: unknown, data: unknown) => {
    const ext = String(format ?? "svg") === "png" ? "png" : String(format ?? "svg") === "tex" ? "tex" : "svg";
    return saveFigure(name, ext, data, "chart");
  });

  /** The figure itself on the clipboard -- same reasoning as `myra:diagram-copy-image`. */
  ipcMain.handle("myra:chart-copy-image", (_e, dataUrl: unknown) => {
    const image = nativeImage.createFromDataURL(String(dataUrl ?? ""));
    if (image.isEmpty()) return { ok: false, error: "The figure could not be rasterised." };
    clipboard.writeImage(image);
    return { ok: true };
  });

  ipcMain.handle("myra:get-research", () => readResearchConfig());
  ipcMain.handle("myra:set-research", async (_e, next: unknown) => {
    await makeOwnDir(dirname(researchConfigPath()));
    // Built by the same module that reads it back, so a field cannot survive
    // one side and be dropped by the other -- which is what the two hand-kept
    // copies of this object were one edit away from at all times.
    await writeFile(
      researchConfigPath(),
      JSON.stringify(serializeResearchConfig(next), null, 2) + "\n",
      { mode: OWNER_ONLY_FILE },
    );
  });
}

/**
 * One-time sweep over content an older MyRA already wrote.
 *
 * Narrowing the roots protects everything written from now on, and nothing
 * that is already there. The runs, meetings and drafts on disk were created
 * before any of this existed -- a finished research run holds the question
 * asked, the papers fetched and the report written, at 0775/0644, and nothing
 * will ever rewrite it. Only a deliberate pass reaches those.
 *
 * Run once and recorded, because it is a walk of the user's document tree and
 * doing it on every launch would be a real cost for no further benefit: after
 * the first pass everything loose has already been narrowed, and everything
 * written since was private from birth.
 *
 * Only MyRA's own default locations. A root the user pointed somewhere of
 * their own is theirs -- see makePrivateDir -- and the Obsidian vault
 * especially so.
 */
async function tightenExistingContent(): Promise<void> {
  const stamp = join(CONFIG_DIR, "permissions-tightened");
  try {
    await access(stamp);
    return;
  } catch {
    /* Not done yet. */
  }

  const roots: string[] = [];
  for (const [current, fallback] of [
    [config.current.workspaceRoot, DEFAULT_SETTINGS.workspaceRoot],
    [config.current.meetingsRoot, DEFAULT_SETTINGS.meetingsRoot],
  ] as const) {
    if (current === fallback) roots.push(current);
  }
  if (!process.env["MYRA_RESEARCH_ROOT"]) roots.push(researchRoot());
  roots.push(CONFIG_DIR);

  for (const root of roots) await tightenTree(root).catch(() => 0);

  /* Written even if a sweep partly failed. A tree MyRA cannot chmod is one it
     will not manage to chmod on the next launch either, and retrying the whole
     walk forever is worse than leaving it. */
  await writeFile(stamp, new Date().toISOString() + "\n", { mode: OWNER_ONLY_FILE }).catch(
    () => undefined,
  );
}

/* ----------------------------------------------------------------- boot --- */

/**
 * Turn a pre-`audio` transcription endpoint into an ordinary provider.
 *
 * Transcription used to be configured as a base URL, a key and a model name on
 * its own screen. It is now a model chosen from a list, and the list is drawn
 * from the local runtime and from the user's providers -- which is what that
 * endpoint always was, described in the app's own vocabulary. Rather than
 * dropping the setting and quietly unconfiguring anyone pointing MyRA at their
 * own whisper server, it is carried across: a provider is created, the key
 * moves with it, and the choice points at it.
 *
 * Runs once, and its own effect is what stops it running twice: the field is
 * read back from the `transcription` key in settings.json, and the save at the
 * end writes a file that no longer has one. An install that never configured an
 * endpoint has nothing here to begin with and returns immediately.
 */
async function migrateTranscriptionEndpoint(): Promise<void> {
  const legacy = config.current.legacyTranscription;
  if (!legacy?.baseUrl.trim()) return;

  const id = newProviderId(config.current.providers);
  const model = legacy.model?.trim() || "whisper-1";
  const provider: Provider = {
    id,
    label: "Transcription (imported)",
    /*
     * External unless the address proves otherwise, and `effectiveKind` has the
     * final say on that anyway.
     *
     * The safe direction: a wrongly external label costs a warning nobody
     * needed, a wrongly local one tells someone their recordings stayed on this
     * machine while they were being posted elsewhere.
     */
    kind: urlIsLocal(legacy.baseUrl) ? "local" : "external",
    baseUrl: legacy.baseUrl,
    models: [model],
    enabled: true,
  };

  /* The key moves before the provider is saved, so a crash in between leaves a
     provider with no key rather than a key belonging to nothing. */
  const key = await vault.get("transcriptionKey").catch(() => undefined);
  let moved = false;
  if (key) {
    moved = await vault.set(providerSecret(id), key)
      .then(() => true)
      .catch(() => false);
  }

  await config.update({
    providers: [...config.current.providers, provider],
    audio: { ...config.current.audio, transcriptionModel: qualify(id, model) },
    legacyTranscription: undefined,
  });

  /*
   * And the original goes, now that the copy is somewhere it can be reached.
   *
   * Last, and only on a copy that actually landed: a credential left behind
   * under a name nothing reads any more is the same fault this app already
   * fixed once for providers -- see `orphanedSecrets` above, which deletes a
   * key when the provider it belonged to is removed. A key with no owner is not
   * inert, it is simply a key nobody is accounting for.
   */
  if (moved) await vault.set("transcriptionKey", "").catch(() => undefined);

  console.info(`Transcription endpoint ${legacy.baseUrl} migrated to a provider.`);
}

async function main(): Promise<void> {
  /*
   * Close the two directories that are unambiguously ours, before anything
   * writes into them.
   *
   * Both were created with the umask and came out 0775 on a stock Ubuntu --
   * measured, not assumed. The individual files inside were already 0600, so
   * nothing secret was ever exposed, but everything MyRA wrote WITHOUT an
   * explicit mode was 0644 and readable by any other account on the machine.
   * Every writer now passes a mode; this narrows the directories an existing
   * install already has, which no amount of care in new code would reach.
   *
   * `userData` is Electron's, holding models, runtimes and Chromium's own
   * state; CONFIG_DIR is ours, holding settings, sessions and the keyring
   * probe. Directories the USER chose are deliberately not touched here -- see
   * makePrivateDir.
   */
  await makeOwnDir(app.getPath("userData")).catch(() => undefined);
  await makeOwnDir(CONFIG_DIR).catch(() => undefined);

  await config.load();
  await migrateTranscriptionEndpoint();

  /*
   * The content roots too -- but only the ones MyRA chose for itself.
   *
   * A per-meeting folder is created private now, which protects the transcript
   * inside it. The folder ABOVE it is a different matter: an install that
   * predates this has it at 0775, and its entries are named after the meetings
   * ("2026-08-27T09-46-56-quarterly-review"), so the titles of every meeting
   * ever recorded stay readable even when the recordings are not.
   *
   * The test is whether the path is still the default. Where it is, MyRA put
   * it there and may tighten it. Where the user has pointed it somewhere of
   * their own -- and always for the Obsidian vault, which is theirs and full of
   * things that have nothing to do with this app -- it is left alone, because
   * silently changing the permissions of a directory somebody chose is not a
   * privacy improvement, it is a surprise.
   */
  for (const [current, fallback] of [
    [config.current.workspaceRoot, DEFAULT_SETTINGS.workspaceRoot],
    [config.current.meetingsRoot, DEFAULT_SETTINGS.meetingsRoot],
  ] as const) {
    if (current === fallback) await makeOwnDir(current).catch(() => undefined);
  }
  if (!process.env["MYRA_RESEARCH_ROOT"]) {
    await makeOwnDir(researchRoot()).catch(() => undefined);
  }

  /*
   * Provider keys with no provider.
   *
   * Removing a provider takes its key with it, but that only protects removals
   * from now on: a key deleted before that existed is still encrypted on disk,
   * belonging to nothing, invisible to an interface that deliberately never
   * lists secrets. Swept at startup, where it costs one read.
   */
  {
    const live = new Set<string>(config.current.providers.map((p) => providerSecret(p.id)));
    for (const name of await vault.names().catch(() => [])) {
      // Checked, not asserted -- the same rule the set-secret handler follows.
      if (name.startsWith("provider:") && !live.has(name) && isSecretName(name)) {
        await vault.set(name, "").catch(() => undefined);
      }
    }
  }

  await tightenExistingContent();

  for (const def of [
    ...RESEARCH_TOOL_DEFS, ...DOCUMENT_TOOL_DEFS, ...LIBRARY_TOOL_DEFS, ...TASK_TOOL_DEFS,
    ...DIAGRAM_TOOL_DEFS, ...TABLE_TOOL_DEFS, ...PRISMA_TOOL_DEFS, ...CHART_TOOL_DEFS, ...MEMORY_TOOL_DEFS,
  ]) {
    registry.register(def);
  }

  /* Loopback, no key, nothing cached. The client is in the main process for the
     same reason every other one is: the renderer never makes a request. */
  setLibraryHost({
    search: (opts) => librarySearch(opts),
    collections: () => libraryCollections(),
    route: () => libraryRoute(),
  });

  /* A flat directory of JSON in MyRA's own folder -- see tools/tasks.ts's
     header for why that makes the write tools `write` rather than
     `system_of_record`. */
  setTaskHost(taskHost({ config, send }));
  /* `remember` reads the turn's own project and transcript, set by handleSend
     for the length of one turn. Saving goes through addAuto, so it only ever
     appends, and tells the project page the way the idle pass does. */
  setMemoryToolHost({
    current: () => rememberTurn,
    save: async (projectId, sessionId, items) => {
      const before = await readMemory(projectId);
      const after = addAuto(before, items, sessionId);
      if (after === before) return 0;
      await writeMemory(projectId, after);
      send("myra:project-memory-changed", { projectId });
      return after.items.length - before.items.length;
    },
  });

  setResearchHost({
    fallbackModel: config.current.llm.model ?? "",
    ui: {
      /* A question with answers to pick from. The renderer adds "Other" and a
         skip to every one of them; nothing here decides that. */
      choose: (choice) =>
        prompt({
          method: "choice",
          title: choice.title,
          ...(choice.message ? { message: choice.message } : {}),
          options: choice.options,
          ...(choice.multi ? { multi: true } : {}),
          ...(choice.required ? { required: true } : {}),
        }),
      /* One dropdown per role. The renderer fetches the model catalogue
         itself -- it already has both halves, and shipping a list of every
         local and hosted model through a dialog payload would be a copy that
         goes stale the moment somebody ticks a box in Settings. */
      models: async (slots, current) => {
        /* The embedder is always in the list and never a stage anyone assigns
           a job to, so it cannot decide which title this is. */
        const perStage = slots.filter((s) => s.key !== "embedder").length > 1;
        const answer = await prompt({
          method: "models",
          title: perStage ? "Which model does which job?" : "Which models?",
          slots,
          current,
        });
        if (answer === undefined) return undefined;
        try {
          const parsed = JSON.parse(answer) as Record<string, string>;
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          /* The dialog sends JSON; anything else means it was dismissed in a
             way that produced text. Treat it as "change nothing" rather than
             as an assignment nobody made. */
          return {};
        }
      },
      input: (title, placeholder) => ask("input", title, placeholder),
      editor: (title, prefill) => ask("editor", title, prefill),
      notify: (message) => send("myra:research-progress", message),
    },
    onProgress: (note) => {
      send("myra:research-progress", note);
      if (activeRun) {
        activeRun.note = note;
        publishActiveRun();
      }
    },
    onStage: (stage) => {
      send("myra:research-stage", stage);
      /* The pipeline sends an empty stage when it is finished, which is the
         one signal that the run is over while the turn carries on writing. */
      if (!stage) activeRun = undefined;
      else if (activeRun) activeRun.stage = stage;
      publishActiveRun();
    },
    onRunCreated: (id) => {
      activeRun = { id };
      publishActiveRun();
      void fileInActiveProject(config, "run", id);
    },
  });

  /*
   * Drafting shares the research pipeline's dialog and its progress channel.
   *
   * Deliberately the same two: from where the user sits, "MyRA is working on
   * something long and will ask me to approve a plan" is one experience, and
   * giving it a second dialog style and a second status line would make it look
   * like two features that happen to resemble each other.
   *
   * The model is a function, not a captured string. `fallbackModel` above is
   * read once at startup, which is already wrong when the user loads a
   * different model -- a bug worth not copying into new code.
   */
  /*
   * The PRISMA figure's own two questions, then the form -- the research
   * pipeline's own dialogs again, for the reason setDraftHost below shares
   * them too: "MyRA is asking me something and will produce work once I
   * answer" is one experience across every feature that does this.
   */
  setPrismaHost({
    ui: {
      choose: (choice) =>
        prompt({
          method: "choice",
          title: choice.title,
          ...(choice.message ? { message: choice.message } : {}),
          options: choice.options,
          ...(choice.required ? { required: true } : {}),
        }),
      form: async (title, message, fields) => {
        const answer = await prompt({ method: "form", title, ...(message ? { message } : {}), fields });
        if (answer === undefined) return undefined;
        try {
          const parsed = JSON.parse(answer) as unknown;
          return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
        } catch {
          // The dialog sends JSON; anything else means it was dismissed in a
          // way that produced text. Treat it as "nothing filled in".
          return {};
        }
      },
    },
  });

  setDraftHost({
    /* The model that will answer, not the last one loaded: `activeModel` can
       name a model that was loaded for another job entirely, and this string
       is written into a document as its provenance. */
    model: () => basename(runtime.chatModel()?.id ?? "") || config.current.llm.model || "",
    ui: { editor: (title, prefill) => ask("editor", title, prefill) },
    onProgress: (note) => send("myra:research-progress", note),
  });

  /* Every document the model writes, as it is written. The draft flow saves
     after each section, so this fires repeatedly for one file with `final`
     false until the last one. */
  setDocumentWatcher((doc) => send("myra:document", doc));
  /* The same push the artifact panel already listens for documents on:
     a diagram is work the conversation produced, and belongs beside it.
     Tagged with the conversation whose turn is actually running -- not
     whatever the renderer happens to be looking at right now, which
     `emit`'s own tag a few lines above already gets right for chat events --
     and buffered so a panel that opens after the fact (reopening this
     conversation later) can still show it. */
  setDiagramWatcher((diagram) => {
    const sid = inFlightConversation?.id;
    bufferArtifact(sid, { kind: "diagram", value: diagram });
    send("myra:diagram", sid ? { ...diagram, sessionId: sid } : diagram);
  });
  /* Same push, for a table -- see tools/table.ts's header for why it carries
     the parsed DataTable and never a string the panel would have to trust. */
  setTableWatcher((table) => {
    const sid = inFlightConversation?.id;
    bufferArtifact(sid, { kind: "table", value: table });
    send("myra:table", sid ? { ...table, sessionId: sid } : table);
  });
  /* Same push, for a chart -- carries the pure ChartData tools/chart.ts
     computed, never a string either. */
  setChartWatcher((chart) => {
    const sid = inFlightConversation?.id;
    bufferArtifact(sid, { kind: "chart", value: chart });
    send("myra:chart", sid ? { ...chart, sessionId: sid } : chart);
  });
  /* Resolves a data_id to the pasted text it names, for create_table and
     create_chart -- read fresh from disk on every call, never cached here,
     for the same reason imageResolver re-reads every turn. The display name
     is not stored beside the text on disk -- it is already sitting in this
     conversation's own messages, the same place imageResolver finds an
     image's mime type from.
     Resolved against `inFlightConversation`, the conversation this tool call's
     own turn is running in -- never `currentSession()`, which is merely
     whatever the renderer is looking at and can change mid-turn the moment
     the user switches conversations, the exact hazard `inFlightConversation`
     exists to avoid (see its own comment above). Falling back to
     `currentSession()` only covers a call with no turn in flight at all,
     which the test suite's own direct handler calls rely on. */
  setDataHost(async (id): Promise<DataSource | undefined> => {
    const conversation = inFlightConversation ?? currentSession();
    const text = await readDataText(conversation.id, id);
    if (text === undefined) return undefined;
    const known = conversation.messages_
      .flatMap((m) => m.attachments ?? [])
      .find((a) => a.kind === "data" && a.id === id);
    return { name: known?.name ?? id, text };
  });

  await runtime.load();

  /*
   * Reclaim model servers a previous run left holding the graphics card.
   *
   * Before anything can call `ensureLemonade`, so it never sees the daemon this
   * run is about to start. Not behind a prompt, and that is deliberate: the
   * identity check in core/runtime/strays.ts requires a process running as this
   * user, out of MyRA's own data directory, matching a pid and kernel start
   * time MyRA wrote down itself -- a false positive is very nearly ruled out,
   * a modal before the window exists is the worst possible moment to ask, and
   * "is pid 4242 yours?" is not a question anybody can answer. What the user
   * needs is to find out afterwards, which is what this line and the note in
   * the runtime log are for.
   */
  void runtime.sweepStrays().then((count) => {
    if (!count) return;
    try {
      new Notification({
        title: "MyRA",
        body: `Freed memory from ${count} model server${count === 1 ? "" : "s"} left running by a previous session.`,
      }).show();
    } catch {
      /* A desktop without notifications is not a reason to fail a startup. */
    }
  });

  /*
   * Loading a local model is a decision about where the conversation goes.
   *
   * A provider-qualified choice beats the loaded local model in resolveLlm, and
   * has to: picking a hosted model must not be quietly overridden by whatever
   * happens to be resident. But that rule read the other direction too --
   * someone who had used a hosted model, then went to Models and loaded a local
   * one, kept talking to the hosted one, with the bar still saying so and
   * nothing explaining why. Loading a model IS the instruction to use it, so
   * the hosted choice is stood down at that moment rather than silently
   * outranking a thing the user just did.
   */
  installRuntimeIpc(runtime, send, () => vault.get("hfToken"), () => window_, async () => {
    if (!standsDownForLocal(config.current.llm.model ?? "")) return;
    await config.update({ llm: { ...config.current.llm, model: "" } });
    // The bar reads this from settings; without the nudge it keeps the old name
    // until something else happens to refresh it.
    send("myra:settings", config.current);
  });

  await api.load();
  installApiIpc(api, send);
  /* After the runtime, because serving with nothing to serve answers 503 --
     honest, but a poor first impression for someone who left it switched on. */
  void api.startOnLaunch();

  /*
   * Everything that talks to a model resolves its endpoint here.
   *
   * Chat, research stages and meeting notes must all follow the model that is
   * actually loaded. Reading `settings.llm` directly finds either a stale port
   * or the user's own endpoint, so a run would silently use a different model
   * than the conversation that started it -- and meeting notes did worse than
   * that: with the endpoint field empty, which is the normal state for someone
   * running a local model, they failed with "No LLM endpoint is configured"
   * while a model sat loaded three feet away.
   */
  /**
   * The sampler settings for a chosen model, filtered for where it is going.
   *
   * The filter is not a nicety. llama.cpp accepts top_k, min_p, DRY and the
   * rest; a hosted API answers 400 for the whole request when it sees one. So
   * somebody who tuned min-p for their local model would find every hosted
   * model broken, with nothing saying which setting did it.
   */
  /**
   * The sampler settings for a model: the authors' own, under the user's.
   *
   * Per key, not per model. Somebody who has set only a temperature keeps the
   * published top-p and top-k rather than losing them for having touched one
   * field, and somebody who has set nothing gets what the model was shipped to
   * do instead of whatever the server's defaults happen to be.
   *
   * The suggestions live in modelFacts.json rather than in `Settings.sampling`,
   * so a suggestion and a choice never occupy the same slot and "clear this
   * field" means "back to what the authors said" rather than "back to nothing".
   */
  const samplingFor = async (stored: string, local: boolean): Promise<Record<string, number>> =>
    samplingForRequest(
      { ...(await suggestedFor(stored)), ...(config.current.sampling[stored] ?? {}) },
      !local,
    );

  /* Keyed exactly as sampling is, and by the same expression at each call site,
     so a model's persona and its sampler settings can never disagree about
     which model they belong to. */
  const personaFor = (stored: string): string =>
    config.current.systemPrompts[stored]?.trim() || config.current.persona;

  /**
   * The thinking-effort fields for a stored choice, or nothing.
   *
   * Nothing is the normal case, and it has to be: every field here is one a
   * strict endpoint can refuse the whole request over. A choice is only turned
   * into a field when it still belongs to a dialect that endpoint speaks, so a
   * level chosen against OpenAI cannot follow a model reference to a server
   * where it means nothing.
   */
  const reasoningExtra = (
    dialects: readonly ReasoningDialect[],
    modelRef: string,
  ): Record<string, unknown> => {
    const stored = config.current.reasoning[modelRef] ?? {};
    return mergeReasoningFields(
      dialects.map((dialect) => {
        const level = effectiveLevel(dialect, stored[dialect.id] ?? stored[LEGACY_REASONING]);
        return level ? reasoningFields(dialect, level) : {};
      }),
    );
  };

  /** Hosted: the reasoning ask, plus an effort field if one was verified. */
  const extrasFor = (
    provider: Provider,
    modelRef: string,
    ask: Record<string, unknown>,
  ): { extra?: Record<string, unknown> } => {
    const known = provider.reasoningParam ? dialectById(provider.reasoningParam) : undefined;
    const extra = {
      ...(provider.askReasoning ? ask : {}),
      ...reasoningExtra(known ? [known] : [], modelRef),
    };
    return Object.keys(extra).length ? { extra } : {};
  };

  /**
   * Local: the template variable this model was found to read.
   *
   * Read from the cache the capability check fills, so a request never renders
   * a template of its own -- the choice cannot exist without that check having
   * run, because the control that sets it is only drawn when it succeeds.
   */
  const localReasoningExtra = (model: string): { extra?: Record<string, unknown> } => {
    const extra = reasoningExtra(cachedLocalDialects(model), model);
    return Object.keys(extra).length ? { extra } : {};
  };

  /**
   * Where to send one model reference.
   *
   * `ref` is what the picker stores: "providerId::model" for a hosted model, a
   * bare name for anything else. Undefined means the conversation's own choice,
   * which is what chat, meetings and dictation all want.
   *
   * A research stage passes its OWN reference, and that is the whole reason
   * this takes an argument. Before, every stage inherited the chat model's
   * endpoint and only swapped the model name onto it -- so a screener assigned
   * a local model while the conversation was on a hosted provider was sent to
   * that provider, under its key, asking for a model it had never heard of.
   */
  const resolveLlm = async (ref?: string): Promise<EndpointResolution> => {
    /*
     * A provider-qualified choice wins over the loaded local model.
     *
     * It has to: choosing a hosted model is an explicit instruction about where
     * this conversation goes, and quietly answering from whatever happens to be
     * resident instead would make the picker a suggestion. The reverse matters
     * more -- a local choice must never be routed outward -- and that direction
     * is guarded by `providerFor` returning nothing for a bare name.
     */
    const chosen = ref ?? config.current.llm.model ?? "";
    const { providerId } = parseModelRef(chosen);
    const provider = providerFor(config.current.providers, chosen);
    /*
     * A choice naming a provider that is gone is broken, not local.
     *
     * Without this it fell through to whatever model happened to be loaded --
     * answering from something the user did not choose, under a picker still
     * showing the model they did, and with the bar warning "external" about a
     * request that had just gone nowhere near a network. Every other
     * substitution in this file is refused out loud; this one was silent
     * because it arrived by deletion rather than by choice.
     */
    if (providerId && !provider) {
      throw new Error(
        "The model this conversation is set to came from a provider that no longer exists. " +
          "Choose another model from the picker.",
      );
    }
    if (provider && isUsable(provider)) {
      const { model } = parseModelRef(chosen);
      const key = await vault.get(providerSecret(provider.id));
      return {
        /* Built rather than spread from llm. `envVar` names where THAT
           endpoint's key comes from and would be carried onto a provider it
           has nothing to do with -- inert today, because chat takes its key as
           an argument, and exactly the sort of wrong field that is true right
           up until something reads it. */
        endpoint: {
          baseUrl: provider.baseUrl,
          model,
          envVar: "",
          timeoutMs: config.current.llm.timeoutMs,
        },
        ...(key ? { apiKey: key } : {}),
        label: `${model} (${provider.label})`,
        // Only what this endpoint will accept. A provider the user runs on
        // loopback gets the whole set; anything else gets the standard fields.
        sampling: await samplingFor(chosen, !isExternal(provider)),
        persona: personaFor(chosen),
        /* Sent only to a provider the reasoning check found needs asking.
           Never speculatively: a server that does not know these fields
           refuses the whole request. */
        ...extrasFor(provider, chosen, ASK_FOR_REASONING),
      };
    }
    if (provider && !isUsable(provider)) {
      /* Named, not silently fallen back from. Falling back would answer from a
         local model under a label the user did not choose, which is the one
         substitution this app should never make quietly. */
      const name = provider.label || "a provider";
      throw new Error(
        provider.enabled
          ? `The model chosen is served by ${name}, which has no address set in ` +
            "Settings → Providers. Give it a base URL, or choose another model."
          : `The model chosen is served by ${name}, which is switched off in ` +
            "Settings → Providers. Turn it back on, or choose another model.",
      );
    }

    /* Reload the chosen model first if something unloaded it -- the daemon
       evicting to make room, or the user freeing the card for an image. The
       choice survived; only the residency did. */
    const reloadFailed = await runtime.ensureChatModel();
    const managed = runtime.chatEndpoint();
    if (managed) {
      /* A bare reference names a model on this machine. It is used as given
         rather than replaced by whatever is currently resident: Lemonade loads
         a model it is asked for, and a research stage that named one should
         get that one. With no reference at all, the loaded model is the
         answer, which is what a chat turn means. */
      const model = chosen.trim() || managed.model;
      return {
        endpoint: { ...config.current.llm, baseUrl: managed.baseUrl, model },
        apiKey: managed.apiKey,
        // The file name, not the port. A meeting note recording
        // "http://127.0.0.1:37617/v1" as the model that wrote it says nothing
        // a month later, when the port is long gone.
        label: basename(runtime.chatModel()?.id ?? "") || config.current.llm.model || "a local model",
        /* Keyed by the model that will actually answer, not by whatever
           llm.model holds: tuning follows the model rather than the setting
           that used to name it. */
        sampling: await samplingFor(model, true),
        persona: personaFor(model),
        ...localReasoningExtra(model),
        promptProgress: true,
      };
    }
    /*
     * No model loaded, so fall back to whatever endpoint the user configured.
     *
     * Said out loud when there isn't one. The failure this replaces was silent
     * and misdirected: with no endpoint set, the request went to a base URL of
     * "" and surfaced as a fetch error about a malformed address, which reads
     * as a bug in MyRA rather than as "load a model". A stale address from an
     * older build did worse -- it named a host that had not existed for weeks.
     */
    const llm = config.current.llm;
    if (!llm.baseUrl.trim()) {
      throw new Error(
        /* When there IS a chosen model and it refused to load, that reason is
           the whole answer; "open Models and load one" would send somebody to
           press a button that has just failed. */
        reloadFailed ??
          "No model is loaded. Open Models and load one, or set your own endpoint in " +
            "Settings → Providers.",
      );
    }
    const key = await vault.get("llmKey");
    return {
      /* A reference still wins over the stored model here: this branch is
         somebody's own single endpoint, and a stage that named a model on it
         asked for that model. */
      endpoint: chosen.trim() ? { ...llm, model: chosen.trim() } : llm,
      ...(key ? { apiKey: key } : {}),
      label: llm.model || llm.baseUrl,
      persona: personaFor(chosen.trim() || llm.model || ""),
    };
  };
  setEndpointResolver(resolveLlm);
  /* The chat turn runs in a different scope from this one, and it must not grow
     its own copy of the reasoning above: that divergence is what let a chosen
     provider apply everywhere except the conversation. */
  resolveEndpoint = resolveLlm;

  /* The one crossing between core's database clients and main's vault: core
     asks for a key by name and gets a string or nothing, and never learns
     there is a keyring. Read at request time via vault.get, never cached
     here, so a key entered in Settings works on the very next search. */
  setDatabaseKeys((name) => vault.get(name));

  installIpc();
  installMeetingIpc({
    config,
    send,
    llm: resolveLlm,
    onCreated: (ref) => void fileInActiveProject(config, "meeting", ref),
    /* Not started for a meeting stage. Transcribing is background work, and an
       inference engine coming up because a stage ran is a surprise; dictation
       makes the opposite call because somebody is holding the microphone. */
    transcription: () => resolveAudio({ config, vault, runtime }, "transcription"),
    /* A meeting that failed to transcribe must say why in the same words
       dictation does: the model list offers Whisper whether or not the engine
       that runs it is installed, and "whisper-server failed to start" is not a
       sentence anybody can act on. */
    explainTranscription: (err) =>
      explainModelFailure(
        { runtime },
        "transcription",
        config.current.audio.transcriptionModel,
        err,
      ),
  });
  installDictationIpc({ config, vault, runtime, send });
  installAudioIpc({
    config, vault, runtime, send,
    /*
     * Unloading is "stop using the card now", so it stops the work first.
     *
     * Without this the click was undone a second later: resolveLlm calls
     * ensureChatModel on every request, so the next stage of a running sweep
     * loaded the model straight back in and the run carried on. Freeing the
     * card while forty minutes of screening keeps refilling it is not a
     * control, it is a suggestion.
     */
    stopWork: () => inFlight?.abort(),
  });
  installImageIpc({
    config, vault, runtime, send,
    onCreated: (ref) => void fileInActiveProject(config, "image", ref),
  });
  /* Not `fileInActiveProject`: a task is deliberately not a project member
     (see core/tasks/task.ts's header) -- main/tasks.ts files new tasks under
     the active project itself, on the same field every other kind reads. */
  installTaskIpc({ config, send });
  /* The fallback reminder heartbeat. Started here rather than lazily on first
     use, so a task with a reminder set before the app was last closed is not
     missed on the very session that would have caught it. */
  startReminders();
  /* The same resolver chat and meetings take, so the paper drafter always
     writes with whatever the model bar names and configures nothing of its
     own. */
  /*
   * One lease over the long work that is not a chat turn.
   *
   * Shared by the paper drafter and the reviewer because it is a fact about the
   * card rather than about either feature: two long generations at once is the
   * out-of-memory meetings avoids by transcribing serially. A chat turn is
   * deliberately outside it -- somebody is waiting for that one.
   */
  jobs = createJobs(send);
  /* The snapshot a page asks for when it mounts. Without it, coming back to a
     review that is four minutes into its second reviewer shows an empty page
     until the reviewer after that begins -- which is the whole complaint
     `myra:research-active` still has. */
  ipcMain.handle("myra:work-state", () => jobs?.current() ?? null);
  installActiveRunQuestion();

  installPaperIpc({
    config, send, jobs, llm: resolveLlm,
    onCreated: (ref) => void fileInActiveProject(config, "paper", ref),
  });
  installReviewIpc({
    config, send, jobs, llm: resolveLlm,
    onCreated: (ref) => void fileInActiveProject(config, "review", ref),
    /* The window the daemon actually loaded the model with, which is the same
       figure the conversation's context meter reads. A hosted model reports
       none, and the reviewer then does not refuse on a number it does not have. */
    contextTokens: () => {
      /* Nothing for a hosted choice, and specifically not the local model that
         happens to be resident beside it: the review would go to the provider,
         so refusing a manuscript against a window belonging to some other
         model is a refusal about the wrong thing. */
      if (providerFor(config.current.providers, config.current.llm.model ?? "")) return undefined;
      return runtime.chatEndpoint()?.contextTokens;
    },
  });
  /* Last of the five, because it reads all of them: a project is an index over
     the other stores rather than a store of its own. */
  installProjectIpc({ config, send, stores: defaultStores(config) });
  installMemoryIpc({
    config,
    send,
    llm: resolveLlm,
    currentSession,
    ui: {
      choose: (choice) =>
        prompt({
          method: "choice",
          title: choice.title,
          ...(choice.message ? { message: choice.message } : {}),
          options: choice.options,
          ...(choice.multi ? { multi: true } : {}),
          ...(choice.required ? { required: true } : {}),
        }),
      input: (title, placeholder) => ask("input", title, placeholder),
      form: async (title, message, fields) => {
        const answer = await prompt({ method: "form", title, ...(message ? { message } : {}), fields });
        if (answer === undefined) return undefined;
        try {
          const parsed = JSON.parse(answer) as unknown;
          return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
        } catch {
          return {};
        }
      },
    },
    busy: () => inFlight !== undefined || jobs?.current() !== undefined,
    /*
     * Whether calling the resolver right now would load a LOCAL model that is
     * not already resident -- never a question for a hosted choice, which has
     * no card to spare and nothing this app would be reloading. The same
     * check the reviewer's own context-fit callback makes a few lines above,
     * for the same reason.
     */
    modelReady: () => {
      if (providerFor(config.current.providers, config.current.llm.model ?? "")) return true;
      if (runtime.chatModel()) return true;
      /* Nothing of ours is resident. That is still "ready" when there is
         nothing to load -- chat goes to the user's own endpoint -- and it was
         read as "never", so on such a setup the automatic pass could not run
         at all. What must not happen is reloading the chosen local model. */
      return !runtime.wouldLoadForChat() && Boolean(config.current.llm.baseUrl.trim());
    },
  });

  createWindow();
  setPdfRenderer(installPdfRenderer());

  // Deliberately not awaited: a large model takes minutes to map and the
  // window must not wait on it.
  void runtime.startOnLaunch().catch(() => {});
}

/**
 * One MyRA at a time.
 *
 * Two would each start a Lemonade daemon and the second would fail to bind the
 * API port. It is also the way back to a hidden window when no tray icon is
 * visible: launching MyRA again raises the one already running.
 */
const soleInstance = claimSingleInstance(() => reveal(window_));
if (!soleInstance) {
  /* `app.quit()` is asynchronous, so without gating the startup below on this
     the second instance still builds a window and a tray icon before it goes,
     which flickers a second icon into the tray and briefly races the first
     instance for the API port. */
  app.quit();
}

/**
 * Say once that closing the window did not stop MyRA.
 *
 * A tray icon is easy to miss, and an app that appears to have quit while
 * holding several gigabytes of model is exactly the surprise this should not
 * spring on anyone. Shown the first time only -- after that the behaviour is
 * known, and a notification on every close would be nagging.
 */
let toldAboutTray = false;
function noteHidden(): void {
  if (toldAboutTray) return;
  toldAboutTray = true;
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: "MyRA is still running",
      body: "Your model and the API stay up. Quit from the MyRA icon in your tray.",
    }).show();
  } catch {
    // A desktop without notifications is not a reason to fail a window close.
  }
}

if (soleInstance) app.whenReady().then(() => {
  /*
   * No remote assets, ever. Set here rather than in the HTML so a page that
   * forgot its meta tag still cannot reach out.
   *
   * The shipped policy forbids inline script. In development that is fatal but
   * not for a security reason: @vitejs/plugin-react injects an inline preamble
   * to install React Refresh, the strict policy blocks it, and the app fails
   * with "can't detect preamble" and an empty <div id="root"> -- a blank
   * window with nothing in the terminal to explain it.
   *
   * So the relaxation is scoped to the dev server and nothing else.
   * ELECTRON_RENDERER_URL is set only by electron-vite; a packaged build loads
   * from file:// and keeps the strict policy, which is the one that matters
   * because it is the one users run.
   */
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  const policy = devServer
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; " +
      // Vite's HMR socket and module graph, both on the dev server's origin.
      `connect-src 'self' ${devServer} ${devServer.replace(/^http/, "ws")}; ` +
      "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
      "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    done({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });

  /*
   * Default-deny egress for the renderer, which is the belt to the CSP's braces.
   *
   * The UI makes no network requests at all -- every fetch in this app runs in
   * the main process, behind IPC -- so the honest policy for the window is
   * "nothing", and anything that does try is either a dependency phoning home
   * or a bug. The one exception is the dev server, which serves the modules and
   * the HMR socket.
   *
   * Blocked attempts are counted and shown in Settings rather than dropped in
   * silence, because a privacy claim you cannot check is a claim you have to
   * take on faith.
   */
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, done) => {
    if (devServer && details.url.startsWith(devServer.replace(/^http/, "ws"))) return done({});
    if (devServer && details.url.startsWith(devServer)) return done({});
    blocked.push({ url: details.url.slice(0, 200), at: new Date().toISOString() });
    if (blocked.length > 50) blocked.shift();
    return done({ cancel: true });
  });

  void main();

  /*
   * The tray is created after the window so that "Open MyRA" always has
   * something to open, and its menu is refreshed from the two things that
   * change underneath it: which model is loaded, and whether the API serves.
   */
  tray = new MyraTray({
    show: () => {
      if (!window_ || window_.isDestroyed()) createWindow();
      else reveal(window_);
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
    /* Failure is worth a line in the log but not a dialog: a tray click is a
       casual action, and the menu redraws from the real state either way, so a
       model that did not unload still says it is loaded. */
    eject: () => {
      void runtime.unloadModel().catch((err: unknown) => {
        console.error("Ejecting the model from the tray failed:", err);
      });
    },
    state: () => ({
      /* The name a person recognises, not the index id: a tray menu reading
         "Model: lmstudio__LFM2.5-8B-A1B" is bookkeeping on display. */
      ...(runtime.lemonade.status.health?.modelLoaded
        ? { model: displayModelName(runtime.lemonade.status.health.modelLoaded) }
        : {}),
      ...(api.state.status.url ? { apiUrl: api.state.status.url } : {}),
    }),
  });
  tray.start();
  /*
   * Printed after a moment, and reporting the icon rather than the object.
   *
   * It decides whether closing the window quits MyRA, and on Linux the answer
   * depends on the desktop rather than on anything MyRA controls. It used to
   * print the result of `start()`, which is only whether a Tray was
   * constructed -- and this machine constructs one happily while publishing no
   * icon at all, so the line said the window would stay running and be
   * reachable from a tray that did not exist.
   *
   * Delayed because registration is asynchronous: asked immediately the answer
   * is "not yet" on a desktop where it is about to be yes.
   */
  setTimeout(() => {
    console.log(
      tray?.available
        ? "Tray icon is showing; closing the window will keep MyRA running."
        : "No tray icon appeared on this desktop; closing the window will quit MyRA.",
    );
  }, 2000).unref?.();
  runtime.onChange(() => tray?.refresh());
  api.onChange(() => tray?.refresh());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else reveal(window_);
  });
});

app.on("window-all-closed", () => {
  /* A hidden window is not a closed one, so this does not fire while MyRA is
     in the tray. It fires when the window was really destroyed, which now only
     happens on the way out or when the tray is unavailable. */
  if (process.platform !== "darwin") app.quit();
});

/*
 * Take the model server with us, and wait long enough for it to go.
 *
 * This used to be a synchronous SIGKILL to lemond's pid, and that was the bug
 * behind the report that started this: a SIGKILL cannot be caught, so the
 * daemon never shut down the engines it had spawned -- `llama-server` and the
 * rest were reparented to init still holding the graphics card, every close of
 * the window stranded another set, and the machine did not get its memory back
 * until it was rebooted.
 *
 * Quitting therefore waits now. `before-quit` cannot await on its own, so this
 * is the standard dance: preventDefault, do the real teardown, then quit again
 * for real. The timeout is what stops a wedged daemon holding the app open
 * forever, and it sits OUTSIDE the three-second grace inside `stop()`, so the
 * clean path always finishes first and this only fires when something is
 * genuinely stuck. The cost is that quitting is no longer instant -- paid after
 * the window has already gone, which is the right place to pay it.
 */
const QUIT_TIMEOUT_MS = 5_000;
let teardown: Promise<void> | undefined;
/* Set only inside the teardown's own `app.quit()` below -- the one pass this
   handler is allowed to let through. Without it, a second Cmd-Q (or an
   impatient Ctrl-C, or a re-sent SIGTERM) arriving while `teardown` is already
   running hit the early `if (teardown) return` with no `preventDefault`, so
   Electron quit immediately: `runtime.stop()` never reached its SIGKILL
   escalation, and lemond was abandoned mid-SIGTERM -- the exact leak this
   whole rewrite exists to close, caused by the rewrite's own second path out. */
let quitConfirmed = false;

app.on("before-quit", (event) => {
  /* Set here as well as in the tray's Quit, so a shutdown that starts anywhere
     else -- the desktop's session end, Cmd-Q, a signal -- also lets the window
     close rather than being blocked by the hide-on-close handler. */
  quitting = true;
  // The pass the teardown's own app.quit() causes. Every other pass is held.
  if (quitConfirmed) return;
  event.preventDefault();
  // A pass that arrived while the first is still tearing down: already held.
  if (teardown) return;
  tray?.destroy();
  /* The Zotero snapshot is a copy of the user's library. It is theirs, it is
     under their own config directory, and it still has no business outliving
     the app that made it. */
  forgetZoteroSnapshot();
  /* Held so it can be cleared, rather than `unref`ed. An unref'd timer does not
     keep the process alive, which is the difference between a grace period and
     the appearance of one -- the same mistake, made in daemons.ts first, let a
     sweep exit before it had finished reclaiming anything. */
  let ceiling: NodeJS.Timeout | undefined;
  teardown = Promise.race([
    (async () => {
      await runtime.stop();
      /* The listening socket must not outlive the window either -- and the key
         usage counters are only flushed on stop. */
      await api.stop();
    })(),
    new Promise<void>((resolve) => { ceiling = setTimeout(resolve, QUIT_TIMEOUT_MS); }),
  ])
    .catch(() => undefined)
    .finally(() => {
      if (ceiling) clearTimeout(ceiling);
      // A no-op after a clean stop, and the whole point after a timeout.
      runtime.killNow();
      quitConfirmed = true;
      app.quit();
    });
});
process.on("exit", () => {
  runtime.killNow();
});

/*
 * The ways out that never reached `before-quit` at all.
 *
 * A desktop session ending, a `kill <pid>`, or Ctrl-C in `npm run dev` delivers
 * a signal that Node acts on by terminating immediately -- so neither
 * `before-quit` nor the `exit` handler above ever ran, and lemond and every
 * engine it had spawned survived completely intact with nothing left in the
 * world able to find them. There was no handler for any of these.
 *
 * It is not optional alongside detaching the daemon: a terminal's Ctrl-C goes
 * to the foreground process group, which the daemon is deliberately no longer
 * in, so without this, detaching would have created a leak for developers in
 * the act of fixing one for users. `app.quit()` is idempotent and routes
 * through the teardown above.
 */
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    quitting = true;
    app.quit();
  });
}

/*
 * A stray rejection must not take lemond down with it.
 *
 * Node's default for an unhandled rejection is to terminate the process, and
 * an Electron main process is a big surface for one: every IPC handler, every
 * `void`-ed promise, every timer. When it fires the app dies without running
 * `before-quit`, and the model server -- which is a child of a process that is
 * already gone -- is orphaned holding several gigabytes of memory. The user
 * sees MyRA vanish and their RAM stay spent, which is the exact failure the
 * shutdown path above exists to prevent.
 *
 * The two are handled differently, and the asymmetry is deliberate. An uncaught
 * exception really does end the process, so it takes the daemon down first --
 * carrying on after one means running with state that has already been left
 * half-written. An unhandled rejection is logged and nothing else: killing the
 * runtime on one would mean a rejected fetch inside a research stage costing
 * somebody the model they had loaded, which is a worse outcome than the leak.
 * Neither swallows the fault silently.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[myra] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[myra] uncaught exception:", err);
  quitting = true;
  try {
    runtime.killNow();
  } catch {
    /* Already gone, which is the outcome this wanted anyway. */
  }
  process.exit(1);
});
