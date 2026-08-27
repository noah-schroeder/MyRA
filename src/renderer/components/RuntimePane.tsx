/**
 * Settings → Runtime.
 *
 * Almost all of this pane is now LemonadePane, which reports what the daemon
 * says about the machine and offers its engines and models. What remains here
 * are the two settings that are Karen's own rather than the backend's: whether
 * the local model answers chat, and whether it starts with the app.
 */

import { useCallback, useEffect, useState } from "react";

import type { RuntimeState } from "../types.ts";
import { LemonadePane } from "./LemonadePane.tsx";

export function RuntimePane() {
  const [state, setState] = useState<RuntimeState | undefined>();
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setState((await window.karen.runtimeState()) as RuntimeState);
  }, []);

  useEffect(() => {
    void refresh();
    return window.karen.onRuntime((next) => setState(next as RuntimeState));
  }, [refresh]);

  const patch = async (change: Record<string, unknown>): Promise<void> => {
    await window.karen.runtimeConfig(change);
    await refresh();
  };

  return (
    <div className="pane">
      <p className="pane-lead">
        Karen can run models on this machine, so nothing you type leaves it. This is optional — if
        you already point Karen at an endpoint of your own, you can ignore all of it.
      </p>

      <LemonadePane />

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
              checked={state.config.startOnLaunch}
              onChange={(e) => void patch({ startOnLaunch: e.target.checked })}
            />
            Load {state.config.activeModel ?? "the last model"} when Karen opens
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
