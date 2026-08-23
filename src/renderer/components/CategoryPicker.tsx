import { useEffect, useRef, useState } from "react";
import type { SearchCategory } from "../types.ts";

/**
 * Multi-select over SearXNG categories.
 *
 * SearXNG accepts several categories in one request as a comma-separated
 * `categories=` parameter, so a sweep can span e.g. science and news at once.
 * That is stored verbatim as the value here -- no array, so the same string
 * survives a round trip through the editable research plan.
 *
 * A native <select multiple> would technically do this, but it renders as a
 * scrolling list box that is easy to clear by accident with a stray click. A
 * checkbox popover makes each toggle deliberate and shows the current selection
 * without being open.
 */
export function CategoryPicker({
  value,
  options,
  loading,
  onChange,
}: {
  /** Comma-separated category names. */
  value: string;
  options: SearchCategory[];
  loading: boolean;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const selected = value.split(",").map((c) => c.trim()).filter(Boolean);

  // Dismiss on an outside click or Escape, like every other menu on the system.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((c) => c !== name)
      : [...selected, name];
    // Never commit an empty selection: a search with no category searches
    // nothing, so the last one standing stays on.
    if (next.length === 0) return;
    onChange(next.join(","));
  };

  const label = loading
    ? "loading…"
    : selected.length === 0
      ? "none"
      : selected.length === 1
        ? selected[0]!
        : `${selected[0]} +${selected.length - 1}`;

  const engines = options
    .filter((o) => selected.includes(o.name))
    .reduce((n, o) => n + o.engines, 0);

  return (
    <div className="catpick" ref={box}>
      <button
        className="select select-sm catpick-btn"
        disabled={loading || options.length === 0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={selected.length ? `Searching: ${selected.join(", ")}` : "Pick one or more categories"}
      >
        {label}
        {engines > 0 ? <span className="catpick-count">{engines}</span> : null}
      </button>

      {open ? (
        <div className="catpick-menu" role="group" aria-label="Search categories">
          {options.map((o) => (
            <label key={o.name} className="catpick-row">
              <input
                type="checkbox"
                checked={selected.includes(o.name)}
                onChange={() => toggle(o.name)}
              />
              <span className="catpick-name">{o.name}</span>
              <span className="catpick-engines">{o.engines}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
