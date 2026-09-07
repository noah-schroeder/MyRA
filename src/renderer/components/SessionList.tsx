import { useEffect, useState } from "react";
import type { SessionSummary } from "../types.ts";
import { RailSection, useRailSection } from "./RailSection.tsx";

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
  filter,
  onChanged,
}: {
  currentId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  refreshKey: number;
  /**
   * Show only this project's conversations, under its name.
   *
   * The payoff of having projects at all: while you are working in one, the
   * history beside you is that project's history. It is a filter and never a
   * hiding place -- "All conversations" is always one click away, and the
   * heading names what is being filtered so the missing rows are explained
   * rather than merely absent.
   */
  filter?: { name: string; refs: Set<string> } | undefined;
  /**
   * A conversation was deleted here.
   *
   * Projects prune on read, so a deleted chat cannot leave a row that opens
   * nothing -- but the count beside a project's name is drawn from a listing
   * that nothing had asked for again, so it sat one too high until something
   * else happened to refresh it. This is that something.
   */
  onChanged?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const { open, toggle } = useRailSection("recent");
  const [confirming, setConfirming] = useState(false);
  const [all, setAll] = useState(false);

  const load = (): void => {
    void window.karen.listSessions().then(setSessions);
  };

  useEffect(load, [refreshKey]);

  /* Back to the project's own list whenever the project changes. "Show all" is
     a peek, not a preference: left latched, opening a second project would
     silently show every conversation under its name. */
  useEffect(() => setAll(false), [filter?.name]);

  const remove = async (id: string): Promise<void> => {
    await window.karen.deleteSession(id);
    load();
    onChanged?.();
  };

  const removeAll = async (): Promise<void> => {
    await window.karen.deleteAllSessions();
    setConfirming(false);
    load();
    onChanged?.();
    onNew();
  };

  const filtering = Boolean(filter) && !all;
  const shown = filtering ? sessions.filter((s) => filter!.refs.has(s.id)) : sessions;

  return (
    /* Folded, the list must stop claiming the space it is no longer using --
       this is the flex child that grows, so without `flex: none` collapsing it
       would leave the same gap with nothing in it. */
    <nav className={open ? "sessions" : "sessions folded"} aria-label="Conversations">
      {/* "New conversation" lives in the rail's nav block now, beside the other
          destinations, rather than being repeated here. */}
      <RailSection
        label={filtering ? filter!.name : "Recent"}
        open={open}
        count={shown.length}
        onToggle={toggle}
        onAdd={onNew}
        addLabel="New conversation"
      />

      {!open ? null : (
        <>
          <ul className="session-items">
            {shown.map((s) => (
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
            {shown.length === 0 ? (
              <li className="session-empty">
                {filtering ? "No conversations in this project yet." : "Nothing saved yet."}
              </li>
            ) : null}
          </ul>

          {filter ? (
            <button type="button" className="session-scope" onClick={() => setAll((v) => !v)}>
              {all ? `Only ${filter.name}` : "All conversations →"}
            </button>
          ) : null}

          {sessions.length > 0 && !filtering ? (
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
        </>
      )}
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
