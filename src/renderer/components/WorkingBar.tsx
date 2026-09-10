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
  label,
  step,
  steps,
  openLabel,
  onOpen,
  onStop,
}: {
  stage?: string | undefined;
  note?: string | undefined;
  /**
   * What this is, when it is not a research stage.
   *
   * A peer review and a paper section are the other two things that run for
   * minutes in the main process, and they have their own counted shape -- one of
   * three reviewers -- rather than the pipeline's eleven stages. Given a label,
   * the bar names that instead of looking the stage up.
   */
  label?: string | undefined;
  step?: number | undefined;
  steps?: number | undefined;
  openLabel?: string | undefined;
  onOpen: () => void;
  onStop: () => void;
}) {
  const at = stage ? stageIndex(stage) : -1;
  const title = label ?? (at >= 0 ? RESEARCH_STAGES[at]!.label : stage ? stage : "Working");
  /* The panel's own count where there is one, the pipeline's where there is
     not. Both are "how far through", and the bar draws them the same way. */
  const counted =
    steps !== undefined && step !== undefined
      ? `${step + 1}/${steps}`
      : at >= 0
        ? `${at + 1}/${RESEARCH_STAGES.length}`
        : undefined;

  return (
    <div className="rail-working">
      <button
        type="button"
        className="rail-working-open"
        onClick={onOpen}
        title={openLabel ?? "Back to the conversation"}
      >
        <span className="rail-working-head">
          <span className="rail-working-dot" aria-hidden="true" />
          <span className="rail-working-title">{title}</span>
          {/* Only where there is a known number of steps to be some way
              through. A plain turn has no such shape. */}
          {counted ? <span className="rail-working-step">{counted}</span> : null}
        </span>
        {note ? <span className="rail-working-note">{note}</span> : null}
      </button>
      <button type="button" className="rail-working-stop" onClick={onStop} aria-label="Stop">
        <span className="stop-square" />
      </button>
    </div>
  );
}
