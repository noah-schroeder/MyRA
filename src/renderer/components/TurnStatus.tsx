import { useEffect, useState } from "react";

import { describeProgress, formatElapsed, promptFraction } from "../../core/llm/progress.ts";
import type { LiveProgress } from "../useAgent.ts";

/**
 * What the turn is doing right now, under the thread, for as long as it runs.
 *
 * Between Send and the first word there used to be nothing on screen at all,
 * and on a local model that gap -- the prompt being read -- can run to a
 * minute, so "working" and "stuck" looked identical. This is the answer to
 * one question, "is it still going", so it always shows a clock that moves:
 * a phase that is taking long is visibly taking long rather than frozen.
 *
 * The bar is drawn only when the server reported how far it has read. With
 * no figure there is no bar, rather than an indeterminate one pretending to
 * be a measurement.
 */
export function TurnStatus({ progress }: { progress: LiveProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { value } = progress;
  const phaseFor = now - progress.since;
  const total = now - progress.startedAt;
  const fraction = value.phase === "prompt" ? promptFraction(value) : undefined;

  return (
    <div className="turn-status" role="status" aria-live="polite">
      <span className="turn-status-dot" aria-hidden="true" />
      <span className="turn-status-label">{describeProgress(value)}</span>
      {fraction !== undefined ? (
        <span className="turn-status-bar" aria-hidden="true">
          <span className="turn-status-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </span>
      ) : null}
      <span className="turn-status-time" title="This step · the whole reply so far">
        {formatElapsed(phaseFor)}
        {total - phaseFor >= 1000 ? ` · ${formatElapsed(total)}` : ""}
      </span>
    </div>
  );
}
