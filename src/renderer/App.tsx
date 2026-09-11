import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAgent } from "./useAgent.ts";
import { answerText } from "./components/turnText.ts";
import { CopyButton } from "./components/CopyButton.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { ArtifactPanel, useDocuments } from "./components/ArtifactPanel.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { Reasoning } from "./components/Reasoning.tsx";
import { MessageStatsLine } from "./components/MessageStats.tsx";
import { ResearchProgress } from "./components/ResearchProgress.tsx";
import { ApiPage } from "./components/ApiPage.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { RailButton } from "./components/Rail.tsx";
import { RailSection, useRailSection } from "./components/RailSection.tsx";
import { WorkingBar } from "./components/WorkingBar.tsx";
import { DownloadsButton, DownloadToast, useDownloads } from "./components/Downloads.tsx";
import { ModelBar } from "./components/ModelBar.tsx";
import { AudioPicker } from "./components/AudioPicker.tsx";
import { ResearchBar } from "./components/ResearchBar.tsx";
import { ReasoningBar } from "./components/ReasoningBar.tsx";
import { MeetingsPage } from "./components/MeetingsPage.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { RunPanel } from "./components/RunPanel.tsx";
import { LemonadePane } from "./components/LemonadePane.tsx";
import { ContextMeter } from "./components/ContextMeter.tsx";
import { LookupResults } from "./components/LookupResults.tsx";
import { useLookup } from "./useLookup.ts";
import { UiDialog } from "./components/UiDialog.tsx";
import { FirstRun } from "./components/FirstRun.tsx";
import { Tour } from "./components/Tour.tsx";
import type { TourPage } from "../core/tour/steps.ts";
import { enumerate } from "./capture.ts";
import { useDictation } from "./useDictation.ts";
import { useSpeech } from "./useSpeech.ts";
import { useHandsFree } from "./useHandsFree.ts";
import { DictationHud } from "./components/DictationHud.tsx";
import { ImagePage } from "./components/ImagePage.tsx";
import { PaperDrafter } from "./components/PaperDrafter.tsx";
import { PeerReview } from "./components/PeerReview.tsx";
import { ProjectsPage } from "./components/ProjectsPage.tsx";
import { ImagePicker } from "./components/ImagePicker.tsx";
import { restoreThread, type StoredMessage } from "./restore.ts";
import { downscaleImage } from "./downscale.ts";
import type {
  ActiveRun, CitedSource, JobSnapshot, MemberKind, PendingAttachment, ProjectSummary, PromptRequest,
  RuntimeState, Settings,
} from "./types.ts";

/** Runs and Models are places you go; the conversation is where you come back to. */
type Page = "chat" | "runs" | "models" | "meetings" | "images" | "papers" | "review" | "projects" | "api";

/** Where each kind of work lives. One table, so a seventh kind is one line. */
const PAGE_FOR: Record<MemberKind, Page> = {
  chat: "chat",
  meeting: "meetings",
  run: "runs",
  paper: "papers",
  review: "review",
  image: "images",
};

export function App() {
  const { items, busy, usage, error, sources, send, abort, reset, dismissError } = useAgent();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  /* Which tab Settings opens on, when something sent you there for a reason. */
  const [settingsTab, setSettingsTab] = useState<"runtime" | "review" | undefined>();
  /*
   * One page at a time, held in one variable.
   *
   * These were three independent booleans, which meant every place that opened
   * a page also had to remember to close the other two -- and the places that
   * did not open a page, chiefly starting or reopening a conversation, closed
   * nothing at all. Clicking a past conversation while the model hub was up
   * loaded it behind the hub, so the app looked broken and the only way back
   * was a "Back to chat" button on the far side of the screen.
   */
  const [page, setPage] = useState<Page>("chat");
  /* The documents this conversation has written. Session-scoped on purpose:
     these are what MyRA made while you watched, not a file browser. */
  const documents = useDocuments();
  const [prompt, setPrompt] = useState<PromptRequest | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  /* Separate from the note above: this changes once per stage, that one many
     times a second, and the card needs both. */
  const [stage, setStage] = useState<string | undefined>();
  /*
   * Two drafts, one box.
   *
   * A half-written question and a search query are not the same text, and
   * carrying one into the other mode is how you end up sending "spaced
   * retrieval practice" to a model, or searching OpenAlex for a paragraph you
   * were writing. Each mode keeps what you left in it.
   */
  const [draft, setDraft] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  /* Held only until Send: main already has an image's bytes on disk and a
     document's text extracted by the time one of these exists, so this is a
     reference and a chip's worth of display, never the file itself. */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  // Searching the literature yourself is a mode of the composer, not a window
  // over it: the box you type in is the same box either way, and what changes
  // is who reads what you typed.
  const [lookup, setLookup] = useState(false);
  const search = useLookup();
  const [sessionsKey, setSessionsKey] = useState(0);
  /*
   * Projects: the rail's list, and which one is open on screen.
   *
   * Which one is ACTIVE is a setting rather than state here, because the main
   * process is what acts on it -- a conversation, a paper, a meeting, an image
   * and a research run are all created down there and each files itself. This
   * only decides what is drawn.
   */
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const { open: projectsOpen, toggle: toggleProjects } = useRailSection("projects");
  const [openProject, setOpenProject] = useState<string | undefined>();
  /* Which record each page should show when it is opened from somewhere else --
     the rail's recent list, or a project. Four kinds have their own page now, so
     "go to the Papers page" is no longer the same thing as "open this paper". */
  const [openPaper, setOpenPaper] = useState<string | undefined>();
  const [openReview, setOpenReview] = useState<string | undefined>();
  const [openRun, setOpenRun] = useState<string | undefined>();
  /** The long job that is not a chat turn, so the rail can show it anywhere. */
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  /*
   * The theme is stamped on <html>, not on a wrapper element.
   *
   * `body` and the scrollbars take their colour from the document, so a class
   * on a div inside the app leaves the page behind it painted in the other
   * theme -- visible as a dark gutter down the side of a light window.
   */
  useEffect(() => {
    document.documentElement.dataset["theme"] = settings?.theme ?? "dark";
  }, [settings?.theme]);

  useEffect(() => {
    void window.myra.getSettings().then(setSettings);
    /* And whenever the main process changes them itself. Loading a local model
       stands down a hosted choice, and without this the bar goes on naming a
       model the next message will not be sent to. */
    const stop = window.myra.onSettings(setSettings);
    // Enumerating once at startup is what gives the main process a device list
    // to validate meeting tracks against; only the renderer can produce one.
    void enumerate().catch(() => undefined);
    return stop;
  }, []);

  const activeProject = settings?.activeProject ?? "";

  const refreshProjects = useCallback(() => {
    void window.myra.projectList().then((r) => setProjects(r.projects ?? []));
  }, []);

  useEffect(() => {
    refreshProjects();
    return window.myra.onProjects(setProjects);
  }, [refreshProjects]);

  /* The long job, asked once and then pushed. It is drawn on every page,
     including chat: a review running while you carry on talking to the model is
     the case this whole arrangement exists for. */
  useEffect(() => {
    void window.myra.workState().then(setJob);
    return window.myra.onWork(setJob);
  }, []);

  useEffect(() => window.myra.onPrompt(setPrompt), []);
  /* What the daemon is holding, for the three pickers in the bar above: each
     says "None selected" unless the model it names is actually in memory. */
  const [resident, setResident] = useState<string[]>([]);
  useEffect(() => {
    const take = (r: RuntimeState): void => setResident(r.lemonade.resident ?? []);
    void window.myra.runtimeState().then(take);
    return window.myra.onRuntime(take);
  }, []);

  useEffect(() => window.myra.onResearchProgress(setProgress), []);
  /* An empty stage means the run is over: the card comes down, and the plain
     progress line takes over again for whatever the turn does next. */
  useEffect(() => window.myra.onResearchStage((s) => setStage(s || undefined)), []);
  /* Reported on its own channel because the two above are consumed inside the
     conversation, which is hidden on every other page. This one has to reach
     the rail and the Research runs list wherever the user happens to be. */
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  /* Asked as well as listened for: a run's stage can take minutes, so arriving
     mid-run with only the push meant the rail said nothing at all until the next
     stage began. */
  useEffect(() => {
    void window.myra.researchActive().then(setActiveRun);
    return window.myra.onResearchActive(setActiveRun);
  }, []);
  /* Subscribed here, at the top, because the counter is in the bar above every
     page and the toast floats over all of them. */
  const downloads = useDownloads();
  /* And again when the turn ends, so nothing is left in state to resurface. */
  useEffect(() => {
    if (!busy) {
      setProgress(undefined);
      setStage(undefined);
    }
  }, [busy]);

  // Read through a ref because transcription lands long after the callback was
  // made, and it has to reach whichever box is in front of you then.
  const lookupRef = useRef(lookup);
  useEffect(() => {
    lookupRef.current = lookup;
  }, [lookup]);

  /*
   * A page that claims the microphone while it is open.
   *
   * The paper drafter dictates into a notes box, not into the composer. It
   * cannot call useDictation itself: that hook subscribes to the transcript
   * channel, and a second subscriber means every transcript arrives twice. So
   * there is one dictation for the app and pages borrow it, exactly as the
   * composer and the literature search box already do.
   */
  const dictationSink = useRef<((text: string) => void) | undefined>(undefined);

  const speech = useSpeech();
  /* Read through a ref for the same reason the lookup box is: the transcript
     lands a second or two after the callback was built, and by then the mode
     may have been switched off. */
  const handsFreeRef = useRef(false);
  const handsFree = settings?.audio.speechToSpeech === true;
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  // Appended rather than replacing: dictation is for adding to what you were
  // already writing, and overwriting a half-typed question would be a bad way
  // to find that out. Hands-free is the exception -- there the transcript IS
  // the message, and putting it in the box for someone who is not looking at
  // the screen would be a conversation that never goes anywhere.
  const dictation = useDictation(
    useCallback((text: string) => {
      if (handsFreeRef.current) {
        void send(text);
        return;
      }
      if (dictationSink.current) {
        dictationSink.current(text);
        return;
      }
      const set = lookupRef.current ? setQueryDraft : setDraft;
      set((d) => (d ? `${d} ${text}` : text));
    }, [send]),
  );

  /*
   * What the hands-free loop should read out.
   *
   * Only once the turn has finished. Speaking a partial answer means starting
   * the sentence before the model has decided how it ends, and the audio cannot
   * be taken back once it is playing -- so the loop waits, which costs a pause
   * and never reads out something MyRA then contradicts.
   */
  const lastAnswer = useMemo(() => {
    if (busy) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind !== "assistant") continue;
      const text = answerText(item.blocks);
      return text ? { id: item.id, text } : undefined;
    }
    return undefined;
  }, [items, busy]);

  const loop = useHandsFree({
    enabled: handsFree,
    busy,
    answer: lastAnswer,
    dictation,
    speech,
    ...(settings?.dictationSource ? { micDeviceId: settings.dictationSource } : {}),
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length]);

  useEffect(() => {
    if (!busy) setSessionsKey((k) => k + 1);
  }, [busy]);

  const typed = lookup ? queryDraft : draft;
  const setTyped = lookup ? setQueryDraft : setDraft;

  /**
   * A file dropped, pasted or picked, read and sized before it is ever sent.
   *
   * Images are downscaled here -- this is the only side of the app with a
   * DOM -- before the bytes cross into main at all, so a 12-megapixel photo
   * never touches disk at its original size. `chatAttach` sniffs the bytes to
   * decide image or document; this file does not need to know which.
   */
  const attachFile = useCallback(async (file: File): Promise<void> => {
    setAttachError(undefined);
    setAttaching(true);
    try {
      const bytes = file.type.startsWith("image/") ? await downscaleImage(file) : await file.arrayBuffer();
      const result = await window.myra.chatAttach(file.name, bytes);
      if (!result.ok) {
        setAttachError(result.error ?? "That file could not be attached.");
        return;
      }
      setPendingAttachments((prev) => [...prev, result]);
    } catch (err) {
      setAttachError((err as Error).message || "That file could not be attached.");
    } finally {
      setAttaching(false);
    }
  }, []);

  const removeAttachment = useCallback((att: PendingAttachment): void => {
    setPendingAttachments((prev) => prev.filter((a) => a !== att));
    if (att.kind === "image") void window.myra.chatAttachRemove(att.id);
  }, []);

  const submit = useCallback(() => {
    const text = typed.trim();
    // A query stays in the box: you refine a search by editing it, and clearing
    // it after every Enter would mean retyping the whole thing to change a word.
    if (lookup) {
      if (!text) return;
      void search.run(text);
      return;
    }
    // An attached image with no question about it is still worth sending --
    // "what is this" is implied -- so only an entirely empty composer refuses.
    if ((!text && !pendingAttachments.length) || busy) return;
    setDraft("");
    /*
     * Cleared here, or the previous run's last words reappear over this one.
     *
     * The line is gated on `busy`, which reads like it is scoped to the turn
     * and is not: the string itself survives, so the moment a new turn goes
     * busy the old one is on screen again -- a deep run's scoping note showing
     * over a quick search that has not said anything yet, and describing work
     * that finished minutes ago.
     */
    setProgress(undefined);
    const attachments = pendingAttachments;
    setPendingAttachments([]);
    void send(text, attachments);
  }, [typed, busy, send, lookup, search, pendingAttachments]);

  /**
   * Drop whatever is sitting in the composer unsent, and delete the file
   * behind any pending image -- the same cleanup `removeAttachment` does for
   * one chip, done for all of them.
   *
   * Without this, a chip attached under the conversation being left behind
   * survives the switch in the composer's own state, saved on disk under the
   * OLD session's id. Sending it afterward pushes the reference into the NEW
   * session's messages, but `imageResolver` looks for the file under the new
   * session's directory, finds nothing, and `expandImages` degrades to plain
   * text -- so the chip shows as sent while the model silently never sees the
   * image, and the original file is never cleaned up either.
   */
  const clearPendingAttachments = (): void => {
    for (const att of pendingAttachments) {
      if (att.kind === "image") void window.myra.chatAttachRemove(att.id);
    }
    setPendingAttachments([]);
    setAttachError(undefined);
  };

  const openSession = async (id: string): Promise<void> => {
    const messages = (await window.myra.openSession(id)) as StoredMessage[];
    setSessionId(id);
    clearPendingAttachments();
    startFresh();
    // The stored form is the model's message list; this view wants cards in the
    // order they happened, each knowing its own outcome. restoreThread does
    // that conversion, including reuniting each tool call with the result that
    // arrived as a separate message, and recovering the sources so the [n]
    // markers in the restored prose still resolve.
    const { items: restored, sources: restoredSources } = restoreThread(messages);
    reset(restored, restoredSources);
    /* The panel showed what THIS conversation wrote. Carrying it into another
       one would attribute a document to a thread that never produced it. */
    documents.reset();
  };

  const newSession = async (): Promise<void> => {
    setSessionId(await window.myra.newSession());
    reset();
    documents.reset();
    clearPendingAttachments();
    startFresh();
  };

  /**
   * Open one piece of work, whatever kind it is.
   *
   * The rail's list and a project's contents both call this, so a review opens
   * the review rather than merely the reviewing page -- which is the difference
   * between a list of your work and a list of links to places your work might
   * be. Each page takes the id as a prop and shows that record when it changes.
   */
  const openItem = useCallback((kind: MemberKind, ref: string): void => {
    if (kind === "chat") {
      void openSession(ref);
      return;
    }
    if (kind === "paper") setOpenPaper(ref);
    if (kind === "review") setOpenReview(ref);
    if (kind === "run") setOpenRun(ref);
    setLookup(false);
    setPage(PAGE_FOR[kind]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projectName = projects.find((p) => p.id === activeProject)?.name ?? "";

  /**
   * Open a project, and work in it.
   *
   * Deliberately one action. Two -- "look at this" and "work in this" -- would
   * be a checkbox nobody ticks, and then the automatic filing would fire for a
   * project the user does not think they are in, which is worse than not
   * filing at all.
   */
  const chooseProject = async (id: string): Promise<void> => {
    setSettings((await window.myra.projectSetActive(id)).settings);
    if (!id) {
      setOpenProject(undefined);
      toChat();
      return;
    }
    setOpenProject(id);
    setPage("projects");
    setLookup(false);
  };

  const makeProject = async (): Promise<void> => {
    const result = await window.myra.projectCreate("Untitled project");
    if (!result.project) return;
    refreshProjects();
    await chooseProject(result.project.id);
  };

  /** Whatever page you were on, a conversation is what you asked for. */
  const toChat = (): void => {
    setPage("chat");
    setLookup(false);
  };

  /** The tour driving navigation, the same way toChat does for one page. */
  const goToTourPage = (p: TourPage): void => {
    setPage(p);
    setLookup(false);
  };

  /*
   * A different conversation is a fresh start, search included.
   *
   * Results outlive the mode switch on purpose -- you look something up, read
   * an answer, come back to the list -- but they must not outlive the
   * conversation, or opening the app to a new chat and clicking Look up shows
   * you a search you have no memory of running.
   */
  const startFresh = (): void => {
    toChat();
    search.clear();
    setQueryDraft("");
  };

  const answer = (id: string, value: string | undefined): void => {
    setPrompt(undefined);
    void window.myra.answerPrompt(id, value);
  };

  return (
    <div
      className={documents.open && page === "chat" && !lookup ? "app with-artifact" : "app"}
      /* The grid reads the width from here rather than the panel styling
         itself, because the panel is a grid TRACK: a width set on the aside
         would be overridden by the column it sits in. */
      style={{ "--artifact-w": `${documents.width}px` } as CSSProperties}
    >
      <aside className="rail">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden="true" />
          MyRA
          <span className="pill">beta</span>
        </div>

        <nav className="rail-nav" aria-label="Sections">
          <RailButton icon="new" label="New conversation" onClick={() => void newSession()} />
          {/* A page, not a panel over the conversation. A meeting has a past --
              the recordings, transcripts and notes of every one you have held --
              and a strip above the thread could only ever show the one you were
              in the middle of. */}
          <RailButton
            icon="meeting"
            label="Meetings"
            active={page === "meetings"}
            tour="rail-meetings"
            onClick={() => setPage((p) => (p === "meetings" ? "chat" : "meetings"))}
          />
          {/* Beside Meetings rather than beside Models: both of these are
              things you make, and the two below describe the machine that
              makes them. */}
          <RailButton
            icon="image"
            label="Images"
            active={page === "images"}
            onClick={() => setPage((p) => (p === "images" ? "chat" : "images"))}
          />
          {/* Beside Images, because it is the third thing you make here. Its
              own page rather than a mode of the conversation: a paper has a
              past, and its notes and drafts have to still be there next week. */}
          <RailButton
            icon="paper"
            label="Paper drafter"
            active={page === "papers"}
            tour="rail-writing"
            /* Plain navigation, not `openItem` -- so any paper opened earlier
               from the rail or a project must not still be sitting in
               `openPaper` for the drafter's next mount to resume. Without this,
               leaving a specific paper and coming back here by the icon (not by
               reopening that paper) silently reopened it instead of showing the
               drafter's own list. */
            onClick={() => {
              setOpenPaper(undefined);
              setPage((p) => (p === "papers" ? "chat" : "papers"));
            }}
          />
          {/* Beside the drafter, because they are the two halves of the same
              job: this app's users write papers and are asked to review them,
              usually in the same week. */}
          <RailButton
            icon="review"
            label="Peer review"
            active={page === "review"}
            tour="rail-writing"
            onClick={() => {
              setOpenReview(undefined);
              setPage((p) => (p === "review" ? "chat" : "review"));
            }}
          />
          {/* The audit trail. Every run already wrote its search log, screening
              reasons, source hashes and verification table; until this existed
              none of it was reachable from anywhere in the app. */}
          <RailButton
            icon="runs"
            label="Research runs"
            active={page === "runs"}
            tour="rail-runs"
            onClick={() => {
              setOpenRun(undefined);
              setPage((p) => (p === "runs" ? "chat" : "runs"));
            }}
          />
          {/* Models are a place you go, not a dialog you open on top of a
              conversation: choosing one means comparing sizes against what this
              machine can hold, which wants the whole width. */}
          <RailButton
            icon="models"
            label="Models"
            active={page === "models"}
            tour="rail-models"
            onClick={() => setPage((p) => (p === "models" ? "chat" : "models"))}
          />
          {/* Below Models, because it serves what Models chose. */}
          <RailButton
            icon="api"
            label="API"
            active={page === "api"}
            onClick={() => setPage((p) => (p === "api" ? "chat" : "api"))}
          />
        </nav>

        {/*
          * Projects sit above the conversations, because they contain them.
          *
          * Opening one makes it active. That is one concept rather than two --
          * you are IN the folder, the way a file manager means it -- and it is
          * what makes the automatic filing predictable: the project you are
          * looking at is the project your next conversation lands in.
          */}
        <nav className="rail-projects" aria-label="Projects" data-tour="rail-projects">
          <RailSection
            label="Projects"
            open={projectsOpen}
            count={projects.length}
            onToggle={toggleProjects}
            onAdd={() => void makeProject()}
            addLabel="New project"
          />
          {!projectsOpen ? null : (
            <>
              <ul className="project-items">
                <li>
                  <button
                    type="button"
                    className={activeProject ? "project-item" : "project-item current"}
                    onClick={() => void chooseProject("")}
                  >
                    <span className="project-item-name">No project</span>
                  </button>
                </li>
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={p.id === activeProject ? "project-item current" : "project-item"}
                      onClick={() => void chooseProject(p.id)}
                      title={`${p.items} ${p.items === 1 ? "item" : "items"}`}
                    >
                      <span className="project-item-name">{p.name}</span>
                      <span className="project-item-count">{p.items}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="project-new" onClick={() => void makeProject()}>
                + New project
              </button>
            </>
          )}
        </nav>

        <SessionList
          {...(sessionId ? { currentId: sessionId } : {})}
          onOpen={openItem}
          onNew={() => void newSession()}
          refreshKey={sessionsKey}
          onChanged={refreshProjects}
          {...(activeProject && projectName
            ? { filter: { name: projectName, id: activeProject } }
            : {})}
        />

        {/* Above Settings and outside the scrolling history, so it is on screen
            on every page and at every length of conversation list. Only off the
            chat page: there the composer already shows both, and two stop
            buttons on one screen is a question about which one is real. */}
        {busy && page !== "chat" ? (
          <WorkingBar
            stage={activeRun?.stage ?? stage}
            note={activeRun?.note ?? progress}
            onOpen={toChat}
            onStop={abort}
          />
        ) : null}

        {/* The long job that is not a chat turn, on EVERY page including this
            one: a panel being written while you carry on talking to the model is
            the case the whole arrangement exists for, and the only sign of it
            used to be a page you had navigated away from. */}
        {job ? (
          <WorkingBar
            label={job.kind === "review" ? "Peer review" : "Drafting"}
            note={job.label || job.title}
            step={job.step}
            steps={job.steps}
            openLabel={job.kind === "review" ? "Open this review" : "Open this paper"}
            onOpen={() => openItem(job.kind === "review" ? "review" : "paper", job.id)}
            onStop={() =>
              void (job.kind === "review"
                ? window.myra.reviewCancel(job.id)
                : window.myra.paperCancel(job.id))
            }
          />
        ) : null}

        <div className="rail-foot">
          <RailButton icon="settings" label="Settings" tour="rail-settings" onClick={() => setShowSettings(true)} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {/*
            * The bar says which model is doing the thing on this screen, so it
            * changes with the screen. On the Images page no chat model is
            * answering and nothing is being spoken, and leaving those three
            * controls up would be three pickers that do nothing beside the one
            * that does.
            */}
          {page === "images" ? (
            <ImagePicker
              settings={settings}
              resident={resident}
              onSettingsChange={setSettings}
              onOpenHub={() => setPage("models")}
            />
          ) : (
            <>
              {/* The one thing that belongs at the top: which model is
                  answering. Everything else moved to the rail or into the
                  composer. */}
              <ModelBar
                settings={settings}
                onSettingsChange={setSettings}
                onOpenSettings={() => setShowSettings(true)}
                onOpenHub={() => setPage("models")}
              />
              {/* The other two models, in the same control as the first.
                  Which model hears you and which one answers aloud are questions
                  of the same kind as which one thinks, and they are asked at the
                  same moment -- while talking, not while in Settings. */}
              <AudioPicker
                role="transcription"
                settings={settings}
                resident={resident}
                onSettingsChange={setSettings}
                onOpenSettings={() => setShowSettings(true)}
              />
              <AudioPicker
                role="voice"
                settings={settings}
                resident={resident}
                onSettingsChange={setSettings}
                onOpenSettings={() => setShowSettings(true)}
              />
            </>
          )}
          {/* The way back. Closing the panel must not be the same as losing the
              document -- it is still on disk and still in this conversation,
              and without this the only route back to it is the file manager. */}
          {documents.docs.length && !documents.open && page === "chat" && !lookup ? (
            <button
              type="button"
              className="chip artifact-chip"
              onClick={() => documents.setOpen(true)}
            >
              {documents.docs.length === 1
                ? documents.docs[0]!.name
                : `${documents.docs.length} documents`}
            </button>
          ) : null}
          {/* Last in the bar, and on every page including Images: a download
              started from the models page carries on regardless of where you
              go next, so the place that reports it has to be somewhere that
              does not change. */}
          <DownloadsButton list={downloads} />
        </header>

        {/*
          * Runs replace the conversation rather than covering it.
          *
          * Reading a run is a task in its own right -- six tabs, source texts,
          * a verification table -- and a modal framed all of that as an
          * interruption to be dismissed, over a thread you could not consult
          * while reading it.
          */}
        {page === "meetings" && settings ? (
          <MeetingsPage settings={settings} onClose={toChat} />
        ) : null}
        {page === "images" && settings ? (
          <ImagePage settings={settings} onSettingsChange={setSettings} onClose={toChat} />
        ) : null}
        {page === "projects" && openProject ? (
          <ProjectsPage
            id={openProject}
            active={openProject === activeProject}
            onClose={toChat}
            onOpenItem={openItem}
            onChanged={refreshProjects}
          />
        ) : null}
        {page === "papers" ? (
          <PaperDrafter
            onClose={toChat}
            dictation={dictation}
            sink={dictationSink}
            {...(openPaper ? { openId: openPaper } : {})}
          />
        ) : null}
        {page === "review" ? (
          <PeerReview
            settings={settings}
            onClose={toChat}
            {...(openReview ? { openId: openReview } : {})}
            onOpenSettings={() => {
              setSettingsTab("review");
              setShowSettings(true);
            }}
            onOpenModels={() => setPage("models")}
          />
        ) : null}
        {page === "runs" ? (
          <RunPanel onClose={toChat} active={activeRun} {...(openRun ? { openId: openRun } : {})} />
        ) : null}
        {/* Its own scroll region at full width: the models page is a browser
            over 228 entries, and `.pane`'s 62ch reading measure -- right for a
            settings form -- turns the catalogue into a single squeezed column
            with nowhere to scroll. */}
        {page === "api" ? (
          <div className="models-page">
            <ApiPage />
          </div>
        ) : null}
        {page === "models" ? (
          <div className="models-page">
            <LemonadePane
              section="models"
              onOpenRuntime={() => {
                setSettingsTab("runtime");
                setShowSettings(true);
              }}
            />
          </div>
        ) : null}

        {page === "chat" && lookup ? (
          <LookupResults
            state={search.state}
            onSort={search.setSort}
            onPage={(n) => void search.goToPage(n)}
          />
        ) : null}

        <div className="thread" hidden={page !== "chat" || lookup}>
          {items.length === 0 ? (
            <div className="welcome">
              <h1>What are you working on?</h1>
              {/* Three sentences rather than three buttons: these are the
                  things MyRA does, and naming them is more use than a row of
                  shortcuts to panels that are already one click away. */}
              <p>
                Ask a question, record a meeting and get it written up, or start a piece of
                research that reads the literature and cites what it found.
              </p>
            </div>
          ) : null}

          {items.map((item) => {
            if (item.kind === "user") {
              return (
                <article key={item.id} className="turn user">
                  {item.attachments?.length ? (
                    <div className="turn-attachments">
                      {item.attachments.map((a, i) => (
                        <span key={i} className="composer-chip dim">
                          {a.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {item.text ? <p>{item.text}</p> : null}
                  <CopyButton className="turn-copy" text={() => item.text} />
                </article>
              );
            }
            if (item.kind === "tool") {
              return <ToolCard key={item.id} item={item} />;
            }
            if (item.kind === "notice") {
              return (
                <p key={item.id} className="notice">
                  {item.text}
                </p>
              );
            }
            return (
              <article key={item.id} className="turn assistant">
                {item.blocks.map((block, i) =>
                  block.kind === "thinking" ? (
                    <Reasoning key={i} text={block.text} streaming={item.streaming ?? false} />
                  ) : (
                    <Markdown key={i} text={block.text} sources={sources} />
                  ),
                )}
                {/* Absent while streaming -- the numbers are not final until
                    the reply is. */}
                {!item.streaming && item.stats ? <MessageStatsLine stats={item.stats} /> : null}
                {/* The answer, not the working-out. Reasoning is deliberately
                    never part of what this conversation keeps, and a copy that
                    swept it into somebody's paper would be the one route by
                    which it escaped that. */}
                <CopyButton
                  className="turn-copy"
                  text={() => answerText(item.blocks)}
                  title="Copy this answer as Markdown"
                />
              </article>
            );
          })}

          {sources.size > 0 ? <SourceList sources={sources} /> : null}
          {error ? (
            <p className="error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="error-close"
                aria-label="Dismiss this error"
                title="Dismiss"
                onClick={dismissError}
              >
                ×
              </button>
            </p>
          ) : null}
          {/* Above the scroll anchor, so the view follows it: a card added
              below the anchor is a card the thread scrolls away from. */}
          {busy && stage ? <ResearchProgress stage={stage} note={progress} /> : null}
          <div ref={bottom} />
        </div>

        {/*
          * The composer owns the controls that change what sending does.
          *
          * Research depth used to sit in the top bar, a whole screen away from
          * the message it governs, which made it read as an app-wide setting
          * rather than a choice about this question. It is neither decoration
          * nor navigation: picking Deep gates the tool set for the very next
          * turn, so it belongs where that turn is written.
          */}
        <footer className="composer" hidden={page !== "chat"}>
          <div
            className={dragOver ? "composer-card over" : "composer-card"}
            data-tour="composer"
            onDragOver={(e) => {
              if (lookup) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (lookup) return;
              for (const file of e.dataTransfer.files) void attachFile(file);
            }}
          >
            {/*
              * What the loop is doing, in one line, whenever it is on.
              *
              * A mode that holds the microphone has to say so continuously
              * rather than at the moment it was switched on -- the composer is
              * where someone's eyes are, and "listening" is the difference
              * between a pause it is waiting through and one it has stopped
              * hearing.
              */}
            {handsFree ? (
              <p className={`s2s-status s2s-${loop.phase}`} role="status">
                <span className={`dot dot-${loop.phase === "listening" ? "ready" : "starting"}`} />
                {loop.phase === "listening"
                  ? dictation.state.silent
                    ? "Listening — say something, or click the wave to stop"
                    : "Listening…"
                  : loop.phase === "thinking"
                    ? "Working on it…"
                    : loop.phase === "speaking"
                      ? speech.state.phase === "thinking"
                        ? "Finding the words…"
                        : "Speaking — talk over it to interrupt"
                      : "Starting…"}
                {loop.error ?? speech.state.error ? (
                  <span className="s2s-error"> {loop.error ?? speech.state.error}</span>
                ) : null}
              </p>
            ) : null}
            {/* A research run draws its own card in the thread above; this line
                is for everything else that reports progress. */}
            {progress && busy && !stage ? <p className="progress">{progress}</p> : null}
            {!lookup && (pendingAttachments.length || attaching) ? (
              <div className="composer-attachments">
                {pendingAttachments.map((att, i) => (
                  <span
                    /* A document attachment carries no id -- it is inlined as
                       text and never written to disk -- so its name alone was
                       the key. Two documents sharing a name (the same file
                       dropped twice, or two files from different folders)
                       collided, letting React reuse one chip's DOM node and
                       remove handler for the other. The index disambiguates
                       within this one render without claiming a stable
                       identity the value does not have. */
                    key={att.kind === "image" ? att.id : `doc-${i}-${att.name}`}
                    className={att.kind === "image" && !att.canSee ? "composer-chip warn" : "composer-chip"}
                    title={att.kind === "image" ? att.warning : `${att.words.toLocaleString()} words`}
                  >
                    {att.name}
                    <button
                      type="button"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => removeAttachment(att)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {attaching ? <span className="composer-chip dim">Reading…</span> : null}
              </div>
            ) : null}
            {!lookup && attachError ? <p className="composer-attach-error">{attachError}</p> : null}
            <textarea
              className="input"
              placeholder={
                lookup
                  ? "Search the literature — no model in the loop"
                  : "Ask a question, or describe what you need — or drop in an image or a paper"
              }
              value={typed}
              rows={1}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                if (lookup) return;
                for (const item of e.clipboardData.items) {
                  const file = item.kind === "file" ? item.getAsFile() : null;
                  if (file) void attachFile(file);
                }
              }}
            />

            <div className="composer-tools">
              <ResearchBar
                lookup={lookup}
                onLookup={() => setLookup(true)}
                onLeaveLookup={() => setLookup(false)}
                /* In the rings' own row, and keyed on the model: the vocabulary
                   it shows belongs to whatever is answering, so it has to be
                   re-asked when that changes. */
                trailing={<ReasoningBar model={settings?.llm.model} />}
              />
              <span className="composer-spacer" />

              {/*
                * Hands-free, as a switch rather than a page.
                *
                * Beside the microphone because it is the same decision one step
                * further: the button records what you say, and this keeps doing
                * it -- listening, answering aloud, and listening again -- until
                * it is switched off. It says which state it is in at all times,
                * because a mode that leaves the microphone open must never be
                * something you can be in without knowing.
                */}
              <button
                type="button"
                className={handsFree ? "mic s2s active" : "mic s2s"}
                aria-pressed={handsFree}
                aria-label={handsFree ? "Leave speech-to-speech" : "Speech-to-speech"}
                title={
                  settings?.audio.voiceModel
                    ? handsFree
                      ? `Speech to speech — ${loop.phase}. Click to stop.`
                      /* Says that answers get shorter, because they do and
                         nothing else would explain it. A reply that is suddenly
                         two sentences long reads as the model having got worse
                         rather than as the mode doing its job. */
                      : "Talk to MyRA: it listens, answers aloud, and listens again. Answers are kept short, because they are spoken."
                    : "Choose a voice first — opens Settings → Audio"
                }
                onClick={() => {
                  /* No voice model means this cannot work, and a toggle that
                     silently does nothing is worse than one that takes you to
                     the thing that is missing. */
                  if (!settings?.audio.voiceModel) {
                    setSettingsTab(undefined);
                    setShowSettings(true);
                    return;
                  }
                  void window.myra
                    .updateSettings({ audio: { ...settings.audio, speechToSpeech: !handsFree } })
                    .then(setSettings);
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 13a4 4 0 0 0 8 0M12 3a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                  <path d="M19 12a7 7 0 0 1-1.2 3.9M5 12a7 7 0 0 0 1.2 3.9" />
                </svg>
              </button>

              {lookup ? null : (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept="image/png,image/jpeg,image/gif,image/bmp,image/webp,.pdf,.docx,.doc,.odt,.rtf,.md,.markdown,.txt"
                    onChange={(e) => {
                      for (const file of e.target.files ?? []) void attachFile(file);
                      // Reset, so choosing the same file twice fires a change event twice.
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="mic"
                    aria-label="Attach an image or a document"
                    title="Attach an image or a document"
                    data-tour="composer-attach"
                    onClick={() => fileInput.current?.click()}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                </>
              )}
              <button
                type="button"
                className={dictation.state.phase === "recording" ? "mic active" : "mic"}
                aria-pressed={dictation.state.phase === "recording"}
                aria-label={dictation.state.phase === "recording" ? "Stop dictation" : "Dictate"}
                title={handsFree ? "Hands-free is holding the microphone" : "Dictate"}
                data-tour="composer-dictate"
                /* One owner of the microphone at a time. In hands-free the loop
                   starts and stops it; a second control doing the same thing
                   would leave a recording nothing is waiting on. */
                disabled={handsFree}
                onClick={() =>
                  void (dictation.state.phase === "recording" ? dictation.stop() : dictation.start())
                }
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                  <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
                </svg>
              </button>
              {lookup ? (
                <button
                  type="button"
                  className="send"
                  onClick={submit}
                  disabled={!typed.trim() || search.state.busy}
                  aria-label="Search"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </button>
              ) : busy ? (
                <button type="button" className="send stop" onClick={abort} aria-label="Stop">
                  <span className="stop-square" />
                </button>
              ) : (
                <button
                  type="button"
                  className="send"
                  onClick={submit}
                  disabled={!draft.trim() && !pendingAttachments.length}
                  aria-label="Send"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </footer>

        <div className="statusbar" hidden={page !== "chat" || lookup}>
          <ContextMeter usage={usage} />
        </div>
      </main>

      {/* Beside the conversation, and only on the conversation: a document
          written here has nothing to say about the meetings page or the model
          hub, and would just be taking a third of those. */}
      {documents.open && page === "chat" && !lookup ? (
        <ArtifactPanel
          onResize={documents.setWidth}
          docs={documents.docs}
          active={documents.active}
          onSelect={documents.setActive}
          onClose={() => documents.setOpen(false)}
        />
      ) : null}

      {/* Bottom right, over everything, dismissable per download. Closing one
          does not stop it -- it moves to the counter in the bar above. */}
      <DownloadToast list={downloads} />

      <DictationHud
        state={dictation.state}
        onStop={() => void dictation.stop()}
        onCancel={() => void dictation.cancel()}
      />

      {/* Over everything, including the composer: there is nothing useful to do
          in the app until this has been answered once. */}
      {settings && !settings.setupCompleted ? (
        <FirstRun
          onDone={() => {
            setSettings({ ...settings, setupCompleted: true });
            void window.myra.updateSettings({ setupCompleted: true });
          }}
        />
      ) : null}

      {/* Chained off FirstRun rather than gated on it directly: setup can be
          skipped and dismissed in one click, and the tour still has something
          to show regardless of whether a local engine got installed. Also
          reachable from Settings -> About, which resets `seenTutorial` and
          closes itself -- the same optimistic-set-then-IPC pattern as above. */}
      {settings && settings.setupCompleted && !settings.seenTutorial ? (
        <Tour
          page={page}
          onGoTo={goToTourPage}
          onDone={() => {
            setSettings({ ...settings, seenTutorial: true });
            void window.myra.updateSettings({ seenTutorial: true });
          }}
        />
      ) : null}

      {showSettings ? (
        <SettingsModal
          onClose={() => {
            setShowSettings(false);
            setSettingsTab(undefined);
          }}
          {...(settingsTab ? { initialTab: settingsTab } : {})}
          onChange={setSettings}
          onOpenHub={() => {
            setShowSettings(false);
            setSettingsTab(undefined);
            setPage("models");
          }}
        />
      ) : null}
      {prompt ? <UiDialog request={prompt} onAnswer={answer} /> : null}
    </div>
  );
}

/**
 * The bibliography under a thread.
 *
 * Every [n] in the prose is a link into this list, and the list is built only
 * from sources a tool actually returned -- a marker the model invented resolves
 * to nothing and stays literal text, which is the honest outcome.
 */
function SourceList({ sources }: { sources: Map<number, CitedSource> }) {
  const ordered = [...sources.values()].sort((a, b) => a.n - b.n);
  return (
    <section className="sources" aria-label="Sources">
      <h2>Sources</h2>
      <ol className="source-list">
        {ordered.map((s) => (
          <li key={s.n} id={`source-${s.n}`} value={s.n}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              {s.title || s.url}
            </a>
            {s.venue || s.year ? (
              <span className="source-venue">
                {[s.venue, s.year].filter(Boolean).join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
