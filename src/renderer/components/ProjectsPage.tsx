import { useCallback, useEffect, useState } from "react";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { countsOf, kindLabel, MEMBER_KINDS } from "../../core/projects/project.ts";
import { MEMORY_SLOTS, memoryTokens, SLOT_LABELS } from "../../core/projects/memory.ts";
import type { ItemRow, MemberKind, MemoryItem, MemorySlot, ProjectDetail, ProjectMemory } from "../types.ts";

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
const ORDER: MemberKind[] = ["paper", "review", "run", "meeting", "chat", "image"];

const HEADINGS: Record<MemberKind, string> = {
  chat: "Conversations",
  meeting: "Meetings",
  run: "Research runs",
  paper: "Papers",
  review: "Peer reviews",
  image: "Images",
};

/** Where each kind lives, said on the row so "open" is never a surprise. */
const HOMES: Record<MemberKind, string> = {
  chat: "Opens the conversation",
  meeting: "Opens the Meetings page",
  run: "Opens the Research runs page",
  paper: "Opens the Paper drafter",
  review: "Opens the review",
  image: "Opens the Images page",
};

export function ProjectsPage({
  id,
  active,
  onClose,
  onOpenItem,
  onChanged,
  onStartSetup,
}: {
  id: string;
  /** Whether new work is currently filing itself here. */
  active: boolean;
  onClose: () => void;
  /**
   * Open this thing, whatever it is.
   *
   * One callback rather than one per kind: four of the six now open a specific
   * record on their own page, and a second callback that only navigates would be
   * the version that quietly stopped opening the thing you clicked.
   */
  onOpenItem: (kind: MemberKind, ref: string) => void;
  /** The rail's list needs to hear about renames, adds and deletes. */
  onChanged: () => void;
  /** Opt a plain folder into the research workflow -- offered when its memory has never run setup. */
  onStartSetup: () => void;
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
    const result = await window.myra.projectOpen(id);
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
      void window.myra.projectRename(id, name).then(onChanged);
    }, 600);
    return () => clearTimeout(timer);
  }, [name, detail, id, onChanged]);

  const items = detail?.items ?? [];
  const counts = countsOf(detail?.project.members ?? []);

  const remove = async (kind: MemberKind, ref: string): Promise<void> => {
    await window.myra.projectRemove(id, [{ kind, ref }]);
    await load();
    onChanged();
  };

  const destroy = async (contents: boolean): Promise<void> => {
    setBusy(true);
    const result = await window.myra.projectDelete(id, contents);
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
    const result = await window.myra.projectExport(id);
    setBusy(false);
    if (!result.ok || !result.path) {
      setError(result.error ?? "That export failed.");
      return;
    }
    setExported(result.path);
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
              onClick={() => void window.myra.projectReveal(exported)}
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

        <MemorySection id={id} onStartSetup={onStartSetup} />

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
                    onOpen={() => onOpenItem(kind, item.ref)}
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

/**
 * A project's notes: what it read at setup, what it has picked up since, and
 * the two knobs that decide how it keeps growing.
 *
 * Reads and writes go straight through `window.myra.projectMemory*` rather
 * than through `ProjectDetail` (`projectOpen`'s own answer): the memory is a
 * separate file from the project record for exactly the reason it is edited
 * far more often -- see main/memoryStore.ts's header -- and folding it into
 * `load()` above would mean every keystroke here re-reads all five stores'
 * worth of items along with it.
 */
function MemorySection({ id, onStartSetup }: { id: string; onStartSetup: () => void }) {
  const [memory, setMemory] = useState<ProjectMemory | undefined>();
  const [adding, setAdding] = useState(false);
  const [newSlot, setNewSlot] = useState<MemorySlot>("aims");
  const [newText, setNewText] = useState("");

  const load = useCallback(async () => {
    const result = await window.myra.projectMemory(id);
    setMemory(result.memory);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return window.myra.onProjectMemoryChanged((payload) => {
      if (payload.projectId === id) void load();
    });
  }, [id, load]);

  if (!memory) return null;

  if (memory.setup === "pending") {
    return (
      <section className="project-group memory-section">
        <h2 className="project-group-head">Notes</h2>
        <p className="paper-empty">
          Setup hasn't finished yet — open this project's conversation to pick up where it left
          off.
        </p>
      </section>
    );
  }

  const grouped = MEMORY_SLOTS.map((slot) => ({
    slot,
    items: memory.items.filter((it) => it.slot === slot),
  })).filter((g) => g.items.length);

  const save = (itemId: string, text: string): void => {
    void window.myra.projectMemoryEdit(id, itemId, text).then((r) => setMemory(r.memory));
  };
  const remove = (itemId: string): void => {
    void window.myra.projectMemoryRemove(id, itemId).then((r) => setMemory(r.memory));
  };
  const toggleAuto = (auto: boolean): void => {
    void window.myra.projectMemorySetAuto(id, auto).then((r) => setMemory(r.memory));
  };
  const addNote = (): void => {
    if (!newText.trim()) return;
    void window.myra.projectMemoryAdd(id, newSlot, newText).then((r) => {
      if (r.memory) setMemory(r.memory);
      setNewText("");
      setAdding(false);
    });
  };

  if (!memory.items.length) {
    return (
      <section className="project-group memory-section">
        <h2 className="project-group-head">Notes</h2>
        <p className="paper-empty">
          Nothing kept yet.{" "}
          <button type="button" className="ghost paper-btn" onClick={onStartSetup}>
            Start research setup
          </button>{" "}
          to talk through this project, or add a note directly.
        </p>
        <AddNoteForm
          adding={adding}
          slot={newSlot}
          text={newText}
          onSlot={setNewSlot}
          onText={setNewText}
          onOpen={() => setAdding(true)}
          onCancel={() => setAdding(false)}
          onAdd={addNote}
        />
      </section>
    );
  }

  return (
    <section className="project-group memory-section">
      <h2 className="project-group-head">
        Notes <span className="project-count">{memory.items.length}</span>
      </h2>
      <label className="memory-auto">
        <input type="checkbox" checked={memory.auto} onChange={(e) => toggleAuto(e.target.checked)} />
        Keep this up to date automatically
      </label>

      {grouped.map(({ slot, items: slotItems }) => (
        <div key={slot} className="memory-group">
          <h3 className="memory-group-head">{SLOT_LABELS[slot]}</h3>
          <ul className="memory-items">
            {slotItems.map((item) => (
              <MemoryRow key={item.id} item={item} onSave={(t) => save(item.id, t)} onRemove={() => remove(item.id)} />
            ))}
          </ul>
        </div>
      ))}

      <AddNoteForm
        adding={adding}
        slot={newSlot}
        text={newText}
        onSlot={setNewSlot}
        onText={setNewText}
        onOpen={() => setAdding(true)}
        onCancel={() => setAdding(false)}
        onAdd={addNote}
      />

      <p className="memory-tokens">~{memoryTokens(memory)} tokens of notes, read at the start of every conversation here.</p>
    </section>
  );
}

function MemoryRow({
  item,
  onSave,
  onRemove,
}: {
  item: MemoryItem;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(item.text);
  useEffect(() => setValue(item.text), [item.text]);

  return (
    <li className="memory-row">
      <textarea
        className="memory-input"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim() !== item.text) onSave(value);
        }}
      />
      {item.source === "auto" ? (
        <span className="memory-badge" title="Added on its own from a conversation in this project">
          auto
        </span>
      ) : null}
      <button type="button" className="ghost paper-btn" title="Remove this note" onClick={onRemove}>
        ×
      </button>
    </li>
  );
}

function AddNoteForm({
  adding,
  slot,
  text,
  onSlot,
  onText,
  onOpen,
  onCancel,
  onAdd,
}: {
  adding: boolean;
  slot: MemorySlot;
  text: string;
  onSlot: (slot: MemorySlot) => void;
  onText: (text: string) => void;
  onOpen: () => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  if (!adding) {
    return (
      <button type="button" className="ghost paper-btn memory-add-btn" onClick={onOpen}>
        + Add a note
      </button>
    );
  }
  return (
    <div className="memory-add">
      <select className="select-sm" value={slot} onChange={(e) => onSlot(e.target.value as MemorySlot)}>
        {MEMORY_SLOTS.map((s) => (
          <option key={s} value={s}>
            {SLOT_LABELS[s]}
          </option>
        ))}
      </select>
      <input
        className="dialog-input"
        value={text}
        placeholder="What do you want MyRA to remember?"
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onAdd()}
        autoFocus
      />
      <button type="button" className="ghost paper-btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="paper-btn" disabled={!text.trim()} onClick={onAdd}>
        Add
      </button>
    </div>
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
