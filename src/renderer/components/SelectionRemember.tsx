import { useEffect, useState, type RefObject } from "react";

/**
 * "Remember" beside whatever is highlighted in one message of the thread.
 *
 * The per-turn Remember button already honoured a selection, but only for
 * someone who knew to highlight first and then find a button that stays
 * invisible until the turn is hovered -- so in practice it saved whole replies,
 * and a whole reply is rarely the note. Here the offer appears where the
 * highlight is, the moment there is one.
 *
 * One message at a time: a selection whose common ancestor is not inside a
 * single `.turn` gets no button, because a note stitched across two speakers
 * is not something either of them said.
 */
export function SelectionRemember({
  thread,
  enabled,
  onRemember,
}: {
  thread: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** The highlighted text, and the `data-item-id` of the turn it sits in. */
  onRemember: (text: string, itemId: string) => void;
}) {
  const [at, setAt] = useState<
    { text: string; itemId: string; top: number; left: number; below: boolean } | undefined
  >();

  useEffect(() => {
    if (!enabled) {
      setAt(undefined);
      return;
    }
    const update = (): void => {
      const root = thread.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAt(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const turn = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".turn");
      const text = selection.toString().trim();
      /* Zero-sized when the thread is hidden behind another page with the
         highlight still in it -- nothing to point at, so nothing to show. */
      const rect = range.getBoundingClientRect();
      if (!turn || !root.contains(turn) || !text || (!rect.width && !rect.height)) {
        setAt(undefined);
        return;
      }
      // Under the highlight when above it would leave the window.
      const below = rect.top < 48;
      setAt({
        text,
        itemId: turn.dataset["itemId"] ?? "",
        left: rect.left + rect.width / 2,
        top: below ? rect.bottom + 8 : rect.top - 8,
        below,
      });
    };
    document.addEventListener("selectionchange", update);
    // Capture: it is the thread that scrolls, not the window, and the button must follow.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [enabled, thread]);

  if (!at) return null;
  return (
    <button
      type="button"
      className={at.below ? "selection-remember below" : "selection-remember"}
      style={{ top: at.top, left: at.left }}
      title="Keep the highlighted text in this project's notes"
      /* A press would otherwise collapse the highlight before the click lands. */
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const { text, itemId } = at;
        window.getSelection()?.removeAllRanges();
        setAt(undefined);
        onRemember(text, itemId);
      }}
    >
      Remember
    </button>
  );
}
