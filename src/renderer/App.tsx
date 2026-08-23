import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "./useAgent.ts";
import { Markdown } from "./components/Markdown.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { Reasoning } from "./components/Reasoning.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { ResearchBar } from "./components/ResearchBar.tsx";
import { MeetingPanel } from "./components/MeetingPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { UiDialog } from "./components/UiDialog.tsx";
import { enumerate } from "./capture.ts";
import type { CitedSource, PromptRequest, Settings } from "./types.ts";

export function App() {
  const { items, busy, usage, error, sources, send, abort, reset, setError } = useAgent();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
  const [prompt, setPrompt] = useState<PromptRequest | undefined>();
  const [progress, setProgress] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionsKey, setSessionsKey] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.karen.getSettings().then(setSettings);
    // Enumerating once at startup is what gives the main process a device list
    // to validate meeting tracks against; only the renderer can produce one.
    void enumerate().catch(() => undefined);
  }, []);

  useEffect(() => window.karen.onPrompt(setPrompt), []);
  useEffect(() => window.karen.onResearchProgress(setProgress), []);
  useEffect(() => window.karen.onDictationText((text) => setDraft((d) => (d ? `${d} ${text}` : text))), []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length]);

  useEffect(() => {
    if (!busy) setSessionsKey((k) => k + 1);
  }, [busy]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text);
  }, [draft, busy, send]);

  const openSession = async (id: string): Promise<void> => {
    await window.karen.openSession(id);
    setSessionId(id);
    // The stored conversation is the model's message list, not this view's item
    // list. Rebuilding one from the other faithfully is a job in itself, so for
    // now reopening starts a clean view over the same history rather than
    // pretending to reconstruct the tool cards.
    reset();
  };

  const newSession = async (): Promise<void> => {
    setSessionId(await window.karen.newSession());
    reset();
  };

  const answer = (id: string, value: string | undefined): void => {
    setPrompt(undefined);
    void window.karen.answerPrompt(id, value);
  };

  return (
    <div className="app">
      <aside className="rail">
        <SessionList
          {...(sessionId ? { currentId: sessionId } : {})}
          onOpen={(id) => void openSession(id)}
          onNew={() => void newSession()}
          refreshKey={sessionsKey}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <ResearchBar onNotice={setError} />
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className={showMeeting ? "chip active" : "chip"}
              aria-pressed={showMeeting}
              onClick={() => setShowMeeting((v) => !v)}
            >
              Meeting
            </button>
            <button type="button" className="chip" onClick={() => setShowSettings(true)}>
              Settings
            </button>
          </div>
        </header>

        {showMeeting && settings ? <MeetingPanel settings={settings} /> : null}

        <div className="thread">
          {items.length === 0 ? (
            <p className="empty">
              Ask a question, record a meeting, or start a piece of research.
            </p>
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

        <footer className="composer">
          {progress && busy ? <p className="progress">{progress}</p> : null}
          <textarea
            className="input"
            placeholder="Ask something…"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="stop" onClick={abort}>
              Stop
            </button>
          ) : (
            <button type="button" className="primary" onClick={submit} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </footer>

        {usage ? (
          <div className="statusbar">
            <span>
              {usage.total.toLocaleString()} tokens this conversation
            </span>
          </div>
        ) : null}
      </main>

      {showSettings ? <SettingsModal onClose={() => setShowSettings(false)} /> : null}
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
