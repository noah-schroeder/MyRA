import { useCallback, useEffect, useState } from "react";
import type { ItemRow, MemberKind, ProjectSummary } from "../types.ts";
import { RailSection, useRailSection } from "./RailSection.tsx";

/**
 * The work you have been doing lately, whatever kind it is.
 *
 * v1 listed pi's session JSONLs and, separately, research runs -- two stores,
 * because pi owned one of them. Then there was one store and this was one list
 * of conversations, which was right until a peer review and a paper draft became
 * records too: they were work you had done, they could be filed into a project,
 * and the only place they appeared was their own page. A list of conversations
 * beside three kinds of invisible work is a list that lies about what is here.
 *
 * The rows come from the same stores a project reads, so a row prints the title
 * and the note its own page prints, and "which project is this in" is already
 * answered for the filter below.
 */

type Row = ItemRow & { kind: MemberKind; project: string };

/** What a row is, when it is not a conversation. Chats carry no tag: they are
 *  the common case and a tag on every row is a column of noise. */
const TAGS: Partial<Record<MemberKind, string>> = {
  paper: "paper",
  review: "review",
  run: "research",
};

export function SessionList({
  currentId,
  onOpen,
  onNew,
  refreshKey,
  filter,
  onChanged,
}: {
  /** The conversation on screen, if a conversation is what is on screen. */
  currentId?: string;
  onOpen: (kind: MemberKind, ref: string) => void;
  onNew: () => void;
  refreshKey: number;
  /**
   * Show only this project's work, under its name.
   *
   * The payoff of having projects at all: while you are working in one, the
   * history beside you is that project's history. It is a filter and never a
   * hiding place -- "Everything" is always one click away, and the heading names
   * what is being filtered so the missing rows are explained rather than merely
   * absent.
   */
  filter?: { name: string; id: string } | undefined;
  /**
   * Something was deleted here.
   *
   * Projects prune on read, so a deleted item cannot leave a row that opens
   * nothing -- but the count beside a project's name is drawn from a listing
   * that nothing had asked for again, so it sat one too high until something
   * else happened to refresh it. This is that something.
   */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const { open, toggle } = useRailSection("recent");
  const [confirming, setConfirming] = useState(false);
  const [all, setAll] = useState(false);
  /* Which row is being filed, and where it could go. Filing used to live only
     in Projects → Add existing, so a run you had just read had no way into a
     project from where you were looking at it. */
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [filing, setFiling] = useState<string | undefined>();

  const load = useCallback((): void => {
    void window.karen.recent().then((r) => setRows(r.items ?? []));
  }, []);

  useEffect(load, [refreshKey, load]);

  useEffect(() => {
    void window.karen.projectList().then((r) => setProjects(r.projects ?? []));
    return window.karen.onProjects(setProjects);
  }, []);
  /* A review saved by a run that finished while another page was open. */
  useEffect(() => window.karen.onReviews(() => load()), [load]);
  /* A paper section committed by main while this list, not the drafter, was
     the page on screen -- the same reason the review listener above exists. */
  useEffect(() => window.karen.onPaperChanged(() => load()), [load]);

  /* Back to the project's own list whenever the project changes. "Show all" is
     a peek, not a preference: left latched, opening a second project would
     silently show everything under its name. */
  useEffect(() => setAll(false), [filter?.name]);

  const remove = async (row: Row): Promise<void> => {
    /* One kind per call, because they are different stores and a single
       "delete this ref" would be a guess about which one owns it. */
    if (row.kind === "chat") await window.karen.deleteSession(row.ref);
    else if (row.kind === "paper") await window.karen.paperDelete(row.ref);
    else if (row.kind === "review") await window.karen.reviewDelete(row.ref);
    /* Through the same channel the Research runs page uses, which refuses a run
       that is still being written to rather than deleting it out from under a
       stage. */
    else if (row.kind === "run") await window.karen.researchDelete(row.ref);
    load();
    onChanged?.();
  };

  const file = async (row: Row, projectId: string): Promise<void> => {
    /* Membership is exclusive, so this MOVES a thing that is already filed --
       which is why the menu names where it is now rather than only where it
       could go. `projectAdd` does the moving; nothing here has to. */
    if (projectId) await window.karen.projectAdd(projectId, [{ kind: row.kind, ref: row.ref }]);
    else if (row.project) await window.karen.projectRemove(row.project, [{ kind: row.kind, ref: row.ref }]);
    setFiling(undefined);
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
  const shown = filtering ? rows.filter((r) => r.project === filter!.id) : rows;
  const chats = rows.filter((r) => r.kind === "chat").length;

  return (
    /* Folded, the list must stop claiming the space it is no longer using --
       this is the flex child that grows, so without `flex: none` collapsing it
       would leave the same gap with nothing in it. */
    <nav className={open ? "sessions" : "sessions folded"} aria-label="Recent work">
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
            {shown.map((row) => (
              <li
                key={`${row.kind} ${row.ref}`}
                className={row.kind === "chat" && row.ref === currentId ? "session current" : "session"}
                /* Position for the filing menu, which is absolutely placed so a
                   long project list does not push the history around. */
                style={{ position: "relative" }}
              >
                <button
                  type="button"
                  className="session-open"
                  onClick={() => onOpen(row.kind, row.ref)}
                >
                  <span className="session-title">{row.title}</span>
                  <span className="session-meta">
                    {TAGS[row.kind] ? <span className="session-kind">{TAGS[row.kind]}</span> : null}
                    {when(row.at)}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </button>
                {/* Siblings of the open button, not children of it: a button
                    inside a button is invalid, and filing something must not
                    also open it. The star in the model menu is laid out the
                    same way for the same reason. */}
                {projects.length ? (
                  <button
                    type="button"
                    className={row.project ? "session-file on" : "session-file"}
                    aria-label={`File ${row.title} into a project`}
                    title={
                      row.project
                        ? `In ${projects.find((p) => p.id === row.project)?.name ?? "a project"}`
                        : "File into a project"
                    }
                    onClick={() => setFiling((f) => (f === `${row.kind} ${row.ref}` ? undefined : `${row.kind} ${row.ref}`))}
                  >
                    ⊞
                  </button>
                ) : null}
                <button
                  type="button"
                  className="session-delete"
                  aria-label={`Delete ${row.title}`}
                  onClick={() => void remove(row)}
                >
                  ×
                </button>
                {filing === `${row.kind} ${row.ref}` ? (
                  <ul className="session-file-menu">
                    {projects.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className={p.id === row.project ? "on" : ""}
                          onClick={() => void file(row, p.id)}
                        >
                          {p.name}
                          {p.id === row.project ? " ✓" : ""}
                        </button>
                      </li>
                    ))}
                    {row.project ? (
                      <li>
                        <button type="button" className="off" onClick={() => void file(row, "")}>
                          Not in a project
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="session-empty">
                {filtering ? "Nothing in this project yet." : "Nothing saved yet."}
              </li>
            ) : null}
          </ul>

          {filter ? (
            <button type="button" className="session-scope" onClick={() => setAll((v) => !v)}>
              {all ? `Only ${filter.name}` : "Everything →"}
            </button>
          ) : null}

          {/* Conversations only, and it says so. Three kinds of work behind one
              blunt button is how somebody loses a review they meant to keep. */}
          {chats > 0 && !filtering ? (
            confirming ? (
              <div className="session-confirm">
                <span>Delete all {chats} conversations?</span>
                <button type="button" onClick={() => void removeAll()}>
                  Delete
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="session-delete-all" onClick={() => setConfirming(true)}>
                Delete all conversations
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
