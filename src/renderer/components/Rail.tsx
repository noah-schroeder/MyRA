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
  /* A framed picture with a horizon in it. Reads as "a picture" at 16px
     without borrowing the camera shape, which would say "take a photo"
     rather than "make one". */
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 5-5 4 4 2.5-2.5L20 17" />
    </>
  ),
  /* A nib on a page. Reads as "writing" at 16px without borrowing the
     microphone shape above it, which already means a meeting. */
  paper: (
    <>
      <path d="M5 3.5h9l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20Z" />
      <path d="M14 3.5V8a1 1 0 0 0 1 1h4" />
      <path d="m9 17 .8-2.6L14 10.2l1.8 1.8-4.2 4.2Z" />
    </>
  ),
  /* A page with a magnifier over it: reading somebody else's document rather
     than writing one, which is the distinction from `paper` above it. */
  review: (
    <>
      <path d="M5 3.5h9l5 5v4" />
      <path d="M14 3.5V8a1 1 0 0 0 1 1h4" />
      <path d="M5 3.5V20A1.5 1.5 0 0 0 6.5 21.5H12" />
      <circle cx="16.5" cy="16.5" r="3.5" />
      <path d="m19.2 19.2 2.3 2.3" />
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
  /* Angle brackets: what a person recognises as "this is for programs",
     and distinct at 16px from the layered stack above it. */
  api: (
    <>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
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
  tour,
}: {
  icon: keyof typeof ICONS | string;
  label: string;
  active?: boolean;
  onClick: () => void;
  /** A hook for the first-run tour to spotlight this button by. */
  tour?: string;
}) {
  return (
    <button
      type="button"
      className={active ? "rail-nav-item active" : "rail-nav-item"}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      {...(tour ? { "data-tour": tour } : {})}
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
