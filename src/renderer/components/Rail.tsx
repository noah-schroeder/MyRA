import type { ReactNode } from "react";

/**
 * The left rail: where you are, and where else you can go.
 *
 * These four destinations used to be chips in the top bar, competing for space
 * with the research controls and reading as a toolbar rather than as the app's
 * structure. Moving them here empties the top bar for the one thing that
 * belongs there — which model is answering — and gives the rail a job beyond
 * holding a list.
 *
 * Icons are inline SVG because no remote asset may ever be fetched: an icon
 * font or a sprite from a CDN would be a network request, and this app makes
 * none it did not choose.
 */

const ICONS: Record<string, ReactNode> = {
  new: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  meeting: (
    <>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  runs: (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </>
  ),
  /* A stack of layers: what a quantised model is, and distinct at 16px from
     the list icon above it. */
  models: (
    <>
      <path d="m12 3 8 4.5-8 4.5-8-4.5Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 16.5 8 4.5 8-4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" />
    </>
  ),
};

export function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: keyof typeof ICONS | string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "rail-nav-item active" : "rail-nav-item"}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {ICONS[icon]}
      </svg>
      <span>{label}</span>
    </button>
  );
}
