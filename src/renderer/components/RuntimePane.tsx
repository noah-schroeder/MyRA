/**
 * Settings → Runtime.
 *
 * Almost all of this pane is now LemonadePane, which reports what the daemon
 * says about the machine and offers its engines and models. What remains here
 * are the two settings that are MyRA's own rather than the backend's: whether
 * the local model answers chat, and whether it starts with the app.
 */

import { useCallback, useEffect, useState } from "react";

import type { RuntimeState, Settings } from "../types.ts";
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

/**
 * The Hugging Face token, and the one choice about when it is used.
 *
 * MyRA's downloads are anonymous by default -- `core/childEnv.ts` no longer
 * forwards an ambient `HF_TOKEN` from the shell, on purpose -- and most
 * models need no account at all. A gated repository is the exception, and it
 * needs the daemon restarted to carry the token: lemond reads it once, at its
 * own spawn, and there is no per-request header a download it starts itself
 * would take instead.
 *
 * Follows `DatabaseKeysPane.tsx`'s own field exactly -- write-only input, a
 * presence probe, save on blur, an empty string deletes -- because that is
 * already the pattern users see for every other key in this app.
 */
function HfTokenField() {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  /* Whether one is stored, never what it is -- the same reason a provider's
     key field never shows the key back. */
  const [hasKey, setHasKey] = useState<boolean | undefined>();

  const checkKey = useCallback(async (): Promise<void> => {
    const v = await window.myra.secretsBackend();
    setHasKey(Boolean(v.present?.hfToken));
  }, []);

  useEffect(() => {
    void window.myra.getSettings().then(setSettings);
    void checkKey();
    return window.myra.onSettings(setSettings);
  }, [checkKey]);

  if (!settings) return null;

  const setUse = (use: Settings["hfTokenUse"]): void => {
    void window.myra.updateSettings({ hfTokenUse: use }).then(setSettings);
  };

  return (
    <section className="pane-block">
      <h4 className="pane-sub">Hugging Face token</h4>
      <p className="hint">
        Most models download from Hugging Face with no account at all. Some publishers gate
        theirs behind an accepted licence, and those need a token: sign in at huggingface.co,
        go to Settings → Access Tokens, create one with read access, and paste it below. You
        still have to accept each gated model’s own licence on its page before MyRA can fetch it
        — the model card links to it.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void window.myra.openExternal("https://huggingface.co/settings/tokens")}
      >
        Get a token ↗
      </button>

      <label className="field">
        <span>Access token</span>
        <input
          className="input-line"
          type="password"
          placeholder={
            hasKey
              ? "A token is stored. Type a new one to replace it."
              : "Not set. Encrypted into your login keyring when saved."
          }
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            if (!key) return;
            void window.myra.setSecret("hfToken", key).then(async () => {
              setKey("");
              setNote("Saved.");
              await checkKey();
            });
          }}
        />
      </label>
      {note ? <p className="provider-note">{note}</p> : null}
      {hasKey ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void window.myra.setSecret("hfToken", "").then(async () => {
              setNote("Token removed.");
              await checkKey();
            })
          }
        >
          Remove the stored token
        </button>
      ) : null}

      {/* Only worth choosing between once there is a token to choose how to
          use -- with none stored, every gated download simply refuses and
          says where to add one. */}
      {hasKey ? (
        <div role="radiogroup" aria-label="When the token is sent">
          <label className="check">
            <input
              type="radio"
              name="hfTokenUse"
              checked={settings.hfTokenUse === "gated"}
              onChange={() => setUse("gated")}
            />
            <span>
              Only for models that need it — MyRA restarts the model server once, just for that
              download
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="hfTokenUse"
              checked={settings.hfTokenUse === "always"}
              onChange={() => setUse("always")}
            />
            <span>Always send my token — every download, gated or not</span>
          </label>
        </div>
      ) : null}
    </section>
  );
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
              {/* A button rather than underlined text: this is the one control
                  in the pane somebody goes looking for when a model will not
                  load, and it read as a footnote. */}
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={showLog}
                onClick={() => setShowLog(!showLog)}
              >
                {showLog ? "Hide" : "Show"} the engine log
              </button>
              {showLog ? <pre className="runtime-log">{state.lemonade.log.join("\n")}</pre> : null}
            </>
          ) : null}
        </section>
      ) : null}

      <HfTokenField />
    </div>
  );
}
