import { useEffect, useState } from "react";
import type { SessionSummary } from "../types.ts";

/**
 * Past conversations.
 *
 * v1 listed pi's session JSONLs and, separately, research runs -- two stores,
 * because pi owned one of them. There is one store now, so this is one list.
 */
export function SessionList({
  currentId,
  onOpen,
  onNew,
  refreshKey,
}: {
  currentId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  refreshKey: number;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [confirming, setConfirming] = useState(false);

  const load = (): void => {
    void window.karen.listSessions().then(setSessions);
  };

  useEffect(load, [refreshKey]);

  const remove = async (id: string): Promise<void> => {
    await window.karen.deleteSession(id);
    load();
  };

  const removeAll = async (): Promise<void> => {
    await window.karen.deleteAllSessions();
    setConfirming(false);
    load();
    onNew();
  };

  return (
    <nav className="sessions" aria-label="Conversations">
      {/* "New conversation" lives in the rail's nav block now, beside the other
          destinations, rather than being repeated here. */}
      <h2 className="rail-heading">Recent</h2>

      <ul className="session-items">
        {sessions.map((s) => (
          <li key={s.id} className={s.id === currentId ? "session current" : "session"}>
            <button type="button" className="session-open" onClick={() => onOpen(s.id)}>
              <span className="session-title">{s.title}</span>
              <span className="session-meta">
                {when(s.updatedAt)} · {s.messages} message{s.messages === 1 ? "" : "s"}
              </span>
            </button>
            <button
              type="button"
              className="session-delete"
              aria-label={`Delete ${s.title}`}
              onClick={() => void remove(s.id)}
            >
              ×
            </button>
          </li>
        ))}
        {sessions.length === 0 ? <li className="session-empty">Nothing saved yet.</li> : null}
      </ul>

      {sessions.length > 0 ? (
        confirming ? (
          <div className="session-confirm">
            <span>Delete all {sessions.length}?</span>
            <button type="button" onClick={() => void removeAll()}>
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="session-delete-all" onClick={() => setConfirming(true)}>
            Delete all
          </button>
        )
      ) : null}
    </nav>
  );
}

/** Relative for the last week, then the date. Absolute dates age better. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
