import { useEffect, useRef, useState } from "react";

/**
 * Copy this, and say that it happened.
 *
 * Through the main process rather than navigator.clipboard. Not because the
 * Clipboard API is missing — Electron does treat this file:// document as a
 * secure context, so it is there — but because it is the one with conditions:
 * it resolves against a focused document and a permission, and rejects rather
 * than throwing when either is absent. Electron's own clipboard has neither
 * precondition. A copy button that quietly does nothing is worse than no button
 * at all, because the user walks away believing they have the text and finds
 * out somewhere else, so the route without conditions is the right one.
 *
 * Which is also why it confirms. Copying produces no visible change anywhere on
 * screen, so without the acknowledgement the only way to find out whether a
 * click registered is to go and paste it.
 */
export function CopyButton({
  text,
  label = "Copy",
  className = "copy-btn",
  title,
}: {
  /** Resolved at click time, so a still-streaming document copies what it has. */
  text: () => string;
  label?: string;
  className?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // A component unmounted while the tick is pending -- a document tab closed,
  // a turn re-rendered -- must not come back to set state on nothing.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (): void => {
    const body = text();
    if (!body) return;
    void window.karen
      .copy(body)
      .then(() => setState("done"))
      .catch(() => setState("failed"))
      .finally(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1400);
      });
  };

  return (
    <button
      type="button"
      className={state === "done" ? `${className} done` : className}
      onClick={copy}
      title={title ?? "Copy to clipboard"}
      /* Announced, not just recoloured: the confirmation is the whole point of
         the control, and a colour change says nothing to a screen reader. */
      aria-live="polite"
    >
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}
