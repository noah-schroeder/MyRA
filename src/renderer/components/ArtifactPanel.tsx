import { useCallback, useEffect, useRef, useState } from "react";
import type { CitedSource, DocumentUpdate } from "../types.ts";
import { clampWidth, DEFAULT_WIDTH, WIDTH_KEY } from "./artifactWidth.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * The documents this conversation has written, beside the conversation.
 *
 * A document MyRA writes used to exist only as a sentence saying it had been
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
  onResize,
}: {
  /** In the order they were first written. */
  docs: DocumentUpdate[];
  active: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  onResize: (width: number) => void;
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
      <ResizeHandle onResize={onResize} />
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
        {/* The markdown as written, not the rendered HTML: this is a document
            somebody is about to paste into their own draft, and headings and
            citation markers have to survive that. Read at click time, so
            copying a document still being written takes what exists now. */}
        <CopyButton className="artifact-open" text={() => doc.markdown} title="Copy the document as Markdown" />
        <button type="button" className="artifact-open" onClick={() => void reveal(doc.path)}>
          Show in folder
        </button>
      </footer>
    </aside>
  );
}

/**
 * Drag the edge.
 *
 * A fixed 400px is right for a section and wrong for a table, and the document
 * is the thing being read -- so the reader decides, not the layout. Keyboard as
 * well as pointer, because a drag handle is unusable without one and this is a
 * pane somebody may live in for an hour.
 *
 * Pointer capture rather than window listeners: without it, dragging faster
 * than React re-renders takes the pointer outside the handle and the resize
 * stops dead halfway across the screen.
 */
function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  /* The drag's own state, rather than asking whether pointer capture is held.
     Capture is an optimisation here -- it keeps a fast drag from outrunning the
     handle -- and setPointerCapture can refuse. Gating the whole control on it
     succeeding means one throw leaves a grip that looks draggable and is not. */
  const dragging = useRef(false);

  const stop = useCallback(() => {
    dragging.current = false;
  }, []);

  useEffect(() => {
    /* A pointerup that never reaches the handle -- capture refused, the button
       released off-window -- would otherwise leave the panel following the
       mouse forever, with no way to put it down. */
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [stop]);

  return (
    <div
      className="artifact-grip"
      role="separator"
      aria-label="Resize the document panel"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* Best effort; the drag works without it, just less smoothly. */
        }
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        // Measured from the right edge, which is where the panel is anchored.
        onResize(clampWidth(window.innerWidth - e.clientX, window.innerWidth));
      }}
      onPointerUp={stop}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
        if (!step) return;
        e.preventDefault();
        const now = document.querySelector(".artifact")?.getBoundingClientRect().width ?? 400;
        onResize(clampWidth(now + step, window.innerWidth));
      }}
    />
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
  await window.myra.revealDocument(path).catch(() => undefined);
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
  width: number;
  setWidth: (px: number) => void;
  reset: () => void;
} {
  const [docs, setDocs] = useState<DocumentUpdate[]>([]);
  const [active, setActive] = useState("");
  const [open, setOpen] = useState(false);
  /* Remembered, because a width is a decision about how you read and not about
     this document: having to re-drag it on every launch would make the control
     annoying enough to be worth less than the fixed 400px it replaced. */
  const [width, setWidthState] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampWidth(stored, window.innerWidth)
      : DEFAULT_WIDTH;
  });
  /* Reopening on every save would fight a reader who had just closed it -- and
     a draft saves a dozen times. Opens itself once per document instead. */
  const announced = useRef(new Set<string>());

  useEffect(
    () =>
      window.myra.onDocument((doc) => {
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

  const setWidth = useCallback((px: number) => {
    setWidthState(px);
    // Best effort: a browser with storage blocked still resizes, it just
    // forgets. Losing a preference is not a reason to break the drag.
    try {
      localStorage.setItem(WIDTH_KEY, String(px));
    } catch {
      /* ignore */
    }
  }, []);

  return {
    docs,
    active,
    setActive,
    open,
    setOpen,
    width,
    setWidth,
    reset: () => {
      setDocs([]);
      setActive("");
      setOpen(false);
      announced.current.clear();
    },
  };
}
