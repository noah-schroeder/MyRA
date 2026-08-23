import { useState } from "react";

/**
 * A model's reasoning, collapsed by default.
 *
 * Reasoning is context, not content: useful when you go looking for it, noise
 * when you are reading the answer. So it stays shut until asked for.
 *
 * The exception is while it is still arriving. A collapsed block with nothing
 * moving in it is indistinguishable from a stalled agent -- and on a slow local
 * inference server the reasoning phase is where most of the wait happens. So
 * the header carries a live tail of the text until the block completes, then
 * settles into a static summary. It never expands on its own.
 */
export function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  // The tail rather than the head: the newest thought is the informative one.
  const tail = text.replace(/\s+/g, " ").trim().slice(-90);

  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button
        className="reasoning-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide reasoning" : "Show reasoning"}
      >
        <span className="reasoning-caret" aria-hidden="true">▸</span>
        <span className="reasoning-label">Reasoning</span>
        {streaming ? (
          <span className="reasoning-tail">{tail || "…"}</span>
        ) : (
          <span className="reasoning-count">{words} {words === 1 ? "word" : "words"}</span>
        )}
      </button>
      {open ? <div className="reasoning-body">{text}</div> : null}
    </div>
  );
}
