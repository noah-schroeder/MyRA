import { RESEARCH_STAGES, stageIndex } from "../../core/research/stages.ts";

/**
 * What Karen is doing, on every page, with the button that stops it.
 *
 * The composer carries a stop button and a progress line, and the composer is
 * hidden on every page that is not the conversation. So a deep research run --
 * the one thing here that takes forty minutes and is the whole reason to go and
 * look at something else meanwhile -- became invisible the moment you left the
 * chat, and there was no way to stop it without navigating back. Both read as
 * the run having stopped on its own.
 *
 * It runs in the main process and never paused. This is the missing evidence,
 * and the missing control: what stage it is on, one click back to the detail,
 * and Stop.
 */
export function WorkingBar({
  stage,
  note,
  onOpen,
  onStop,
}: {
  stage?: string | undefined;
  note?: string | undefined;
  onOpen: () => void;
  onStop: () => void;
}) {
  const at = stage ? stageIndex(stage) : -1;
  const title = at >= 0 ? RESEARCH_STAGES[at]!.label : stage ? stage : "Working";

  return (
    <div className="rail-working">
      <button
        type="button"
        className="rail-working-open"
        onClick={onOpen}
        title="Back to the conversation"
      >
        <span className="rail-working-head">
          <span className="rail-working-dot" aria-hidden="true" />
          <span className="rail-working-title">{title}</span>
          {/* Only for a pipeline run, where there is a known number of stages
              to be some way through. A plain turn has no such shape. */}
          {at >= 0 ? (
            <span className="rail-working-step">
              {at + 1}/{RESEARCH_STAGES.length}
            </span>
          ) : null}
        </span>
        {note ? <span className="rail-working-note">{note}</span> : null}
      </button>
      <button type="button" className="rail-working-stop" onClick={onStop} aria-label="Stop">
        <span className="stop-square" />
      </button>
    </div>
  );
}
