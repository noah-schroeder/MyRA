import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOUR_STEPS, type TourPage } from "../../core/tour/steps.ts";
import { placeCard, unionRect, type Rect } from "../../core/tour/place.ts";

/**
 * The first-run tour: a dim overlay with a hole cut around the real control
 * being described, and the real page drawn behind it.
 *
 * It drives navigation itself rather than only pointing -- `onGoTo` is called
 * on every step, and the card is not measured until `page` (read back as a
 * prop, not assumed) actually matches what the step asked for. Reading it back
 * rather than assuming a synchronous update is what keeps Replay from
 * Settings safe: that button closes a modal and jumps here from whatever page
 * was open, and the alternative -- measuring immediately -- would spotlight a
 * rail icon while the page behind it was still the one Settings was open over.
 *
 * The catcher beneath the hole and the card is an ordinary opaque-to-events
 * div: nothing here needs `pointer-events: none` tricks to stop a click
 * reaching the real button underneath, because a plain element with default
 * `pointer-events` already wins the hit test over anything painted below it.
 */

const PREFERRED_SIDE: Record<string, "right" | "below" | "above"> = {
  composer: "above",
  "composer-attach": "above",
  "composer-dictate": "above",
  "composer-research": "above",
  "topbar-model": "below",
};

/** Every anchor not named above is a rail icon, and wants the card to its right. */
function sideFor(anchor: string | undefined): "right" | "below" | "above" {
  return (anchor && PREFERRED_SIDE[anchor]) || "right";
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function Tour({
  page,
  onGoTo,
  onDone,
}: {
  /** The app's own current page, read back to confirm a navigation landed. */
  page: string;
  onGoTo: (page: TourPage) => void;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;

  const finish = (): void => {
    onGoTo("chat");
    onDone();
  };

  // Asked on every step, including ones already on the right page -- cheap,
  // and it is what makes Replay-from-Settings correct: the app may be on any
  // page when the tour restarts, and this is the only thing that moves it.
  useEffect(() => {
    onGoTo(step.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useLayoutEffect(() => {
    if (page !== step.page) return undefined;

    const measure = (): void => {
      const els = step.anchor ? document.querySelectorAll(`[data-tour="${CSS.escape(step.anchor)}"]`) : [];
      const anchor = unionRect(Array.from(els).map(rectOf));
      setSpot(anchor);
      const cardBox = cardRef.current?.getBoundingClientRect();
      const cardSize = cardBox && cardBox.width > 0 ? { width: cardBox.width, height: cardBox.height } : { width: 320, height: 200 };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPos(placeCard(anchor, cardSize, viewport, sideFor(step.anchor)));
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [index, page, step.anchor, step.page]);

  // The primary action takes focus every step, so Enter advances without a
  // second keyboard handler for it -- and so a keystroke meant for the tour
  // can never land in the composer it just dimmed.
  useEffect(() => {
    nextRef.current?.focus();
  }, [index]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, TOUR_STEPS.length - 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const RING = 6;

  return (
    <div className="tour-catcher">
      {spot ? (
        <div
          className="tour-hole"
          style={{
            left: spot.left - RING,
            top: spot.top - RING,
            width: spot.width + RING * 2,
            height: spot.height + RING * 2,
          }}
        />
      ) : (
        <div className="tour-backdrop" />
      )}

      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      >
        <p className="tour-count">
          {index + 1} of {TOUR_STEPS.length}
        </p>
        <h2 className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="ghost" onClick={finish}>
            Skip
          </button>
          <span className="tour-spacer" />
          {index > 0 ? (
            <button type="button" className="ghost" onClick={() => setIndex((i) => i - 1)}>
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            ref={nextRef}
            onClick={last ? finish : () => setIndex((i) => i + 1)}
          >
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
