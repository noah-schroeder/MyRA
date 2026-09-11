/**
 * Where the tour's card goes, given the rectangle it is pointing at.
 *
 * Split out of the component for the reason meterBars.ts is: Node's test
 * runner strips types from a .ts file but does not compile .tsx, so this
 * arithmetic is the only part of the tour that can be tested directly. The
 * part worth pinning is the clamp -- invisible until someone runs the app in
 * a small window, and a card pushed off screen is a tour that cannot be
 * advanced.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "right" | "left" | "below" | "above" | "center";

/** The bounding box around every rect an anchor resolved to, or null for none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** Space kept between the spotlighted rect and the card. */
const GAP = 14;
/** Space kept between the card and the edge of the window. */
const MARGIN = 16;

/**
 * Where the card sits, before or after clamping.
 *
 * `preferred` names which side of the anchor the card starts on -- a rail icon
 * wants it to the right, a top-bar control below, a composer control above.
 * "right" flips to "left" on its own when there is not enough room, because the
 * rail sits at the window's own left edge and never needs the reverse. Both
 * axes are then clamped into the viewport with a margin, which is what keeps a
 * card readable in a narrow window rather than merely on screen.
 */
export function placeCard(
  anchor: Rect | null,
  card: Size,
  viewport: Size,
  preferred: "right" | "below" | "above" = "right",
): { left: number; top: number; side: Side } {
  if (!anchor) {
    return clamp(
      { left: (viewport.width - card.width) / 2, top: (viewport.height - card.height) / 2 },
      card,
      viewport,
      "center",
    );
  }

  if (preferred === "below") {
    return clamp({ left: anchor.left, top: anchor.top + anchor.height + GAP }, card, viewport, "below");
  }
  if (preferred === "above") {
    return clamp({ left: anchor.left, top: anchor.top - GAP - card.height }, card, viewport, "above");
  }

  const roomRight = viewport.width - (anchor.left + anchor.width) - GAP;
  if (roomRight < card.width && anchor.left - GAP - card.width >= 0) {
    return clamp({ left: anchor.left - GAP - card.width, top: anchor.top }, card, viewport, "left");
  }
  return clamp({ left: anchor.left + anchor.width + GAP, top: anchor.top }, card, viewport, "right");
}

function clamp(
  pos: { left: number; top: number },
  card: Size,
  viewport: Size,
  side: Side,
): { left: number; top: number; side: Side } {
  const maxLeft = Math.max(MARGIN, viewport.width - card.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - card.height - MARGIN);
  return {
    left: Math.min(Math.max(pos.left, MARGIN), maxLeft),
    top: Math.min(Math.max(pos.top, MARGIN), maxTop),
    side,
  };
}
