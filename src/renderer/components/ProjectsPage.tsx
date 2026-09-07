import { useCallback, useEffect, useState } from "react";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { countsOf, kindLabel, MEMBER_KINDS } from "../../core/projects/project.ts";
import type { ItemRow, MemberKind, ProjectDetail } from "../types.ts";

/**
 * Everything about one piece of work, in one place.
 *
 * A project is an index over the five stores rather than a sixth store, so this
 * page is a view: every row here is drawn from the title and the note that
 * item's own page prints, asked of that store at open time. A project that
 * named a meeting differently from the Meetings page would be two records of
 * one thing, and the one nobody was looking at would be the stale one.
 *
 * Two things it will not do quietly. **Removing** takes something out of the
 * project and leaves it exactly where it was, and says so on the button.
 * **Deleting** names what would go, by kind and by count, and offers the other
 * out beside it -- the folder metaphor makes people expect the contents to
 * survive, and without that button one misread click is a term's work.
 */

/** What you made, then what went into making it. The export uses this order. */
const ORDER: MemberKind[] = ["paper", "run", "meeting", "chat", "image"];

const HEADINGS: Record<MemberKind, string> = {
  chat: "Conversations",
  meeting: "Meetings",
  run: "Research runs",
  paper: "Papers",
  image: "Images",
};

/** Where each kind lives, said on the row so "open" is never a surprise. */
const HOMES: Record<MemberKind, string> = {
  chat: "Opens the conversation",
  meeting: "Opens the Meetings page",
  run: "Opens the Research runs page",
  paper: "Opens the Paper drafter",
  image: "Opens the Images page",
};

export function ProjectsPage({
  id,
  active,
  onClose,
  onOpenChat,
  onGoTo,
  onChanged,
}: {
  id: string;
  /** Whether new work is currently filing itself here. */
  active: boolean;
  onClose: () => void;
  onOpenChat: (ref: string) => void;
  /** Take me to the page this kind of thing lives on. */
  onGoTo: (kind: MemberKind) => void;
  /** The rail's list needs to hear about renames, adds and deletes. */
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | undefined>();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const load = useCallback(async () => {
    const result = await window.karen.projectOpen(id);
    if (!result.ok || !result.detail) {
      setError(result.error ?? "That project could not be opened.");
      return;
    }
    setDetail(result.detail);
    setName(result.detail.project.name);
    setError(undefined);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Debounced, and only once it differs: this fires on every keystroke in the
     title, and a write per character would reorder the rail's list under the
     cursor as `updatedAt` moved. */
  useEffect(() => {
    if (!detail || name === detail.project.name) return;
    const timer = setTimeout(() => {
      void window.karen.projectRename(id, name).then(onChanged);
    }, 600);
    return () => clearTimeout(timer);
  }, [name, detail, id, onChanged]);

  const items = detail?.items ?? [];
  const counts = countsOf(detail?.project.members ?? []);

  const remove = async (kind: MemberKind, ref: string): Promise<void> => {
    await window.karen.projectRemove(id, [{ kind, ref }]);
    await load();
    onChanged();
  };

  const destroy = async (contents: boolean): Promise<void> => {
    setBusy(true);
    const result = await window.karen.projectDelete(id, contents);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error ?? "That project could not be deleted.");
      return;
    }
    /* A refusal is not a failure of the whole delete, and it is the one thing
       here somebody has to be told: a run still being written to is left
       behind, and nothing else on screen would ever mention it again. */
    const failed = result.report?.failed ?? [];
    onChanged();
    if (failed.length) {
      setNote(
        `${failed.length} ${failed.length === 1 ? "item" : "items"} could not be deleted and ` +
          `${failed.length === 1 ? "is" : "are"} still there: ${failed[0]?.error ?? ""}`,
      );
      return;
    }
    onClose();
  };

  const exportIt = async (): Promise<void> => {
    setBusy(true);
    setExported(undefined);
    setError(undefined);
    const result = await window.karen.projectExport(id);
    setBusy(false);
    if (!result.ok || !result.path) {
      setError(result.error ?? "That export failed.");
      return;
    }
    setExported(result.path);
  };

  const open = (kind: MemberKind, ref: string): void => {
    if (kind === "chat") {
      onOpenChat(ref);
      return;
    }
    onGoTo(kind);
  };

  return (
    <section className="hub projects">
      <header className="hub-head">
        <div className="hub-title">
          <button type="button" className="paper-back" onClick={onClose}>
            ‹ Back to chat
          </button>
          <input
            className="paper-title"
            value={name}
            aria-label="Project name"
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="project-sub">
            {items.length === 0
              ? "Nothing in it yet."
              : `${items.length} ${items.length === 1 ? "item" : "items"}`}
            {active ? " · new work is filed here" : ""}
          </p>
        </div>
        <div className="paper-head-tools">
          <button type="button" className="ghost paper-btn" onClick={() => setAdding(true)}>
            + Add existing…
          </button>
          <button type="button" className="ghost paper-btn" disabled={busy} onClick={() => void exportIt()}>
            ⬇ Export
          </button>
          <button
            type="button"
            className="ghost paper-btn paper-danger"
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="papers-body">
        {confirming ? (
          <div className="paper-confirm" role="alertdialog">
            <p>
              Delete “{detail?.project.name}”?
              {items.length === 0 ? " It is empty." : " It holds:"}
            </p>
            {items.length ? (
              <ul className="project-counts">
                {ORDER.filter((k) => counts[k] > 0).map((k) => (
                  <li key={k}>
                    {counts[k]} {kindLabel(k, counts[k])}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="project-warn">This cannot be undone.</p>
            <div className="paper-confirm-actions">
              <button type="button" className="ghost paper-btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              {items.length ? (
                <button
                  type="button"
                  className="ghost paper-btn"
                  disabled={busy}
                  onClick={() => void destroy(false)}
                >
                  Keep the contents, delete the project
                </button>
              ) : null}
              <button
                type="button"
                className="paper-btn paper-delete"
                disabled={busy}
                onClick={() => void destroy(true)}
              >
                {items.length ? "Delete everything" : "Delete this project"}
              </button>
            </div>
          </div>
        ) : null}

        {exported ? (
          <p className="paper-exported" role="status">
            Written to <span className="paper-path">{exported}</span>
            <button
              type="button"
              className="ghost paper-btn"
              onClick={() => void window.karen.projectReveal(exported)}
            >
              Show in folder
            </button>
          </p>
        ) : null}
        {note ? (
          <p className="paper-invented" role="status">
            {note}
          </p>
        ) : null}
        {error ? (
          <p className="paper-error" role="alert">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="paper-empty">
            Nothing in here yet. Use <strong>+ Add existing…</strong> to bring in work you have
            already done — or just carry on: while this project is open, new conversations,
            papers, meetings, images and research runs file themselves here.
          </p>
        ) : null}

        {ORDER.map((kind) => {
          const ofKind = items.filter((i) => i.kind === kind);
          if (!ofKind.length) return null;
          return (
            <section key={kind} className="project-group">
              <h2 className="project-group-head">
                {HEADINGS[kind]} <span className="project-count">{ofKind.length}</span>
              </h2>
              <ul className="project-rows">
                {ofKind.map((item) => (
                  <Row
                    key={`${kind}:${item.ref}`}
                    item={item}
                    kind={kind}
                    onOpen={() => open(kind, item.ref)}
                    onRemove={() => void remove(kind, item.ref)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {adding ? (
        <ProjectPicker
          projectId={id}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function Row({
  item,
  kind,
  onOpen,
  onRemove,
}: {
  item: ItemRow;
  kind: MemberKind;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="project-row">
      <button type="button" className="project-open" title={HOMES[kind]} onClick={onOpen}>
        <span className="project-row-title">{item.title}</span>
        <span className="project-row-sub">
          {item.note}
          {item.at ? ` · ${when(item.at)}` : ""}
        </span>
      </button>
      {/* Says what it does, because "remove" beside "delete" is exactly the
          pair somebody reads too quickly. */}
      <button
        type="button"
        className="ghost paper-btn"
        title="Takes it out of this project. The item itself is left alone."
        onClick={onRemove}
      >
        Remove
      </button>
    </li>
  );
}

/** A date somebody reads, not one they parse. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export { MEMBER_KINDS };
