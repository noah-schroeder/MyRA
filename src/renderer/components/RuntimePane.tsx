/**
 * Settings → Runtime.
 *
 * Almost all of this pane is now LemonadePane, which reports what the daemon
 * says about the machine and offers its engines and models. What remains here
 * are the two settings that are MyRA's own rather than the backend's: whether
 * the local model answers chat, and whether it starts with the app.
 */

import { useCallback, useEffect, useState } from "react";

import type { RuntimeState } from "../types.ts";
import { LemonadePane } from "./LemonadePane.tsx";

/**
 * A model's name, not the path it happens to live at.
 *
 * `activeModel` is whatever the daemon calls the model, which for one of the
 * user's own files is an absolute path -- a checkbox label ran to ninety
 * characters of `/home/.../LiquidAI__LFM2.5-2.6B-GGUF/...`. The last segment
 * is the part that identifies it; the full path stays as the title.
 */
function shortName(id?: string): string | undefined {
  if (!id) return undefined;
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

export function RuntimePane({ onOpenHub }: { onOpenHub?: () => void }) {
  const [state, setState] = useState<RuntimeState | undefined>();
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setState((await window.myra.runtimeState()) as RuntimeState);
  }, []);

  useEffect(() => {
    void refresh();
    return window.myra.onRuntime((next) => setState(next as RuntimeState));
  }, [refresh]);

  const patch = async (change: Record<string, unknown>): Promise<void> => {
    await window.myra.runtimeConfig(change);
    await refresh();
  };

  return (
    /* Wider than the 62ch reading measure the other tabs use: this tab is a
       grid of engine cards, and at 62ch it is a single column with half the
       dialog empty beside it. The prose inside keeps its own measure. */
    <div className="pane pane-wide">
      <p className="pane-lead">
        MyRA can run models on this machine, so nothing you type leaves it. This is optional — if
        you already point MyRA at an endpoint of your own, you can ignore all of it.
      </p>

      {/* Engines only. The models themselves are a screen of their own -- this
          tab points at it rather than keeping a second, drifting copy. */}
      <LemonadePane section="engines" {...(onOpenHub ? { onOpenModels: onOpenHub } : {})} />

      {state ? (
        <section className="pane-block">
          <h4 className="pane-sub">Settings</h4>
          <label className="check">
            <input
              type="checkbox"
              checked={state.config.useForChat}
              onChange={(e) => void patch({ useForChat: e.target.checked })}
            />
            Use the model running here for chat and research
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.config.importForeignModels}
              onChange={(e) => void patch({ importForeignModels: e.target.checked })}
            />
            <span title="Read-only, and entirely local — no network request is involved.">
              Offer models already downloaded by LM Studio and Ollama
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={state.config.startOnLaunch}
              onChange={(e) => void patch({ startOnLaunch: e.target.checked })}
            />
            <span title={state.config.activeModel}>
              Load {shortName(state.config.activeModel) ?? "the last model"} when MyRA opens
            </span>
          </label>

          {state.lemonade.log.length ? (
            <>
              <button type="button" className="link" onClick={() => setShowLog(!showLog)}>
                {showLog ? "Hide" : "Show"} the engine log
              </button>
              {showLog ? <pre className="runtime-log">{state.lemonade.log.join("\n")}</pre> : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
