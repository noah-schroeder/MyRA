import { useEffect, useMemo, useState } from "react";
import { kindLabel } from "../../core/projects/project.ts";
import type { ItemRow, MemberKind } from "../types.ts";

/**
 * Bringing existing work into a project.
 *
 * The bulk path, and the one that decides whether projects get used at all.
 * Somebody adopting this feature has months of conversations, meetings and runs
 * already on disk; if filing them means visiting five pages and moving one row
 * at a time, they will file three things and stop. So this is one dialog over
 * all five stores, with checkboxes.
 *
 * It shows what is already filed as well as what is not, greyed and named,
 * rather than hiding it. Membership is exclusive -- a thing is in one project
 * -- so ticking something that belongs to another project MOVES it, and that is
 * a thing to be told before you tick it rather than after.
 */

const ORDER: MemberKind[] = ["paper", "run", "meeting", "chat", "image"];

const HEADINGS: Record<MemberKind, string> = {
  chat: "Conversations",
  meeting: "Meetings",
  run: "Research runs",
  paper: "Papers",
  image: "Images",
};

type Row = ItemRow & { kind: MemberKind; project: string };

export function ProjectPicker({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [items, projects] = await Promise.all([
        window.karen.projectItems(),
        window.karen.projectList(),
      ]);
      setRows(items.items ?? []);
      setNames(new Map((projects.projects ?? []).map((p) => [p.id, p.name])));
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    /* Already in THIS project is the one thing worth hiding: there is nothing
       to do with it here, and the project page below is already showing it. */
    const available = rows.filter((r) => r.project !== projectId);
    if (!needle) return available;
    return available.filter((r) => `${r.title} ${r.note}`.toLowerCase().includes(needle));
  }, [rows, query, projectId]);

  const toggle = (row: Row): void => {
    const key = `${row.kind}:${row.ref}`;
    setChosen((seen) => {
      const next = new Set(seen);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const add = async (): Promise<void> => {
    const members = [...chosen].map((key) => {
      const at = key.indexOf(":");
      return { kind: key.slice(0, at) as MemberKind, ref: key.slice(at + 1) };
    });
    if (!members.length) {
      onClose();
      return;
    }
    setBusy(true);
    await window.karen.projectAdd(projectId, members);
    setBusy(false);
    onDone();
  };

  /* How many of the ticked ones are being taken out of another project. Said
     on the button, because "Add 6" hides the fact that two of them are moves. */
  const moving = [...chosen].filter((key) => {
    const at = key.indexOf(":");
    const row = rows.find((r) => r.kind === key.slice(0, at) && r.ref === key.slice(at + 1));
    return Boolean(row?.project);
  }).length;

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Add to project">
      <div className="dialog dialog-wide picker">
        <h2 className="dialog-title">Add existing work</h2>
        <p className="dialog-message">
          Anything already in another project is shown with its project's name — ticking it moves
          it here, because a thing belongs to one project at a time.
        </p>

        <input
          className="dialog-input"
          type="search"
          value={query}
          autoFocus
          placeholder="Filter by name"
          aria-label="Filter"
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="picker-body">
          {loading ? <p className="modelmenu-empty">Reading what you have…</p> : null}
          {!loading && shown.length === 0 ? (
            <p className="modelmenu-empty">
              {query.trim()
                ? `Nothing matches “${query.trim()}”.`
                : "There is nothing else to add — everything you have is already in this project."}
            </p>
          ) : null}

          {ORDER.map((kind) => {
            const ofKind = shown.filter((r) => r.kind === kind);
            if (!ofKind.length) return null;
            return (
              <div key={kind} className="picker-group">
                <p className="project-group-head">
                  {HEADINGS[kind]} <span className="project-count">{ofKind.length}</span>
                </p>
                <ul className="picker-rows">
                  {ofKind.map((row) => {
                    const key = `${row.kind}:${row.ref}`;
                    return (
                      <li key={key}>
                        <label className="picker-row">
                          <input
                            type="checkbox"
                            checked={chosen.has(key)}
                            onChange={() => toggle(row)}
                          />
                          <span className="picker-name">{row.title}</span>
                          <span className="picker-note">
                            {row.note}
                            {row.project ? (
                              <span className="picker-owned">
                                {" "}
                                · in {names.get(row.project) ?? "another project"}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy || !chosen.size} onClick={() => void add()}>
            {chosen.size === 0
              ? "Add"
              : moving
                ? `Add ${chosen.size} (${moving} moved)`
                : `Add ${chosen.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export { kindLabel };
