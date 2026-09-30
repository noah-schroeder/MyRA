/**
 * One engine's default runtime, inside its card on Settings → Runtime.
 *
 * It answers a question the card above it raises and used to leave open: with
 * Vulkan and ROCm both installed, which one do my models run on? The answer is
 * a dropdown that takes effect at once, for every model that has not picked a
 * runtime of its own on its Tune page -- and a button for the moment that is
 * not what you want, because the models that *did* pick one are the ones a
 * change of default does not reach.
 *
 * **Shown only where there is a choice.** An engine with one runtime installed
 * has nothing to default to, and a dropdown with a single entry is a control
 * that invites a press and does nothing. The daemon's own config decides which
 * engines have the setting at all (`backendDefault.ts`), so this renders
 * nothing for one it reported no state for rather than guessing.
 *
 * **The reset names where it is going.** "Reset all 3 to AMD (ROCm)" says what
 * will happen to the three; "Reset" would make somebody work it out from the
 * dropdown above it. It clears the runtime and nothing else -- the same models'
 * context windows and extra arguments are left as they are -- and the line above
 * it names the runtimes being given up, since "3 models" does not say whether
 * they are the ones you meant.
 */

import {
  chosenSentence,
  defaultChoices,
  followSentence,
  installedRuntimes,
  resetLabel,
  type EngineBackendState,
} from "../../core/runtime/backendDefault.ts";
import type { EngineInfo } from "../../core/runtime/systemInfo.ts";

export function RuntimeDefault({
  engine,
  state,
  busy,
  notice,
  reload,
  onChoose,
  onReset,
}: {
  engine: EngineInfo;
  /** Absent until the daemon has been asked, and for an engine with no such setting. */
  state: EngineBackendState | undefined;
  busy: boolean;
  /** What the last change did, worded by `changeNotice`. */
  notice?: { text: string; warn: boolean } | undefined;
  /** Offered when the one model that is running would change runtime on a reload. */
  reload?: { name: string; run: () => void } | undefined;
  onChoose: (backend: string) => void;
  onReset: () => void;
}): React.JSX.Element | null {
  const installed = installedRuntimes(engine);
  if (installed.length < 2 || !state) return null;

  const choices = defaultChoices({
    installed,
    configured: state.configured,
    resolved: state.resolved,
  });
  const target = choices.find((c) => c.value === state.configured)?.label ?? state.configured;
  const follows = followSentence(state.models);

  return (
    <div className="lem-default">
      <label className="lem-default-row">
        <span className="lem-default-label">Default runtime</span>
        <select
          className="lem-default-select"
          value={state.configured}
          disabled={busy}
          onChange={(e) => onChoose(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      <p className="lem-default-note">
        Models start on this unless you pick a runtime on their Tune page.
      </p>

      {state.chose.length ? (
        <>
          <p className="lem-default-chose">{chosenSentence(state.chose, state.models)}</p>
          <button
            type="button"
            className="lem-install"
            disabled={busy}
            onClick={onReset}
            title={
              "Takes away the runtime each of these models picked for itself, so they follow " +
              "the default. Their context window and other settings are left as they are."
            }
          >
            {resetLabel(state.chose.length, target)}
          </button>
        </>
      ) : follows ? (
        <p className="lem-default-note">{follows}</p>
      ) : null}

      {notice ? (
        <p className={notice.warn ? "lem-default-notice warn" : "lem-default-notice"} role="status">
          {notice.text}
        </p>
      ) : null}
      {notice && reload ? (
        <button type="button" className="lem-install" disabled={busy} onClick={reload.run}>
          Reload {reload.name} now
        </button>
      ) : null}
    </div>
  );
}
