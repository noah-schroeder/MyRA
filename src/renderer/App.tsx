import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "./useAgent.ts";
import { Markdown } from "./components/Markdown.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { Reasoning } from "./components/Reasoning.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { RailButton } from "./components/Rail.tsx";
import { ModelBar } from "./components/ModelBar.tsx";
import { ResearchBar } from "./components/ResearchBar.tsx";
import { MeetingPanel } from "./components/MeetingPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { RunPanel } from "./components/RunPanel.tsx";
import { ModelHub } from "./components/ModelHub.tsx";
import { ContextMeter } from "./components/ContextMeter.tsx";
import { LookupResults } from "./components/LookupResults.tsx";
import { useLookup } from "./useLookup.ts";
import { UiDialog } from "./components/UiDialog.tsx";
import { enumerate } from "./capture.ts";
import { useDictation } from "./useDictation.ts";
import { DictationHud } from "./components/DictationHud.tsx";
import { restoreThread, type StoredMessage } from "./restore.ts";
import type { CitedSource, PromptRequest, Settings } from "./types.ts";

/** Runs and Models are places you go; the conversation is where you come back to. */
type Page = "chat" | "runs" | "models";

export function App() {
  const { items, busy, usage, error, sources, send, abort, reset } = useAgent();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
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
  const [prompt, setPrompt] = useState<PromptRequest | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
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
    // Enumerating once at startup is what gives the main process a device list
    // to validate meeting tracks against; only the renderer can produce one.
    void enumerate().catch(() => undefined);
  }, []);

  useEffect(() => window.karen.onPrompt(setPrompt), []);
  useEffect(() => window.karen.onResearchProgress(setProgress), []);

  // Read through a ref because transcription lands long after the callback was
  // made, and it has to reach whichever box is in front of you then.
  const lookupRef = useRef(lookup);
  useEffect(() => {
    lookupRef.current = lookup;
  }, [lookup]);

  // Appended rather than replacing: dictation is for adding to what you were
  // already writing, and overwriting a half-typed question would be a bad way
  // to find that out.
  const dictation = useDictation(
    useCallback((text: string) => {
      const set = lookupRef.current ? setQueryDraft : setDraft;
      set((d) => (d ? `${d} ${text}` : text));
    }, []),
  );

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
    void send(text);
  }, [typed, busy, send, lookup, search]);

  const openSession = async (id: string): Promise<void> => {
    const messages = (await window.karen.openSession(id)) as StoredMessage[];
    setSessionId(id);
    toChat();
    // The stored form is the model's message list; this view wants cards in the
    // order they happened, each knowing its own outcome. restoreThread does
    // that conversion, including reuniting each tool call with the result that
    // arrived as a separate message, and recovering the sources so the [n]
    // markers in the restored prose still resolve.
    const { items: restored, sources: restoredSources } = restoreThread(messages);
    reset(restored, restoredSources);
  };

  const newSession = async (): Promise<void> => {
    setSessionId(await window.karen.newSession());
    reset();
    toChat();
  };

  /** Whatever page you were on, a conversation is what you asked for. */
  const toChat = (): void => {
    setPage("chat");
    setLookup(false);
  };

  const answer = (id: string, value: string | undefined): void => {
    setPrompt(undefined);
    void window.karen.answerPrompt(id, value);
  };

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-brand">
          <span className="rail-mark" aria-hidden="true" />
          Karen
        </div>

        <nav className="rail-nav" aria-label="Sections">
          <RailButton icon="new" label="New conversation" onClick={() => void newSession()} />
          <RailButton
            icon="meeting"
            label="Meeting"
            active={showMeeting}
            onClick={() => {
              // The meeting panel sits over the conversation, so asking for it
              // from another page means asking to go back to the conversation.
              setShowMeeting((v) => !v);
              setPage("chat");
            }}
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
          {/* The one thing that belongs at the top: which model is answering.
              Everything else moved to the rail or into the composer. */}
          <ModelBar
            settings={settings}
            onOpenSettings={() => setShowSettings(true)}
            onOpenHub={() => setPage("models")}
          />
        </header>

        {page === "chat" && showMeeting && settings ? <MeetingPanel settings={settings} /> : null}

        {/*
          * Runs replace the conversation rather than covering it.
          *
          * Reading a run is a task in its own right -- six tabs, source texts,
          * a verification table -- and a modal framed all of that as an
          * interruption to be dismissed, over a thread you could not consult
          * while reading it.
          */}
        {page === "runs" ? <RunPanel onClose={toChat} /> : null}
        {page === "models" ? <ModelHub onClose={toChat} /> : null}

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
              </article>
            );
          })}

          {sources.size > 0 ? <SourceList sources={sources} /> : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
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
            {progress && busy ? <p className="progress">{progress}</p> : null}
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
              />
              <span className="composer-spacer" />
              <button
                type="button"
                className={dictation.state.phase === "recording" ? "mic active" : "mic"}
                aria-pressed={dictation.state.phase === "recording"}
                aria-label={dictation.state.phase === "recording" ? "Stop dictation" : "Dictate"}
                title="Dictate"
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

      <DictationHud
        state={dictation.state}
        onStop={() => void dictation.stop()}
        onCancel={() => void dictation.cancel()}
      />

      {showSettings ? (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onChange={setSettings}
          onOpenHub={() => {
            setShowSettings(false);
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
              <span className="source-meta">
                {[s.venue, s.year].filter(Boolean).join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
