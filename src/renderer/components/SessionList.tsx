import { useEffect, useState } from "react";
import type { SessionSummary } from "../types.ts";

/**
 * The conversation history rail.
 *
 * Collapsible because it is a navigation aid, not the interface: the chat is
 * the point, and a permanently docked list of old chats narrows it for no
 * reason on the days you never look at one.
 *
 * Deleting asks first, and says what else goes with it. A chat that started a
 * research run owns that run's retrieved sources and report, so "delete" has to
 * name the consequence rather than discover it afterwards.
 */
export function SessionList({
  open,
  onToggle,
  activeId,
  onOpenSession,
  onDeleted,
  refreshKey,
  connected,
}: {
  open: boolean;
  onToggle: () => void;
  activeId?: string;
  onOpenSession: (session: SessionSummary) => void;
  onDeleted: (id: string) => void;
  refreshKey: number;
  /** Sessions live in the VM, so there is nothing to list until it answers. */
  connected: boolean;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await window.karen.listSessions();
      setSessions(res?.sessions ?? []);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Gated on the bridge: asking before it connects raises "the VM bridge is not
  // connected", which is a state to wait through, not an error to show.
  useEffect(() => {
    if (open && connected) void load();
  }, [open, connected, refreshKey]);

  const remove = async (s: SessionSummary) => {
    setBusy(true);
    try {
      await window.karen.deleteSession(s.id);
      setConfirming(undefined);
      await load();
      // Deleting the chat you are reading leaves the transcript on screen with
      // no file behind it, so the parent has to clear it.
      onDeleted(s.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="rail-toggle" onClick={onToggle} title="Show past chats" aria-label="Show past chats">
        ☰
      </button>
    );
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">Chats</span>
        <button className="btn btn-ghost" onClick={() => void load()} title="Refresh">⟳</button>
        <button className="btn btn-ghost" onClick={onToggle} title="Hide">←</button>
      </div>

      {error ? <div className="warn rail-warn">{error}</div> : null}

      <div className="rail-list">
        {!connected ? (
          <div className="rail-empty">Waiting for the VM…</div>
        ) : sessions.length === 0 && !error ? (
          <div className="rail-empty">No past chats yet.</div>
        ) : null}

        {sessions.map((s) => (
          <div key={s.id} className={`rail-item${s.id === activeId ? " active" : ""}`}>
            <button className="rail-item-main" onClick={() => onOpenSession(s)} title={s.title}>
              <span className="rail-item-title">{s.title}</span>
              <span className="rail-item-meta">
                {new Date(s.updatedAt || s.at).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                })}
                {s.messages ? ` · ${s.messages} msg` : ""}
                {s.runs.length ? ` · ${s.runs.length} research run${s.runs.length > 1 ? "s" : ""}` : ""}
              </span>
            </button>
            <button
              className="rail-item-del"
              title="Delete this chat"
              aria-label={`Delete ${s.title}`}
              onClick={() => setConfirming(s.id)}
            >
              ✕
            </button>

            {confirming === s.id ? (
              <div className="rail-confirm">
                <span>
                  Delete this chat
                  {s.runs.length
                    ? ` and ${s.runs.length} research run${s.runs.length > 1 ? "s" : ""} it started`
                    : ""}
                  ? This cannot be undone.
                </span>
                <div className="rail-confirm-actions">
                  <button className="btn btn-ghost" onClick={() => setConfirming(undefined)}>Cancel</button>
                  <button className="btn btn-danger" disabled={busy} onClick={() => void remove(s)}>
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
