import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "./useAgent.ts";
import { ToolCard } from "./components/ToolCard.tsx";
import { ApprovalDialog } from "./components/ApprovalDialog.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { DictationHud } from "./components/DictationHud.tsx";
import { MeetingPanel } from "./components/MeetingPanel.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Reasoning } from "./components/Reasoning.tsx";
import { ReviewQueue } from "./components/ReviewQueue.tsx";
import { ResearchBar } from "./components/ResearchBar.tsx";
import { UiDialog } from "./components/UiDialog.tsx";
import { SessionList } from "./components/SessionList.tsx";
import type {
  ApprovalReq, AssistantItem, DictationState, MeetingState, ResearchConfig, SessionSummary, Status, UiRequest,
} from "./types.ts";

const MODES = ["manual", "guarded", "yolo"] as const;
const MODE_LABEL: Record<string, string> = { manual: "Manual", guarded: "Guarded", yolo: "YOLO" };
/** The stored form is SearXNG's comma list; humans want it spaced and joined. */
function categoryLabel(value: string): string {
  const names = value.split(",").map((c) => c.trim()).filter(Boolean);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const MODE_HINT: Record<string, string> = {
  manual: "Manual — every tool call asks first.",
  guarded: "Guarded — reads and writes inside Karen's own workspace run unattended; anything destructive still asks.",
  yolo: "YOLO — tools run unattended. Destructive commands and your tasks, calendar, contacts and clipboard still ask.",
};

export function App() {
  const { items, busy, usage, error, sources, send, abort, reset, openSession } = useAgent();
  const [status, setStatus] = useState<Status | undefined>();
  const [approval, setApproval] = useState<ApprovalReq | undefined>();
  const [showSettings, setShowSettings] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [dictation, setDictation] = useState<DictationState>({ phase: "idle", elapsedMs: 0, level: 0 });
  const [meeting, setMeeting] = useState<MeetingState>({ phase: "idle" });
  const [draft, setDraft] = useState("");
  const [models, setModels] = useState<{ id: string; provider: string; name?: string }[]>([]);
  const [current, setCurrent] = useState("");
  const [modelError, setModelError] = useState<string | undefined>();
  const [research, setResearch] = useState<ResearchConfig>({ mode: "off", category: "general" });
  const [uiRequest, setUiRequest] = useState<UiRequest | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [railOpen, setRailOpen] = useState(true);
  const [activeSession, setActiveSession] = useState<string | undefined>();
  // Bumped whenever the list on disk may have changed, so the rail reloads
  // rather than showing a chat that has since been renamed or replaced.
  const [sessionsKey, setSessionsKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Load the list of models. Deliberately dependency-free.
   *
   * Anything captured here would change this callback's identity, refire the
   * effect below, and let a refresh overwrite whatever the user just picked.
   * The selection is only ever SEEDED here, never replaced.
   */
  const refreshModels = useCallback(async () => {
    try {
      const res = (await window.karen.getModels()) as {
        models?: { id: string; provider: string; name?: string }[];
        credentialsMissing?: boolean;
      };
      const list = res?.models ?? [];
      setModels(list);
      // A configured catalogue that pi cannot see means the API key never
      // reached it -- worth saying plainly, because the failure it causes
      // otherwise reads as "Model not found".
      setModelError(
        list.length === 0
          ? "No models configured — open Settings and test your endpoint."
          : res?.credentialsMissing
            ? "Models are configured but the endpoint key has not reached the agent. Re-enter it in Settings."
            : undefined,
      );
      const first = list[0];
      setCurrent((prev) => prev || (first ? `${first.provider}/${first.id}` : ""));
    } catch (err) {
      setModelError((err as Error).message);
    }
  }, []);

  /**
   * Adopt whatever model pi actually has active.
   *
   * Only ever sets a concrete value: if pi cannot be asked (mid-restart, say),
   * the existing selection stands. Falling back to list[0] on failure is what
   * made the dropdown snap back to the first entry.
   */
  const syncActiveModel = useCallback(async () => {
    try {
      const st = (await window.karen.getModelState()) as { model?: { id: string; provider: string } };
      if (st?.model?.id && st.model.id !== "unknown") {
        setCurrent(`${st.model.provider}/${st.model.id}`);
      }
    } catch { /* keep the current selection */ }
  }, []);

  /**
   * Answer pi's blocking UI requests.
   *
   * `editor`, `input`, `select` and `confirm` suspend the extension until a
   * response arrives, so leaving these unhandled would not degrade gracefully —
   * the agent would simply stop. Everything else is fire-and-forget.
   */
  useEffect(() => {
    const off = window.karen.onRpcEvent((frame: { type?: string } & Record<string, unknown>) => {
      if (frame?.type !== "extension_ui_request") return;
      const req = frame as unknown as UiRequest;
      if (["select", "confirm", "input", "editor"].includes(req.method)) {
        setUiRequest(req);
        return;
      }
      if (req.method === "notify" && typeof req.message === "string") setNotice(req.message);
    });
    return off;
  }, []);

  /*
   * Dictated text is APPENDED to whatever is in the composer, never substituted
   * for it. Someone who typed half a sentence and then reached for the hotkey
   * meant to add to it; replacing their text would lose work with no undo.
   */
  useEffect(() => {
    const offMeeting = window.karen.onMeeting(setMeeting);
    void window.karen.meetingState().then(setMeeting);
    const offState = window.karen.onDictation(setDictation);
    const offText = window.karen.onDictationText((text) => {
      setDraft((prev) => {
        const trimmed = text.trim();
        if (!trimmed) return prev;
        const next = prev.trim() ? `${prev.replace(/\s+$/, "")} ${trimmed}` : trimmed;
        // Give the box its height back and put the caret at the end.
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.style.height = "auto";
          ta.style.height = `${Math.min(ta.scrollHeight, 190)}px`;
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        });
        return next;
      });
    });
    void window.karen.dictationState().then(setDictation);
    return () => { offState(); offText(); offMeeting(); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 6_000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    void window.karen.getStatus().then((s) => {
      setStatus(s);
      if (s.research) setResearch(s.research);
    });
    const offStatus = window.karen.onStatus(setStatus);
    const offApproval = window.karen.onApprovalRequest(setApproval);
    const offModels = window.karen.onModelsChanged(() => { void refreshModels(); });
    return () => { offStatus(); offApproval(); offModels(); };
  }, [refreshModels]);

  // Fires only on (re)connect and when Settings closes -- both callbacks have
  // stable identity, so this cannot loop.
  useEffect(() => {
    if (!status?.bridgeConnected) return;
    void refreshModels().then(syncActiveModel);
  }, [status?.bridgeConnected, showSettings, refreshModels, syncActiveModel]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  // A finished turn is the moment a new chat exists on disk with a real title.
  useEffect(() => {
    if (!busy) setSessionsKey((k) => k + 1);
  }, [busy]);

  const submit = () => {
    if (!draft.trim()) return;
    // The button composes the invocation; the user never types a directive.
    // Deep research is a pipeline rather than an answer, so it is asked for
    // explicitly -- tool gating already guarantees no other search tool exists,
    // and this makes sure the question reaches it unparaphrased.
    const text =
      research.mode === "deep"
        ? `Run deep_research with this question, exactly as written, and present its report ` +
          `verbatim:\n\n${draft.trim()}`
        : draft;
    // Show what the user wrote; send what the agent needs.
    void send(text, busy, draft.trim());
    setDraft("");
    requestAnimationFrame(() => { if (taRef.current) taRef.current.style.height = "auto"; });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const switchModel = async (value: string) => {
    setCurrent(value); // optimistic, so the control responds immediately
    const [provider, ...rest] = value.split("/");
    // Model ids routinely contain slashes (org/name), so only the FIRST segment
    // is the provider and everything after it is the id.
    if (!provider || rest.length === 0) return;
    await window.karen.rpc({ type: "set_model", provider, modelId: rest.join("/") });
    // Confirm from pi: if the switch was rejected, the dropdown must not keep
    // claiming a model that is not in use.
    await syncActiveModel();
  };

  const applyResearch = (next: ResearchConfig) => {
    setResearch(next); // optimistic: the control must feel immediate
    void window.karen.setResearch(next);
  };

  const mode = status?.mode ?? "guarded";

  /**
   * Configuration problems, as sentences in the chat area.
   *
   * They used to be bordered banners between the header and the body. That was
   * wrong twice over: the app is a three-row grid, so a conditional banner took
   * the row the transcript needed and squashed the whole conversation into
   * whatever was left — and a box with a border reads as something to dismiss
   * rather than something to fix.
   */
  const notices = [notice, modelError && models.length > 0 ? modelError : undefined].filter(
    (text): text is string => Boolean(text),
  );
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><span className="brand-dot" />Karen</div>

        <select className="select" value={current} onChange={(e) => void switchModel(e.target.value)}
          disabled={!models.length} title={modelError ?? "Model"}>
          {models.length === 0 ? <option value="">no models — open Settings</option> : null}
          {[...models]
            .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
            .map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name ?? m.id}
              </option>
            ))}
        </select>

        <select className="select" value={mode} onChange={(e) => void window.karen.setMode(e.target.value)}>
          {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>

        <button className="btn btn-ghost" title="Reload model list" onClick={() => void refreshModels()}>⟳</button>

        <div className="spacer" />

        <span className={`pill ${status?.bridgeConnected ? "on" : "off"}`}>
          <span className="pill-dot" />{status?.bridgeConnected ? "VM connected" : "VM offline"}
        </span>

        {busy && research.mode === "deep" ? (
          <button
            className="btn"
            title="Finish the current stage, then stop. Everything done so far is kept and can be resumed."
            onClick={() => void window.karen.pauseResearch()}
          >
            Pause
          </button>
        ) : null}
        {busy ? <button className="btn btn-danger" onClick={() => void abort()}>Stop</button> : null}
        <button
          className="btn btn-ghost"
          onClick={() => { setActiveSession(undefined); void reset(); }}
        >
          New
        </button>
        <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>Settings</button>
      </div>

      {mode === "yolo" ? (
        <div className="yolo-banner">
          <strong>YOLO</strong>
          <span>
            Tools run without asking. Destructive commands and anything touching your tasks,
            calendar, contacts or clipboard still require approval — that cannot be turned off.
          </span>
        </div>
      ) : null}

      <div className="body">
      <SessionList
        open={railOpen}
        onToggle={() => setRailOpen((v) => !v)}
        {...(activeSession ? { activeId: activeSession } : {})}
        refreshKey={sessionsKey}
        connected={status?.bridgeConnected ?? false}
        onOpenSession={(s: SessionSummary) => {
          setActiveSession(s.id);
          void openSession(s.path);
        }}
        onDeleted={(id: string) => {
          if (id !== activeSession) return;
          setActiveSession(undefined);
          void reset();
        }}
      />
      <div className="main">
      <div className="scroll" ref={scrollRef}>
        {items.length === 0 ? (
          <div className="empty">
            <div className="empty-title">
              {status?.bridgeConnected ? "Ready." : "Waiting for the VM bridge…"}
            </div>
            <div>
              {status?.bridgeConnected
                ? "Ask a question, or give it something to do."
                : "Start karen-bridge inside the VM. It dials this app; nothing needs to reach in."}
            </div>
            {/* Configuration problems belong where the user is already looking,
                as a sentence rather than as a box demanding to be dismissed. */}
            {notices.map((text) => (
              <div key={text} className="empty-notice">{text}</div>
            ))}
          </div>
        ) : (
          <div className="thread">
            {notices.map((text) => (
              <div key={text} className="thread-notice">{text}</div>
            ))}
            {items.map((it) => {
              if (it.kind === "user") {
                return (
                  <div key={it.id} className="msg msg-user">
                    <div className="msg-role">you</div>
                    <div className="msg-body">{it.text}</div>
                  </div>
                );
              }
              if (it.kind === "tool") return <ToolCard key={it.id} item={it} />;

              const a = it as AssistantItem;
              const blocks = [...a.blocks.entries()].sort((x, y) => x[0] - y[0]);
              return (
                <div key={a.id} className="msg">
                  <div className="msg-role">karen</div>
                  {blocks.map(([i, b], n) =>
                    b.kind === "thinking" ? (
                      <Reasoning key={i} text={b.text} streaming={!a.done && n === blocks.length - 1} />
                    ) : (
                      <div key={i} className="msg-body">
                        <Markdown text={b.text} sources={sources} />
                        {!a.done && n === blocks.length - 1 ? <span className="cursor" /> : null}
                      </div>
                    ),
                  )}
                  {blocks.length === 0 && !a.done ? <span className="cursor" /> : null}
                </div>
              );
            })}
            {error ? <div className="warn">{error}</div> : null}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          <MeetingPanel state={meeting} />
          <DictationHud
            state={dictation}
            {...(status?.settings.dictationHotkey ? { hotkey: status.settings.dictationHotkey } : {})}
            onStop={() => void window.karen.dictationToggle()}
            onCancel={() => void window.karen.dictationCancel()}
          />
          <ResearchBar
            value={research}
            connected={status?.bridgeConnected ?? false}
            onChange={applyResearch}
            trailing={
              <span className={`pill mode-${mode}`} title={MODE_HINT[mode]}>
                <span className="pill-dot" />{MODE_LABEL[mode]}
              </span>
            }
          />
          <div className="composer-box">
            <textarea
              ref={taRef}
              className="textarea"
              rows={1}
              placeholder={
                busy
                  ? "Steer the agent while it works…"
                  : research.mode === "deep"
                    ? `Deep research across ${categoryLabel(research.category)}…`
                    : research.mode === "web"
                      ? `Ask Karen — searching ${categoryLabel(research.category)}…`
                      : "Ask Karen…"
              }
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 190)}px`;
              }}
              onKeyDown={onKeyDown}
            />
            <button className="btn btn-primary" onClick={submit} disabled={!draft.trim()}>
              {busy ? "Steer" : "Send"}
            </button>
          </div>
          <div className="composer-hint">
            <span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
            <span>{usage ? `${usage.totalTokens.toLocaleString()} tokens` : ""}</span>
          </div>
        </div>
      </div>

      </div>
      </div>

      <div className="statusbar">
        <span>{status?.bridgeConnected ? "bridge ▲" : "bridge ▽"}</span>
        <span>mode {mode}</span>
        {status?.vault.usable === false ? <span style={{ color: "var(--amber)" }}>keyring unavailable</span> : null}
        <div className="spacer" />
        {status?.reviewQueue.length ? (
          <button className="statusbar-action" onClick={() => setShowReview(true)}>
            {status.reviewQueue.length} awaiting review
          </button>
        ) : null}
        <span>egress: allowlist enforced</span>
      </div>

      {showReview ? (
        <ReviewQueue queue={status?.reviewQueue ?? []} onClose={() => setShowReview(false)} />
      ) : null}

      {uiRequest ? (
        <UiDialog
          req={uiRequest}
          onRespond={(response) => {
            void window.karen.rpc({
              type: "extension_ui_response", id: uiRequest.id, ...response,
            });
            setUiRequest(undefined);
          }}
        />
      ) : null}

      {approval ? (
        <ApprovalDialog
          req={approval}
          onRespond={(allowed, alwaysAllowVerb) => {
            void window.karen.respondToApproval(
              approval.id, allowed, alwaysAllowVerb ? { alwaysAllowVerb } : undefined,
            );
            setApproval(undefined);
          }}
        />
      ) : null}

      {showSettings && status ? (
        <SettingsModal
          status={status}
          onClose={() => setShowSettings(false)}
          onSessionsCleared={() => {
            // Everything on screen refers to chats that no longer exist: drop
            // the selection, reload the rail, and start a fresh session so the
            // transcript is not backed by a deleted file.
            setActiveSession(undefined);
            setSessionsKey((k) => k + 1);
            void reset();
          }}
        />
      ) : null}
    </div>
  );
}
