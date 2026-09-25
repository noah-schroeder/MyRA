import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { countsOf, kindLabel, MEMBER_KINDS } from "../../core/projects/project.ts";
import {
  isActive, MEMORY_SLOTS, memoryTokens, pendingSuggestions, SLOT_LABELS,
} from "../../core/projects/memory.ts";
import { resumeDigest, type ResumeDigest } from "../../core/projects/resume.ts";
import type {
  CollectionNode, ItemRow, MemberKind, MemoryItem, MemorySlot, ProjectDetail, ProjectMemory, SourceRow,
} from "../types.ts";

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
const ORDER: MemberKind[] = ["paper", "review", "run", "source", "meeting", "chat", "image"];

const HEADINGS: Record<MemberKind, string> = {
  chat: "Conversations",
  meeting: "Meetings",
  run: "Research runs",
  paper: "Papers",
  review: "Peer reviews",
  image: "Images",
  source: "Full texts",
};

/** Where each kind lives, said on the row so "open" is never a surprise. */
const HOMES: Record<MemberKind, string> = {
  chat: "Opens the conversation",
  meeting: "Opens the Meetings page",
  run: "Opens the Research runs page",
  paper: "Opens the Paper drafter",
  review: "Opens the review",
  image: "Opens the Images page",
  source: "Opens the file in your PDF viewer",
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
  onOpenItem: (kind: MemberKind, ref: string, at?: { msg?: number }) => void;
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
  const [since, setSince] = useState<string | undefined>();
  const visited = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    /* The first load of this project is the visit; the reloads after every
       remove and add are not, or "since you were last here" would be now. */
    const visit = visited.current !== id;
    visited.current = id;
    const result = await window.myra.projectOpen(id, visit);
    if (!result.ok || !result.detail) {
      setError(result.error ?? "That project could not be opened.");
      return;
    }
    setDetail(result.detail);
    if (visit) setSince(result.detail.since);
    setName(result.detail.project.name);
    setError(undefined);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Held here rather than in the notes section, because the resume card at
     the top of the page reads it too. */
  const [memory, setMemory] = useState<ProjectMemory | undefined>();
  const loadMemory = useCallback(async () => {
    setMemory((await window.myra.projectMemory(id)).memory);
  }, [id]);
  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);
  useEffect(() => {
    return window.myra.onProjectMemoryChanged((payload) => {
      if (payload.projectId === id) void loadMemory();
    });
  }, [id, loadMemory]);

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

  /** Titles of what a note can have come from -- only what is in this project, so every link opens something. */
  const titles = useMemo(() => {
    const out = new Map<string, string>();
    for (const item of items) if (item.kind === "chat" || item.kind === "meeting") out.set(`${item.kind}:${item.ref}`, item.title);
    return out;
  }, [items]);
  const digest = useMemo(
    () => resumeDigest(memory, items.map((i) => ({ kind: i.kind, ref: i.ref, title: i.title, at: i.at })), since),
    [memory, items, since],
  );

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

        {!digest.empty ? <ResumeCard digest={digest} onOpen={onOpenItem} /> : null}

        {detail ? (
          <LibrarySection
            projectId={id}
            linked={detail.project.collections ?? []}
            onLink={(collections) =>
              void window.myra.projectSetCollections(id, collections).then(async (r) => {
                if (!r.ok) setError(r.error ?? "Those collections could not be saved.");
                await load();
                onChanged();
              })
            }
          />
        ) : null}

        <MemorySection
          id={id}
          memory={memory}
          onMemory={setMemory}
          titles={titles}
          onOpenOrigin={onOpenItem}
          onStartSetup={onStartSetup}
        />

        {items.length === 0 ? (
          <p className="paper-empty">
            Nothing in here yet. Use <strong>+ Add existing…</strong> to bring in work you have
            already done — or just carry on: while this project is open, new conversations,
            papers, meetings, images and research runs file themselves here.
          </p>
        ) : null}

        <FullTextsSection projectId={id} onChanged={() => void load()} />

        {ORDER.map((kind) => {
          /* Uploaded papers have their own section above, with the things only
             a paper has -- its outline, its metadata to correct. */
          if (kind === "source") return null;
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
 * Which Zotero collections this project reads from.
 *
 * Several, because a thesis draws on more than one shelf; each one searched
 * with everything below it, the way the research bar's single choice already
 * is. Linking is not filing: the papers stay in Zotero, MyRA never writes
 * there, and one collection can be linked to any number of projects.
 */
function LibrarySection({
  projectId,
  linked,
  onLink,
}: {
  projectId: string;
  linked: readonly { key: string; name: string }[];
  onLink: (collections: { key: string; name: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  /* How much of the linked shelf can actually be read -- a paper with no PDF
     attached, or one Zotero cannot find, is searched by abstract only, and
     the person should know that before asking about it. */
  const [status, setStatus] = useState<{ items: number; readable: number } | string | undefined>();
  const keys = linked.map((c) => c.key).join(",");
  useEffect(() => {
    if (!keys) {
      setStatus(undefined);
      return;
    }
    let live = true;
    void window.myra.projectPapersStatus(projectId).then((r) => {
      if (live) setStatus(r.ok ? r.zotero : (r.error ?? undefined));
    });
    return () => {
      live = false;
    };
  }, [projectId, keys]);
  const [tree, setTree] = useState<{ loading: boolean; nodes: CollectionNode[]; error: string }>({
    loading: false,
    nodes: [],
    error: "",
  });

  const load = useCallback(() => {
    setTree((t) => ({ ...t, loading: true }));
    void window.myra.zoteroCollections().then((res) =>
      setTree({ loading: false, nodes: res.collections ?? [], error: res.ok ? "" : (res.error ?? "Zotero could not be reached.") }),
    );
  }, []);
  /* Asked only when the picker is opened, or a project page that is only being
     looked at would dial Zotero every time it is drawn. Once opened, the tree
     also names what a linked key is called in Zotero NOW. */
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const current = new Map(tree.nodes.map((n) => [n.key, n]));
  const linkedKeys = new Set(linked.map((c) => c.key));

  return (
    <section className="project-group library-section">
      <h2 className="project-group-head">
        Zotero library {linked.length ? <span className="project-count">{linked.length}</span> : null}
      </h2>
      {linked.length ? (
        <ul className="library-chips">
          {linked.map((c) => {
            const now = current.get(c.key);
            const gone = tree.nodes.length > 0 && !now;
            return (
              <li key={c.key} className={gone ? "library-chip gone" : "library-chip"} title={now?.path ?? c.name}>
                {now?.name ?? c.name}
                {now?.children ? <span className="collection-note"> + {now.children} below</span> : null}
                {gone ? <span className="collection-note"> — no longer in Zotero</span> : null}
                <button
                  type="button"
                  className="ghost paper-btn"
                  title="Stop searching this collection in this project. Nothing in Zotero changes."
                  onClick={() => onLink(linked.filter((x) => x.key !== c.key))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="paper-empty">
          Link the Zotero collections this project draws on, and searches of your library in its
          conversations look only there.
        </p>
      )}
      {typeof status === "object" ? (
        <p className="memory-tokens">
          {status.readable} of {status.items} {status.items === 1 ? "paper" : "papers"}{" "}
          {status.readable === 1 ? "has" : "have"} a PDF MyRA can read
          {status.readable < status.items ? " — the others are searched by their abstracts only." : "."}
        </p>
      ) : typeof status === "string" ? (
        <p className="memory-tokens">{status}</p>
      ) : null}

      {open ? (
        tree.error ? (
          <div className="collection-ask unreachable">
            <span>{tree.error}</span>
            <button type="button" className="btn btn-sm" onClick={load}>Try again</button>
          </div>
        ) : (
          <div className="memory-add">
            <select
              className="select-sm"
              disabled={tree.loading}
              value=""
              onChange={(e) => {
                const picked = current.get(e.target.value);
                if (picked) onLink([...linked, { key: picked.key, name: picked.name }]);
                setOpen(false);
              }}
            >
              <option value="">{tree.loading ? "Loading collections…" : "Choose a collection…"}</option>
              {tree.nodes.map((n) => (
                <option key={n.key} value={n.key} disabled={linkedKeys.has(n.key)} title={n.path}>
                  {"  ".repeat(n.depth)}
                  {n.name}
                </option>
              ))}
            </select>
            <button type="button" className="ghost paper-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        )
      ) : (
        <button type="button" className="ghost paper-btn memory-add-btn" onClick={() => setOpen(true)}>
          + Link a collection
        </button>
      )}
    </section>
  );
}

/**
 * Papers uploaded into this project: dropped here, kept in the sources folder,
 * searchable and readable by the model in this project's conversations.
 *
 * The metadata is a guess -- read off the first pages, nothing looked up --
 * so it sits in editable fields and says so. Delete is a real delete, and says
 * that too: an uploaded paper exists only for its project, so "remove from
 * project" would leave a file nothing lists.
 */
function FullTextsSection({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [adding, setAdding] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const r = await window.myra.projectSources(projectId);
    setSources(r.sources ?? []);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      window.myra.onProjectSourcesChanged((p) => {
        if (p.projectId === projectId) void load();
      }),
    [projectId, load],
  );

  const add = async (files: FileList | File[]): Promise<void> => {
    setError(undefined);
    const list = [...files];
    setAdding(list.length);
    const failed: string[] = [];
    /* One at a time: each is a pdftotext run, and a stack of forty dropped at
       once should not become forty processes. */
    for (const file of list) {
      const r = await window.myra.sourceAdd(projectId, file.name, await file.arrayBuffer());
      if (!r.ok) failed.push(`${file.name}: ${r.error ?? "could not be added"}`);
      setAdding((n) => n - 1);
    }
    if (failed.length) setError(failed.join(" · "));
    await load();
    onChanged();
  };

  const edit = (id: string, patch: { title?: string; authors?: string; year?: string; doi?: string }): void => {
    void window.myra.sourceEdit(id, patch).then(() => load());
  };

  return (
    <section
      className={`project-group sources-section${over ? " drop-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void add(e.dataTransfer.files);
      }}
    >
      <h2 className="project-group-head">
        Full texts {sources.length ? <span className="project-count">{sources.length}</span> : null}
      </h2>
      {!sources.length ? (
        <p className="paper-empty">
          Drop the papers this project is built on here — PDFs, or Word and Markdown files. In this
          project's conversations MyRA can then search their full text and read them section by
          section, citing the page. They stay on this machine.
        </p>
      ) : null}

      <ul className="project-rows">
        {sources.map((src) => (
          <SourceRowItem
            key={src.id}
            source={src}
            onEdit={(patch) => edit(src.id, patch)}
            onOpen={() => void window.myra.sourceOpen(src.id)}
            onDelete={() =>
              void window.myra.sourceDelete(src.id).then(async () => {
                await load();
                onChanged();
              })
            }
          />
        ))}
      </ul>

      <div className="memory-add">
        <button type="button" className="ghost paper-btn" disabled={adding > 0} onClick={() => input.current?.click()}>
          {adding > 0 ? `Reading ${adding} paper${adding === 1 ? "" : "s"}…` : "+ Add papers…"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.odt,.rtf,.md,.markdown,.txt,.tex"
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p className="paper-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function SourceRowItem({
  source,
  onEdit,
  onOpen,
  onDelete,
}: {
  source: SourceRow;
  onEdit: (patch: { title?: string; authors?: string; year?: string; doi?: string }) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const field = (key: "title" | "authors" | "year" | "doi", placeholder: string, className: string) => (
    <input
      className={`source-field ${className}`}
      defaultValue={source[key]}
      key={`${source.id}:${key}:${source[key]}`}
      placeholder={placeholder}
      aria-label={placeholder}
      onBlur={(e) => {
        if (e.target.value.trim() !== source[key]) onEdit({ [key]: e.target.value });
      }}
    />
  );
  const status =
    source.text === "ok"
      ? source.paged
        ? `${source.pages} page${source.pages === 1 ? "" : "s"}`
        : "text read, no page numbers"
      : source.text === "scanned"
        ? "no text — scanned, needs OCR"
        : `text could not be read${source.textError ? `: ${source.textError}` : ""}`;

  return (
    <li className="project-row source-row">
      <div className="source-main">
        {field("title", "Title", "source-title")}
        <div className="source-meta-fields">
          {field("authors", "Authors", "source-authors")}
          {field("year", "Year", "source-year")}
          {field("doi", "DOI", "source-doi")}
        </div>
        <div className="memory-meta">
          {source.originalName} · {status}
          {source.outline ? (
            <details className="memory-quote">
              <summary>outline</summary>
              <blockquote>{source.outline}</blockquote>
            </details>
          ) : null}
        </div>
      </div>
      <button type="button" className="ghost paper-btn" onClick={onOpen} title="Open in your PDF viewer">
        Open
      </button>
      {confirming ? (
        <>
          <button type="button" className="paper-btn paper-delete" onClick={onDelete}>
            Delete the file
          </button>
          <button type="button" className="ghost paper-btn" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ghost paper-btn"
          title="Deletes the file and its text. An uploaded paper exists only for this project."
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      )}
    </li>
  );
}

/**
 * "Where you left off", read off what is already recorded -- see
 * core/projects/resume.ts for why no model writes it.
 */
function ResumeCard({
  digest,
  onOpen,
}: {
  digest: ResumeDigest;
  onOpen: (kind: MemberKind, ref: string) => void;
}) {
  const quoted = (list: readonly MemoryItem[]): string =>
    list.slice(0, 3).map((it) => `“${it.text}”`).join("; ") + (list.length > 3 ? `; and ${list.length - 3} more` : "");
  return (
    <section className="project-group resume-card" aria-label="Where you left off">
      <h2 className="project-group-head">Where you left off</h2>
      {digest.since ? <p className="resume-since">Since you were last here, {when(digest.since)}:</p> : null}
      <ul className="resume-list">
        {digest.newNotes.length ? (
          <li>
            {digest.newNotes.length} new {digest.newNotes.length === 1 ? "note" : "notes"}: {quoted(digest.newNotes)}
          </li>
        ) : null}
        {digest.closedNotes.length ? (
          <li>
            {digest.closedNotes.length} {digest.closedNotes.length === 1 ? "note was" : "notes were"} replaced or
            answered — see each field's history below.
          </li>
        ) : null}
        {digest.newWork.length ? (
          <li>
            New in this project:{" "}
            {digest.newWork.slice(0, 4).map((row, i) => (
              <span key={`${row.kind}:${row.ref}`}>
                {i ? ", " : ""}
                <button type="button" className="linkish" onClick={() => onOpen(row.kind, row.ref)}>
                  {row.title}
                </button>
              </span>
            ))}
            {digest.newWork.length > 4 ? ` and ${digest.newWork.length - 4} more` : ""}
          </li>
        ) : null}
        {digest.openQuestions.length ? (
          <li>
            {digest.openQuestions.length} open {digest.openQuestions.length === 1 ? "question" : "questions"}:{" "}
            {quoted(digest.openQuestions)}
          </li>
        ) : null}
        {digest.waiting ? (
          <li className="resume-waiting">
            {digest.waiting} {digest.waiting === 1 ? "suggestion is" : "suggestions are"} waiting for you under Notes.
          </li>
        ) : null}
      </ul>
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
 *
 * Each note says where it came from, because an automatic note nobody can
 * trace is one nobody can check. A note is never quietly rewritten when the
 * project changes course: **Replace** closes it and keeps it in the field's
 * history, and an automatic note that wants to replace one the person wrote
 * waits at the top of this section for them to decide.
 */
function MemorySection({
  id,
  memory,
  onMemory,
  titles,
  onOpenOrigin,
  onStartSetup,
}: {
  id: string;
  memory: ProjectMemory | undefined;
  onMemory: (memory: ProjectMemory) => void;
  /** `chat:<ref>` / `meeting:<ref>` to a title, for what is in this project. */
  titles: ReadonlyMap<string, string>;
  onOpenOrigin: (kind: MemberKind, ref: string, at?: { msg?: number }) => void;
  onStartSetup: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newSlot, setNewSlot] = useState<MemorySlot>("aims");
  const [newText, setNewText] = useState("");

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

  const apply = (p: Promise<{ memory?: ProjectMemory | undefined }>): void => {
    void p.then((r) => {
      if (r.memory) onMemory(r.memory);
    });
  };
  const actions: NoteActions = {
    save: (itemId, text) => apply(window.myra.projectMemoryEdit(id, itemId, text)),
    remove: (itemId) => apply(window.myra.projectMemoryRemove(id, itemId)),
    supersede: (itemId, text) => apply(window.myra.projectMemorySupersede(id, itemId, text)),
    resolve: (itemId, text) =>
      apply(window.myra.projectMemoryResolve(id, itemId, text.trim() ? { text } : undefined)),
    reopen: (itemId) => apply(window.myra.projectMemoryReopen(id, itemId)),
  };
  const toggleAuto = (auto: boolean): void => apply(window.myra.projectMemorySetAuto(id, auto));
  const decide = (itemId: string, accept: boolean): void =>
    apply(window.myra.projectMemorySuggestion(id, itemId, accept));
  const addNote = (): void => {
    if (!newText.trim()) return;
    void window.myra.projectMemoryAdd(id, newSlot, newText).then((r) => {
      if (r.memory) onMemory(r.memory);
      setNewText("");
      setAdding(false);
    });
  };

  const byId = new Map(memory.items.map((it) => [it.id, it]));
  const origin = (item: MemoryItem): Origin => originOf(item, titles);
  const grouped = MEMORY_SLOTS.map((slot) => ({
    slot,
    current: memory.items.filter((it) => it.slot === slot && isActive(it)),
    closed: memory.items.filter((it) => it.slot === slot && !isActive(it)),
  })).filter((g) => g.current.length || g.closed.length);
  const pending = pendingSuggestions(memory);

  const addForm = (
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
  );

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
        {addForm}
      </section>
    );
  }

  const current = memory.items.filter(isActive);
  return (
    <section className="project-group memory-section">
      <h2 className="project-group-head">
        Notes <span className="project-count">{current.length}</span>
      </h2>
      <label className="memory-auto">
        <input type="checkbox" checked={memory.auto} onChange={(e) => toggleAuto(e.target.checked)} />
        Keep this up to date automatically
      </label>

      {pending.length ? (
        <div className="memory-suggestions" role="status">
          {pending.map(({ item, target, kind }) => (
            <div key={`${item.id}:${kind}`} className="memory-suggestion">
              <p>
                “{item.text}” — a newer note that {kind === "replaces" ? "may replace" : "may answer"} yours: “
                {target.text}”
              </p>
              <div className="memory-suggestion-actions">
                <button type="button" className="paper-btn" onClick={() => decide(item.id, true)}>
                  {kind === "replaces" ? "Replace it" : "Mark it answered"}
                </button>
                <button type="button" className="ghost paper-btn" onClick={() => decide(item.id, false)}>
                  Keep both
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {grouped.map(({ slot, current: live, closed }) => (
        <div key={slot} className="memory-group">
          <h3 className="memory-group-head">{SLOT_LABELS[slot]}</h3>
          <ul className="memory-items">
            {live.map((item) => (
              <MemoryRow key={item.id} item={item} origin={origin(item)} onOpenOrigin={onOpenOrigin} actions={actions} />
            ))}
          </ul>
          {closed.length ? (
            <details className="memory-history">
              <summary>
                History <span className="project-count">{closed.length}</span>
              </summary>
              <ul className="memory-items">
                {closed.map((item) => (
                  <ClosedRow key={item.id} item={item} later={item.by ? byId.get(item.by) : undefined} onReopen={() => actions.reopen(item.id)} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}

      {addForm}

      <p className="memory-tokens">~{memoryTokens(memory)} tokens of notes, read at the start of every conversation here.</p>
    </section>
  );
}

interface NoteActions {
  save: (itemId: string, text: string) => void;
  remove: (itemId: string) => void;
  supersede: (itemId: string, text: string) => void;
  resolve: (itemId: string, text: string) => void;
  reopen: (itemId: string) => void;
}

/** What a note came from, said in words and, where it is still in the project, openable. */
interface Origin {
  label: string;
  open?: { kind: MemberKind; ref: string; msg?: number };
}

function originOf(item: MemoryItem, titles: ReadonlyMap<string, string>): Origin {
  if (item.meeting) {
    const title = titles.get(`meeting:${item.meeting}`);
    const at = item.meetingAt ? ` at ${item.meetingAt}` : "";
    return title
      ? { label: `from the meeting “${title}”${at}`, open: { kind: "meeting", ref: item.meeting } }
      : { label: `from a meeting${at} no longer in this project` };
  }
  if (item.from) {
    const title = titles.get(`chat:${item.from}`);
    return title
      ? {
          label: `from “${title}”`,
          open: { kind: "chat", ref: item.from, ...(item.msg !== undefined ? { msg: item.msg } : {}) },
        }
      : { label: "from a conversation no longer in this project" };
  }
  return { label: item.source === "setup" ? "from project setup" : "added by you" };
}

function MemoryRow({
  item,
  origin,
  onOpenOrigin,
  actions,
}: {
  item: MemoryItem;
  origin: Origin;
  onOpenOrigin: (kind: MemberKind, ref: string, at?: { msg?: number }) => void;
  actions: NoteActions;
}) {
  const [value, setValue] = useState(item.text);
  /* Which follow-up the row is showing, if any: replacing the note with new
     text, or saying what answered an open question. */
  const [mode, setMode] = useState<"replace" | "resolve" | undefined>();
  const [draft, setDraft] = useState("");
  useEffect(() => setValue(item.text), [item.text]);

  const finish = (): void => {
    if (mode === "replace" && draft.trim()) actions.supersede(item.id, draft);
    if (mode === "resolve") actions.resolve(item.id, draft);
    setMode(undefined);
    setDraft("");
  };

  return (
    <li className="memory-row">
      <div className="memory-row-main">
        <textarea
          className="memory-input"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value.trim() !== item.text) actions.save(item.id, value);
          }}
        />
        {item.source === "auto" ? (
          <span className="memory-badge" title="Added on its own from a conversation in this project">
            auto
          </span>
        ) : null}
        <button
          type="button"
          className="ghost paper-btn"
          title={item.slot === "open" ? "Say what answered this question" : "Replace this with what the project does now; this note is kept in the history"}
          onClick={() => setMode(item.slot === "open" ? "resolve" : "replace")}
        >
          {item.slot === "open" ? "Answered…" : "Replace…"}
        </button>
        <button type="button" className="ghost paper-btn" title="Remove this note" onClick={() => actions.remove(item.id)}>
          ×
        </button>
      </div>
      <div className="memory-meta">
        {origin.open ? (
          <button
            type="button"
            className="linkish"
            title={origin.open.kind === "chat" ? "Open the conversation at this message" : "Open the meeting"}
            onClick={() => {
              const at = origin.open!;
              onOpenOrigin(at.kind, at.ref, at.msg !== undefined ? { msg: at.msg } : undefined);
            }}
          >
            {origin.label}
          </button>
        ) : (
          <span>{origin.label}</span>
        )}
        {when(item.at) ? <span> · {when(item.at)}</span> : null}
        {item.quote ? (
          <details className="memory-quote">
            <summary>the words it rests on</summary>
            <blockquote>{item.quote}</blockquote>
          </details>
        ) : null}
      </div>
      {mode ? (
        <div className="memory-add memory-followup">
          <input
            className="dialog-input"
            value={draft}
            placeholder={mode === "replace" ? "What the project does now" : "What settled it (optional) — saved as a decision"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish();
              if (e.key === "Escape") setMode(undefined);
            }}
            autoFocus
          />
          <button type="button" className="ghost paper-btn" onClick={() => setMode(undefined)}>
            Cancel
          </button>
          <button type="button" className="paper-btn" disabled={mode === "replace" && !draft.trim()} onClick={finish}>
            {mode === "replace" ? "Replace" : "Mark answered"}
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** A note no longer current: what closed it and when, and a way back. */
function ClosedRow({ item, later, onReopen }: { item: MemoryItem; later: MemoryItem | undefined; onReopen: () => void }) {
  const verb = item.status === "resolved" ? "Answered" : "Replaced";
  return (
    <li className="memory-row memory-closed">
      <div className="memory-row-main">
        <span className="memory-closed-text">{item.text}</span>
        <button type="button" className="ghost paper-btn" title="Make this a current note again" onClick={onReopen}>
          Restore
        </button>
      </div>
      <div className="memory-meta">
        {verb}
        {later ? ` by “${later.text}”` : ""}
        {item.closedAt && when(item.closedAt) ? ` · ${when(item.closedAt)}` : ""}
      </div>
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
