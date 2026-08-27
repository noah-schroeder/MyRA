import { useEffect, useState } from "react";
import type { RuntimeState, Usage } from "../types.ts";

/**
 * How much of the model's memory this conversation is using.
 *
 * A model can only see a fixed number of tokens at once, and running out of
 * them is the single most confusing failure an assistant has: it starts
 * forgetting the beginning of the conversation, or stops answering, with
 * nothing on screen having changed. Making the limit visible turns that from a
 * mystery into a gauge — and since Karen summarises automatically before it
 * fills, the gauge mostly exists to explain why that happened.
 *
 * Shown only when the number is real. Karen knows the window for a model it
 * started, because it asks that server; for an endpoint someone else runs there
 * is no honest figure, so this falls back to a plain token count rather than
 * inventing a denominator.
 */

/**
 * 8192 is "8k", not "8.2k".
 *
 * Context windows are powers of two and are universally written that way, so
 * dividing by 1000 produces a number nobody recognises: a model everyone calls
 * 128k would read as "131.1k".
 */
function short(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  return `${k >= 10 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
}

export function ContextMeter({ usage }: { usage: Usage | undefined }) {
  const [runtime, setRuntime] = useState<RuntimeState | undefined>();

  /*
   * The window is read from the runtime, not from the last reply.
   *
   * Waiting for a reply would mean the gauge appears out of nowhere after the
   * first message, which is exactly when someone is least equipped to work out
   * what it is. Known from the moment a model is loaded, it starts empty and
   * fills, which explains itself.
   */
  useEffect(() => {
    void window.karen.runtimeState().then(setRuntime);
    return window.karen.onRuntime(setRuntime);
  }, []);

  const loaded = runtime?.config.useForChat && runtime.lemonade.state === "ready";
  /*
   * Only what the last reply reported. The old llama-server was asked directly
   * via /props; Lemonade does not expose a per-conversation window, so there is
   * no better figure available and a guess would be worse than the honest one
   * that arrives with each response.
   */
  const limit = usage?.contextLimit;
  void loaded;
  const used = usage?.contextTokens ?? 0;

  if (!usage && !limit) return null;

  if (!limit) {
    // No window to measure against: report what was spent, which is all that
    // can honestly be said.
    return (
      <span className="meter-plain">{(usage?.total ?? 0).toLocaleString()} tokens this conversation</span>
    );
  }

  const share = Math.min(1, used / limit);
  // 75% is where Karen summarises, so the bar changes colour just before it
  // acts rather than at some other number that would need explaining.
  const tone = share >= 0.75 ? "full" : share >= 0.5 ? "half" : "";

  return (
    <span
      className="meter"
      title={
        `${used.toLocaleString()} of ${limit.toLocaleString()} tokens of context in use. ` +
        `Karen summarises the earlier part of the conversation when this gets close to full.`
      }
    >
      <span className={`meter-bar ${tone}`}>
        <span style={{ width: `${share * 100}%` }} />
      </span>
      <span className="meter-text">
        {short(used)} / {short(limit)}
      </span>
    </span>
  );
}
