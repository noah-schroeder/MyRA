/**
 * A deep run, drawn as the sequence it is.
 *
 * The whole of a run's visible progress used to be one line above the
 * composer, replaced several times a second by whatever the current stage was
 * saying. It answered "is anything happening" and nothing else: not how far
 * along, not what is still to come, and not whether the four minutes of
 * silence in `retrieve` were normal. Reported as wanting the steps visible in
 * the conversation instead, which is also where the report itself will land.
 *
 * The stage list comes from core, where a test pins it to the pipeline's own
 * `checkpoint()` calls -- so this cannot drift into showing a shorter run than
 * the one the user is waiting on.
 */

import { RESEARCH_STAGES, stageIndex } from "../../core/research/stages.ts";

export function ResearchProgress({
  stage,
  note,
}: {
  /** The stage now running, or undefined before the first one is announced. */
  stage: string | undefined;
  /** The live detail line from within that stage. */
  note: string | undefined;
}): React.JSX.Element {
  const at = stage ? stageIndex(stage) : -1;
  const done = at < 0 ? 0 : at;
  return (
    <section className="rprog" aria-label="Research progress">
      <header className="rprog-head">
        <span className="rprog-title">Researching</span>
        {/* A count, because "step 4 of 11" is the thing a status line never
            managed to say and the only reason to draw this at all. */}
        <span className="rprog-count">
          {at < 0 ? "starting…" : `step ${at + 1} of ${RESEARCH_STAGES.length}`}
        </span>
      </header>
      <ol className="rprog-steps">
        {RESEARCH_STAGES.map((s, i) => {
          const state = i < done ? "done" : i === at ? "now" : "todo";
          return (
            <li key={s.id} className={`rprog-step rprog-${state}`}>
              <span className="rprog-dot" aria-hidden="true" />
              <span className="rprog-label">{s.label}</span>
              {/* The detail belongs to the running step and nowhere else: under
                  a finished one it would read as that step's result. */}
              {state === "now" ? (
                <span className="rprog-note">{note ?? s.hint}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="rprog-foot">
        You can leave this running — nothing else will be asked once the plan is approved.
      </p>
    </section>
  );
}
