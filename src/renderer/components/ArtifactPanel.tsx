import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArtifactRecord, ChartUpdate, CitedSource, DiagramUpdate, DocumentUpdate, TableUpdate,
} from "../types.ts";
import { clampWidth, DEFAULT_WIDTH, WIDTH_KEY } from "./artifactWidth.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import { DiagramView } from "./DiagramView.tsx";
import { TableView } from "./TableView.tsx";
import { ChartView } from "./ChartView.tsx";

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
/**
 * One thing this conversation produced, of the three kinds it can produce.
 *
 * A document, a figure and a table share the panel because they are the same
 * claim on the screen -- work you read against the conversation that made it
 * -- and differ only in what fills the body and what the footer offers. Keyed
 * rather than identified by path, because a diagram or a table has no path:
 * each is held in the conversation until somebody exports it.
 */
export type Artifact =
  | { kind: "doc"; key: string; name: string; doc: DocumentUpdate }
  | { kind: "diagram"; key: string; name: string; diagram: DiagramUpdate }
  | { kind: "table"; key: string; name: string; table: TableUpdate }
  | { kind: "chart"; key: string; name: string; chart: ChartUpdate };

export function ArtifactPanel({
  items,
  active,
  onSelect,
  onClose,
  onResize,
}: {
  /** In the order they were first produced. */
  items: Artifact[];
  active: string;
  onSelect: (key: string) => void;
  onClose: () => void;
  onResize: (width: number) => void;
}) {
  const item = items.find((d) => d.key === active) ?? items[items.length - 1];
  const doc = item?.kind === "doc" ? item.doc : undefined;
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

  if (!item) return null;

  const words = doc && doc.markdown.trim() ? doc.markdown.trim().split(/\s+/).length : 0;

  return (
    <aside className="artifact" aria-label="Documents written in this conversation">
      <ResizeHandle onResize={onResize} />
      <header className="artifact-head">
        <div className="artifact-title" title={item.kind === "doc" ? item.doc.path : item.name}>
          {item.name}
        </div>
        <button type="button" className="artifact-x" onClick={onClose} aria-label="Hide documents">
          ×
        </button>
      </header>

      {/* Only when there is a choice to make. One document needs no picker. */}
      {items.length > 1 ? (
        <div className="artifact-tabs" role="tablist" aria-label="Documents and figures">
          {items.map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={d.key === item.key}
              className={d.key === item.key ? "artifact-tab on" : "artifact-tab"}
              onClick={() => onSelect(d.key)}
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
        {item.kind === "doc" ? (
          <Markdown text={item.doc.markdown} sources={NO_SOURCES} />
        ) : item.kind === "diagram" ? (
          <DiagramView diagram={item.diagram} />
        ) : item.kind === "table" ? (
          <TableView table={item.table} />
        ) : (
          <ChartView chart={item.chart} />
        )}
      </div>

      {/* A figure or a table carries its own actions, beside the thing they
          act on -- so the footer below is the document's alone. */}
      {item.kind === "doc" ? (
      <footer className="artifact-foot">
        <span className="artifact-count">
          {/* Said plainly while it is happening. The file on disk is real and
              readable at this point -- it is saved after every section -- so
              "still writing" is a statement about the document, not a warning
              that nothing exists yet. */}
          {item.doc.final
            ? `${words.toLocaleString()} words`
            : `${words.toLocaleString()} words · still writing…`}
        </span>
        {/* The markdown as written, not the rendered HTML: this is a document
            somebody is about to paste into their own draft, and headings and
            citation markers have to survive that. Read at click time, so
            copying a document still being written takes what exists now. */}
        <CopyButton className="artifact-open" text={() => item.doc.markdown} title="Copy the document as Markdown" />
        <button type="button" className="artifact-open" onClick={() => void reveal(item.doc.path)}>
          Show in folder
        </button>
      </footer>
      ) : null}
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
/** Turn one buffered record into the shape `arrive` deals in -- the one place
 *  that maps a diagram/table/chart to an `Artifact`, shared by the live
 *  subscriptions below and by `replay`, so the two cannot drift into
 *  building the key or name differently. */
function toArtifact(record: ArtifactRecord): Artifact {
  switch (record.kind) {
    case "diagram":
      return { kind: "diagram", key: record.value.id, name: record.value.title, diagram: record.value };
    case "table":
      return { kind: "table", key: record.value.id, name: record.value.title, table: record.value };
    case "chart":
      return { kind: "chart", key: record.value.id, name: record.value.title, chart: record.value };
  }
}

export function useArtifacts(): {
  items: Artifact[];
  active: string;
  setActive: (key: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  width: number;
  setWidth: (px: number) => void;
  reset: (sessionId?: string) => void;
  /** Show what a conversation already produced, for a panel mounting after
   *  the fact -- see the ref's own comment for why this is filtered like a
   *  live push rather than always applied. */
  replay: (sessionId: string, records: ArtifactRecord[]) => void;
} {
  const [items, setItems] = useState<Artifact[]>([]);
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
  /**
   * The conversation on screen right now, if `reset` or `replay` has named
   * one -- the same guard `useAgent.ts`'s `currentSessionId` keeps, for the
   * identical reason: a diagram/table/chart push carries no session tag of
   * its own reliably (an untagged one, or one from before a turn existed,
   * still has to reach a brand-new conversation's first artifact), but a
   * TAGGED push for some other conversation must not land here. Left
   * `undefined` until a session is explicitly opened or created.
   */
  const currentSessionId = useRef<string | undefined>(undefined);

  /* One arrival path for every kind: replace the entry with this key, or
     append it. Keeping them in one list rather than several is what lets the
     tabs and the open-once rule stay single copies of themselves.

     `sessionId` is checked the same way `useAgent.ts`'s live subscription
     checks an agent event: unset ref or untagged push still applies (so a
     brand-new conversation's first artifact, or the document channel, which
     carries no tag at all, is never filtered against an id nothing has set
     yet), but a push tagged for a conversation that is not this one is
     dropped rather than drawn on top of whatever is on screen. */
  const arrive = useCallback((item: Artifact, sessionId?: string) => {
    if (currentSessionId.current && sessionId && sessionId !== currentSessionId.current) return;
    setItems((prev) => {
      const at = prev.findIndex((d) => d.key === item.key);
      if (at === -1) return [...prev, item];
      const next = [...prev];
      next[at] = item;
      return next;
    });
    setActive(item.key);
    if (!announced.current.has(item.key)) {
      announced.current.add(item.key);
      setOpen(true);
    }
  }, []);

  useEffect(
    () => window.myra.onDocument((doc) => {
      arrive({ kind: "doc", key: doc.path, name: doc.name, doc });
    }),
    [arrive],
  );

  useEffect(
    () => window.myra.onDiagram((diagram) => {
      arrive({ kind: "diagram", key: diagram.id, name: diagram.title, diagram }, diagram.sessionId);
    }),
    [arrive],
  );

  useEffect(
    () => window.myra.onTable((table) => {
      arrive({ kind: "table", key: table.id, name: table.title, table }, table.sessionId);
    }),
    [arrive],
  );

  useEffect(
    () => window.myra.onChart((chart) => {
      arrive({ kind: "chart", key: chart.id, name: chart.title, chart }, chart.sessionId);
    }),
    [arrive],
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
    items,
    active,
    setActive,
    open,
    setOpen,
    width,
    setWidth,
    reset: (sessionId?: string) => {
      currentSessionId.current = sessionId;
      setItems([]);
      setActive("");
      setOpen(false);
      announced.current.clear();
    },
    replay: (sessionId: string, records: ArtifactRecord[]) => {
      currentSessionId.current = sessionId;
      for (const record of records) arrive(toArtifact(record), sessionId);
    },
  };
}
