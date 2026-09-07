import { useCallback, useState } from "react";

/**
 * A collapsible heading in the rail.
 *
 * The rail stacks Projects on top of the conversations, and both grow without
 * limit -- a dozen projects push the history down until Recent is a two-row
 * window onto months of work. Collapsing is the file-manager answer to that:
 * fold away the section you are not using and give its space to the one you
 * are. The triangle is the affordance people already know, so it is the whole
 * control: the heading is the button.
 *
 * A folded section shows its count. Otherwise collapsing hides work with no
 * sign that anything is there, which is how a fold turns into a lost file.
 */
export function RailSection({
  label,
  open,
  count,
  onToggle,
}: {
  label: string;
  open: boolean;
  /** Shown while folded, so nothing disappears silently. */
  count?: number;
  onToggle: () => void;
}) {
  return (
    <h2 className="rail-heading">
      <button type="button" className="rail-disclosure" aria-expanded={open} onClick={onToggle}>
        <svg className="rail-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 1 L7.5 5 L2.5 9 Z" fill="currentColor" />
        </svg>
        <span className="rail-disclosure-label">{label}</span>
        {!open && count !== undefined ? (
          <span className="rail-disclosure-count">{count}</span>
        ) : null}
      </button>
    </h2>
  );
}

const key = (name: string): string => `karen.rail.${name}.collapsed`;

/**
 * Whether a section is open, remembered across launches.
 *
 * Local to the window, like the artifact panel's width: it is a decision about
 * how this person reads their own rail, not something main has any business
 * storing. Folded is the value written, so storage that fails or is cleared
 * leaves every section open rather than every section hidden.
 */
export function useRailSection(name: string): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key(name)) !== "1";
    } catch {
      return true;
    }
  });

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    // Best effort: a window with storage blocked still folds, it just forgets.
    try {
      localStorage.setItem(key(name), next ? "0" : "1");
    } catch {
      /* ignore */
    }
  }, [name, open]);

  return { open, toggle };
}
