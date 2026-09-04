import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAgent } from "./useAgent.ts";
import { answerText } from "./components/turnText.ts";
import { CopyButton } from "./components/CopyButton.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { ArtifactPanel, useDocuments } from "./components/ArtifactPanel.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { Reasoning } from "./components/Reasoning.tsx";
import { ResearchProgress } from "./components/ResearchProgress.tsx";
import { ApiPage } from "./components/ApiPage.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { RailButton } from "./components/Rail.tsx";
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
import { enumerate } from "./capture.ts";
import { useDictation } from "./useDictation.ts";
import { useSpeech } from "./useSpeech.ts";
import { useHandsFree } from "./useHandsFree.ts";
import { DictationHud } from "./components/DictationHud.tsx";
import { ImagePage } from "./components/ImagePage.tsx";
import { ImagePicker } from "./components/ImagePicker.tsx";
import { restoreThread, type StoredMessage } from "./restore.ts";
import type { CitedSource, PromptRequest, RuntimeState, Settings } from "./types.ts";

/** Runs and Models are places you go; the conversation is where you come back to. */
type Page = "chat" | "runs" | "models" | "meetings" | "images" | "api";

export function App() {
  const { items, busy, usage, error, sources, send, abort, reset, dismissError } = useAgent();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  /* Which tab Settings opens on, when something sent you there for a reason. */
  const [settingsTab, setSettingsTab] = useState<"runtime" | undefined>();
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
     these are what Karen made while you watched, not a file browser. */
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
  const [sessionId, setSessionId] = useState<string | undefined>();
  // Searching the literature yourself is a mode of the composer, not a window
  // over it: the box you type in is the same box either way, and what changes
  // is who reads what you typed.
  const [lookup, setLookup] = useState(false);
  const search = useLookup();
  const [sessionsKey, setSessionsKey] = useState(0);
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
    void window.karen.getSettings().then(setSettings);
    /* And whenever the main process changes them itself. Loading a local model
       stands down a hosted choice, and without this the bar goes on naming a
       model the next message will not be sent to. */
    const stop = window.karen.onSettings(setSettings);
    // Enumerating once at startup is what gives the main process a device list
    // to validate meeting tracks against; only the renderer can produce one.
    void enumerate().catch(() => undefined);
    return stop;
  }, []);

  useEffect(() => window.karen.onPrompt(setPrompt), []);
  /* What the daemon is holding, for the three pickers in the bar above: each
     says "None selected" unless the model it names is actually in memory. */
  const [resident, setResident] = useState<string[]>([]);
  useEffect(() => {
    const take = (r: RuntimeState): void => setResident(r.lemonade.resident ?? []);
    void window.karen.runtimeState().then(take);
    return window.karen.onRuntime(take);
  }, []);

  useEffect(() => window.karen.onResearchProgress(setProgress), []);
  /* An empty stage means the run is over: the card comes down, and the plain
     progress line takes over again for whatever the turn does next. */
  useEffect(() => window.karen.onResearchStage((s) => setStage(s || undefined)), []);
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
   * and never reads out something Karen then contradicts.
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

  const submit = useCallback(() => {
    const text = typed.trim();
    if (!text) return;
    // A query stays in the box: you refine a search by editing it, and clearing
    // it after every Enter would mean retyping the whole thing to change a word.
    if (lookup) {
      void search.run(text);
      return;
    }
    if (busy) return;
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
    void send(text);
  }, [typed, busy, send, lookup, search]);

  const openSession = async (id: string): Promise<void> => {
    const messages = (await window.karen.openSession(id)) as StoredMessage[];
    setSessionId(id);
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
    setSessionId(await window.karen.newSession());
    reset();
    documents.reset();
    startFresh();
  };

  /** Whatever page you were on, a conversation is what you asked for. */
  const toChat = (): void => {
    setPage("chat");
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
    void window.karen.answerPrompt(id, value);
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
          Karen
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
          {/* The audit trail. Every run already wrote its search log, screening
              reasons, source hashes and verification table; until this existed
              none of it was reachable from anywhere in the app. */}
          <RailButton
            icon="runs"
            label="Research runs"
            active={page === "runs"}
            onClick={() => setPage((p) => (p === "runs" ? "chat" : "runs"))}
          />
          {/* Models are a place you go, not a dialog you open on top of a
              conversation: choosing one means comparing sizes against what this
              machine can hold, which wants the whole width. */}
          <RailButton
            icon="models"
            label="Models"
            active={page === "models"}
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

        <SessionList
          {...(sessionId ? { currentId: sessionId } : {})}
          onOpen={(id) => void openSession(id)}
          onNew={() => void newSession()}
          refreshKey={sessionsKey}
        />

        <div className="rail-foot">
          <RailButton icon="settings" label="Settings" onClick={() => setShowSettings(true)} />
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
        {page === "runs" ? <RunPanel onClose={toChat} /> : null}
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
                  things Karen does, and naming them is more use than a row of
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
                  <p>{item.text}</p>
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
          <div className="composer-card">
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
            <textarea
              className="input"
              placeholder={
                lookup
                  ? "Search the literature — no model in the loop"
                  : "Ask a question, or describe what you need"
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
                      : "Talk to Karen: it listens, answers aloud, and listens again. Answers are kept short, because they are spoken."
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
                  void window.karen
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

              <button
                type="button"
                className={dictation.state.phase === "recording" ? "mic active" : "mic"}
                aria-pressed={dictation.state.phase === "recording"}
                aria-label={dictation.state.phase === "recording" ? "Stop dictation" : "Dictate"}
                title={handsFree ? "Hands-free is holding the microphone" : "Dictate"}
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
                  disabled={!draft.trim()}
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
            void window.karen.updateSettings({ setupCompleted: true });
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
