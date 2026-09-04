import { useEffect, useState } from "react";
import type { ReasoningDialect } from "../types.ts";

/**
 * How hard the model should think, in the words of whatever is answering.
 *
 * It sits beside the research rungs because it is the same kind of decision --
 * how much work goes into this turn -- and a different one from which model
 * answers. But it is gated by the model in a way the research rungs are not,
 * and that is why the row can disappear: three endpoints out of four spell
 * this differently, and some models cannot be told anything about it at all.
 *
 * **Nothing here is translated.** The label is the field that goes on the wire
 * and the buttons are that endpoint's own values, so what is on screen is what
 * is in the request. A shared Off/Brief/Deep vocabulary would read better and
 * would have to claim that OpenAI's "low" and a 24,576-token Gemini budget are
 * the same setting; they are not, and the person who has to discuss one with a
 * colleague or a research-computing admin needs the real name. The plain
 * meaning lives in the tooltip, which is where a translation can be wrong
 * without being load-bearing.
 *
 * The row is absent, rather than disabled, when there is no setting to make.
 * A permanently greyed control teaches only that something is broken. The
 * reason is not thrown away though -- it goes under the model in the bar's
 * tooltip, because "this model always thinks" and "Karen has not checked this
 * endpoint yet" are different situations and only one of them can be acted on.
 */
export function ReasoningBar({ model }: { model: string | undefined }) {
  /*
   * Which model is actually loaded, which is not the same question as which
   * one is configured.
   *
   * Loading a local model from the bar does not change `llm.model` -- the
   * choice was already made, only the residency changed -- so keying this
   * control on the setting alone left it showing the answer for "nothing is
   * loaded" after a model had been loaded and was answering. The template
   * belongs to the weights, so the weights are what this has to watch.
   */
  const [loaded, setLoaded] = useState<string | undefined>();
  useEffect(() => {
    void window.karen.runtimeState().then((s) => setLoaded(s.lemonade.chat?.id));
    return window.karen.onRuntime((s) => setLoaded(s.lemonade.chat?.id));
  }, []);

  const [dialect, setDialect] = useState<ReasoningDialect | undefined>();
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | undefined>();
  /* Whether the absence is a finding or merely an absence. Only a finding is
     worth printing: see `NoControl` in main/llm/reasoning.ts. */
  const [reason, setReason] = useState<string | undefined>();

  /* Re-asked whenever the answering model changes, because the answer is a
     property of that model's template or that provider's API, not of the app.
     `model` is passed in rather than watched here so that one subscription in
     the composer drives this instead of a second one. */
  useEffect(() => {
    let live = true;
    setDialect(undefined);
    setNote(undefined);
    setReason(undefined);
    void window.karen.reasoningCapability().then((r) => {
      if (!live) return;
      setDialect(r.dialect);
      setNote(r.note);
      setReason(r.reason);
      setValue(r.value ?? "");
    });
    return () => { live = false; };
  }, [model, loaded]);

  if (!dialect) {
    /* Small, muted, and still real text, because an empty element cannot be
       hovered and the reason is the whole value here: "this model thinks on
       every turn and cannot be stopped" and "Karen has not checked this
       endpoint yet" are different situations, and the second one is something
       the user can go and fix. Nothing at all is drawn before the first answer
       arrives, so the composer does not flash a label and then replace it. */
    /* Only when Karen actually asked and got an answer. "No model is loaded
       yet" and "this endpoint has not been checked" are not findings about the
       model, and printing "no thinking setting" for either would state
       something Karen does not know -- while the model in question may well
       have one. */
    const found = reason === "none" || reason === "always";
    return found && note ? (
      <span className="reasoning-absent" title={note}>
        {reason === "always" ? "always thinks" : "no thinking setting"}
      </span>
    ) : null;
  }

  const choose = (next: string): void => {
    const wanted = next === value ? "" : next;
    setValue(wanted);
    void window.karen.setReasoning(wanted || undefined);
  };

  return (
    <div
      className="reasoning-bar"
      role="group"
      aria-label={`${dialect.param}, sent to ${dialect.source}`}
    >
      <span
        className="reasoning-param"
        title={
          `The request field this sends, exactly as ${dialect.source} names it. ` +
          (dialect.evidence === "measured"
            ? "Karen read this model's own chat template and confirmed it reads this setting."
            : "Karen checked that this endpoint accepts this field before offering it here.")
        }
      >
        {dialect.param}
      </span>
      <div className="reasoning-row">
        {dialect.levels.map((level) => (
          <button
            key={level.value}
            type="button"
            title={level.hint}
            aria-pressed={value === level.value}
            className={value === level.value ? "mode active" : "mode"}
            /* Pressing the chosen one again clears it, which is the only way
               to get back to the model's own default -- there is no value
               meaning "unset", and inventing one would send a field where the
               user wants none sent. */
            onClick={() => choose(level.value)}
          >
            {level.label}
          </button>
        ))}
      </div>
    </div>
  );
}
