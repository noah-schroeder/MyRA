import { useEffect, useRef, useState } from "react";
import type { CitedSource, DocumentUpdate } from "../types.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * The documents this conversation has written, beside the conversation.
 *
 * A document Karen writes used to exist only as a sentence saying it had been
 * written. To read a five-page report you had to leave the app, find the file
 * and open it somewhere else -- and while it was being written, section by
 * section over several minutes, there was nothing to look at but a progress
 * line. The work was invisible in the app that did it.
 *
 * Beside rather than over the thread, and for the same reason research runs are
 * a page rather than a modal: you read a draft *against* the conversation that
 * produced it, and something covering that conversation makes the two
 * impossible to hold at once.
 */
export function ArtifactPanel({
  docs,
  active,
  onSelect,
  onClose,
}: {
  /** In the order they were first written. */
  docs: DocumentUpdate[];
  active: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const doc = docs.find((d) => d.path === active) ?? docs[docs.length - 1];
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /*
   * Follow the writing, unless the reader has scrolled up.
   *
   * A draft grows a section at a time, and a panel that stayed at the top would
   * show the introduction for eight minutes while the rest arrived below the
   * fold. One that always jumped to the bottom would be worse: it would yank
   * the paragraph you were reading out from under you every time a section
   * landed. So it follows only while you are already at the bottom.
   */
  useEffect(() => {
    const el = body.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [doc?.markdown]);

  if (!doc) return null;

  const words = doc.markdown.trim() ? doc.markdown.trim().split(/\s+/).length : 0;

  return (
    <aside className="artifact" aria-label="Documents written in this conversation">
      <header className="artifact-head">
        <div className="artifact-title" title={doc.path}>
          {doc.name}
        </div>
        <button type="button" className="artifact-x" onClick={onClose} aria-label="Hide documents">
          ×
        </button>
      </header>

      {/* Only when there is a choice to make. One document needs no picker. */}
      {docs.length > 1 ? (
        <div className="artifact-tabs" role="tablist" aria-label="Documents">
          {docs.map((d) => (
            <button
              key={d.path}
              type="button"
              role="tab"
              aria-selected={d.path === doc.path}
              className={d.path === doc.path ? "artifact-tab on" : "artifact-tab"}
              onClick={() => onSelect(d.path)}
              title={d.name}
            >
              {d.name}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="artifact-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <Markdown text={doc.markdown} sources={NO_SOURCES} />
      </div>

      <footer className="artifact-foot">
        <span className="artifact-count">
          {/* Said plainly while it is happening. The file on disk is real and
              readable at this point -- it is saved after every section -- so
              "still writing" is a statement about the document, not a warning
              that nothing exists yet. */}
          {doc.final ? `${words.toLocaleString()} words` : `${words.toLocaleString()} words · still writing…`}
        </span>
        <button type="button" className="artifact-open" onClick={() => void reveal(doc.path)}>
          Show in folder
        </button>
      </footer>
    </aside>
  );
}

/*
 * Nothing here is cited.
 *
 * The Markdown component takes a source table so that [1] in a research answer
 * becomes a link. A written document carries no such table -- and in a draft,
 * where nothing searched, a marker that rendered as a working citation would be
 * the app vouching for something the model invented.
 */
const NO_SOURCES: Map<number, CitedSource> = new Map();

async function reveal(path: string): Promise<void> {
  await window.karen.revealDocument(path).catch(() => undefined);
}

/**
 * Collect written documents for the panel above.
 *
 * Keyed by path so the draft flow's repeated saves of one file replace each
 * other instead of stacking up as a dozen tabs of the same document, and
 * ordered by when each path was FIRST seen so the tabs do not reshuffle
 * themselves every time a section lands.
 */
export function useDocuments(): {
  docs: DocumentUpdate[];
  active: string;
  setActive: (path: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  reset: () => void;
} {
  const [docs, setDocs] = useState<DocumentUpdate[]>([]);
  const [active, setActive] = useState("");
  const [open, setOpen] = useState(false);
  /* Reopening on every save would fight a reader who had just closed it -- and
     a draft saves a dozen times. Opens itself once per document instead. */
  const announced = useRef(new Set<string>());

  useEffect(
    () =>
      window.karen.onDocument((doc) => {
        setDocs((prev) => {
          const at = prev.findIndex((d) => d.path === doc.path);
          if (at === -1) return [...prev, doc];
          const next = [...prev];
          next[at] = doc;
          return next;
        });
        setActive(doc.path);
        if (!announced.current.has(doc.path)) {
          announced.current.add(doc.path);
          setOpen(true);
        }
      }),
    [],
  );

  return {
    docs,
    active,
    setActive,
    open,
    setOpen,
    reset: () => {
      setDocs([]);
      setActive("");
      setOpen(false);
      announced.current.clear();
    },
  };
}
