import { useRef, useState } from "react";
import type { MessageStats } from "../types.ts";
import { formatSpeed } from "../../core/llm/speed.ts";

/**
 * The speed line under a finished reply, with the rest of the numbers on hover.
 *
 * Positioning copies Citations.tsx's `cite-card` exactly, for the same reason:
 * this app has no portals, so a hover card is a fixed-position sibling measured
 * from the trigger's own `getBoundingClientRect()` rather than something laid
 * out by the flow. Absolute positioning inside the scrolling thread clipped at
 * the window edge and widened the scroll area on hover.
 */

const CARD_W = 250;
const GAP = 8;

export function MessageStatsLine({ stats }: { stats: MessageStats }) {
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | undefined>();
  const ref = useRef<HTMLSpanElement>(null);

  const show = (): void => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(
      Math.max(GAP, r.left + r.width / 2 - CARD_W / 2),
      Math.max(GAP, window.innerWidth - CARD_W - GAP),
    );
    setAt(
      r.top < 240
        ? { left, top: r.bottom + GAP }
        : { left, bottom: window.innerHeight - r.top + GAP },
    );
  };
  const hide = (): void => setAt(undefined);

  return (
    <span className="stats-wrap">
      <span
        ref={ref}
        className="stats-line"
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {formatSpeed(stats)}
      </span>
      {at ? (
        <span
          className="stats-card"
          role="tooltip"
          style={{
            left: at.left,
            ...(at.top !== undefined ? { top: at.top } : {}),
            ...(at.bottom !== undefined ? { bottom: at.bottom } : {}),
          }}
        >
          <span className="stats-row">
            <span>Prompt</span>
            <span>
              {stats.promptTokens.toLocaleString()} tok
              {stats.promptPerSecond !== undefined ? ` · ${stats.promptPerSecond.toFixed(1)} tok/s` : ""}
            </span>
          </span>
          <span className="stats-row">
            <span>Generated</span>
            <span>
              {stats.completionTokens.toLocaleString()} tok
              {stats.tokensPerSecond !== undefined ? ` · ${stats.tokensPerSecond.toFixed(1)} tok/s` : ""}
            </span>
          </span>
          {stats.ttftMs !== undefined ? (
            <span className="stats-row">
              <span>First token</span>
              <span>{(stats.ttftMs / 1000).toFixed(2)}s</span>
            </span>
          ) : null}
          <span className="stats-row">
            <span>Total</span>
            <span>{(stats.totalMs / 1000).toFixed(1)}s</span>
          </span>
          <span className="stats-note">
            {stats.measured
              ? "Timed by llama.cpp."
              : "Timed by Karen's own clock — this endpoint does not report its own timings."}
          </span>
        </span>
      ) : null}
    </span>
  );
}
