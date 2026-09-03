import { useEffect, useState } from "react";
import type { PromptRequest, Provider, Settings } from "../types.ts";
import type { InstalledModel } from "../../main/runtime/lemonadeApi.ts";
import { qualify } from "../../core/providers.ts";
import { priceLabel } from "../../core/pricing.ts";
import { JOIN, OTHER } from "../../core/research/questions.ts";

/**
 * The research pipeline asking the user something mid-run.
 *
 * Two kinds, because the pipeline only ever asks two things: a short answer to
 * a clarifying question, and a review of the generated plan before it is acted
 * on. Skipping is always allowed and returns undefined -- the pipeline treats
 * "no answer" as a real answer, and forcing one would only produce noise.
 */
export function UiDialog({
  request,
  onAnswer,
}: {
  request: PromptRequest;
  onAnswer: (id: string, answer: string | undefined) => void;
}) {
  const [value, setValue] = useState(request.prefill ?? "");

  useEffect(() => setValue(request.prefill ?? ""), [request.id, request.prefill]);

  const submit = (): void => onAnswer(request.id, value.trim() ? value : undefined);
  const skip = (): void => onAnswer(request.id, undefined);

  if (request.method === "choice") {
    return <ChoiceDialog request={request} onAnswer={onAnswer} />;
  }
  if (request.method === "models") {
    return <ModelsDialog request={request} onAnswer={onAnswer} />;
  }

  /*
   * A confirm is not an input with two buttons.
   *
   * "Skip" on a question means "no answer, carry on"; on a permission request
   * it must mean "no". Same dialog, different verbs, and the refusing action is
   * the plain one -- a request to write to your disk should not have its
   * approval pre-emphasised.
   */
  if (request.method === "confirm") {
    return (
      <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="dialog">
          <h2 className="dialog-title">{request.title}</h2>
          {request.message ? <p className="dialog-message">{request.message}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="ghost" autoFocus onClick={() => onAnswer(request.id, undefined)}>
              Don't allow
            </button>
            <button type="button" className="primary" onClick={() => onAnswer(request.id, "yes")}>
              Allow
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className={`dialog ${request.method === "editor" ? "dialog-wide" : ""}`}>
        <h2 className="dialog-title">{request.title}</h2>
        {request.message ? <p className="dialog-message">{request.message}</p> : null}

        {request.method === "editor" ? (
          <textarea
            className="dialog-editor"
            value={value}
            spellCheck={false}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            className="dialog-input"
            value={value}
            autoFocus
            placeholder={request.placeholder ?? ""}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") skip();
            }}
          />
        )}

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={skip}>
            Skip
          </button>
          <button type="button" className="primary" onClick={submit}>
            {request.method === "editor" ? "Use this plan" : "Answer"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A question with the likely answers already on screen.
 *
 * Scoping asked these as blank boxes. The model has already worked out which
 * slot it is asking about, so it knows the shape of a good answer, and showing
 * two to four of them is the difference between a decision and an essay
 * question.
 *
 * Three things the app owns rather than the model:
 *
 *   - "Other" is here on every question, always, and opens a real text box.
 *     The options are a shortcut, never a fence.
 *   - Skip stays. This step exists to ask about what is genuinely ambiguous,
 *     and an ambiguity the user does not care about should cost one keystroke.
 *   - Nothing is preselected. A highlighted default in a scoping question is
 *     an answer the user did not give, and it would end up in the report's
 *     stated scope as though they had.
 */
function ChoiceDialog({
  request,
  onAnswer,
}: {
  request: PromptRequest;
  onAnswer: (id: string, answer: string | undefined) => void;
}) {
  const options = request.options ?? [];
  const multi = request.multi === true;
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);

  useEffect(() => {
    setPicked([]);
    setOther("");
    setOtherOpen(false);
  }, [request.id]);

  const toggle = (option: string): void => {
    setPicked((current) =>
      multi
        ? current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option]
        : [option],
    );
    if (!multi) setOtherOpen(false);
  };

  const answers = [...picked, ...(otherOpen && other.trim() ? [other.trim()] : [])];
  const send = (): void =>
    onAnswer(request.id, answers.length ? answers.join(JOIN) : undefined);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className="dialog dialog-choice">
        <h2 className="dialog-title">{request.title}</h2>
        {request.message ? <p className="dialog-message">{request.message}</p> : null}

        <ul className="choice-list" role={multi ? "group" : "radiogroup"}>
          {options.map((option) => (
            <li key={option}>
              <label className={picked.includes(option) ? "choice on" : "choice"}>
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`choice-${request.id}`}
                  checked={picked.includes(option)}
                  onChange={() => toggle(option)}
                />
                <span>{option}</span>
              </label>
            </li>
          ))}
          <li>
            <label className={otherOpen ? "choice on" : "choice"}>
              <input
                type={multi ? "checkbox" : "radio"}
                name={`choice-${request.id}`}
                checked={otherOpen}
                onChange={() => {
                  setOtherOpen((v) => !v);
                  if (!multi) setPicked([]);
                }}
              />
              <span>{OTHER}</span>
            </label>
            {otherOpen ? (
              <input
                className="dialog-input choice-other"
                autoFocus
                placeholder="In your own words"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
            ) : null}
          </li>
        </ul>

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={() => onAnswer(request.id, "")}>
            Skip
          </button>
          <button type="button" className="primary" disabled={!answers.length} onClick={send}>
            {multi && answers.length > 1 ? `Use these ${answers.length}` : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which model does which job.
 *
 * Grouped by where the request goes, because that is the difference that
 * matters most and the one the user cannot see from a model name: a local
 * model costs nothing and stays here, and a hosted one costs what its price
 * says and leaves the machine. The price sits beside each hosted model for the
 * same reason it does in the picker -- screening is thousands of abstracts,
 * and it is the stage where the difference between $0.10 and $15 per million
 * tokens decides what the run costs.
 *
 * The catalogue is fetched here rather than shipped in the request: both
 * halves already exist in the window, and a copy sent through a dialog payload
 * would be stale the moment somebody ticks a box in Settings.
 */
function ModelsDialog({
  request,
  onAnswer,
}: {
  request: PromptRequest;
  onAnswer: (id: string, answer: string | undefined) => void;
}) {
  const slots = request.slots ?? [];
  const [chosen, setChosen] = useState<Record<string, string>>(request.current ?? {});
  const [local, setLocal] = useState<InstalledModel[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => setChosen(request.current ?? {}), [request.id, request.current]);

  useEffect(() => {
    void window.karen.lemonadeModels().then((r) => setLocal(r.models ?? []));
    void window.karen.getSettings().then((s: Settings) =>
      setProviders((s.providers ?? []).filter((p) => p.enabled && p.models.length)),
    );
  }, []);

  /* Anything already assigned that is not in either list. A role saved from a
     provider since removed must stay visible and selected, or the dialog would
     silently reassign a stage the user never touched. */
  const known = new Set([
    ...local.map((m) => m.id),
    ...providers.flatMap((p) => p.models.map((m) => qualify(p.id, m))),
  ]);
  const orphans = [...new Set(Object.values(chosen).filter((v) => v && !known.has(v)))];

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className="dialog dialog-models">
        <h2 className="dialog-title">{request.title}</h2>
        {request.message ? <p className="dialog-message">{request.message}</p> : null}

        {slots.map((slot) => (
          <label key={slot.key} className="field role-slot">
            <span className="role-name">{slot.label}</span>
            <span className="role-hint">{slot.hint}</span>
            {/* Said here, where it can still be acted on. The plan document
                has carried this warning for months, as a blockquote inside a
                markdown editor, by which point the choice had been made. */}
            {slot.key === "reviewer" && chosen["reviewer"] && chosen["reviewer"] === chosen["synthesist"] ? (
              <span className="role-warn">
                Same as the synthesist, so the review will be self-review. The run will say so.
              </span>
            ) : null}
            <select
              className="select-sm"
              value={chosen[slot.key] ?? ""}
              onChange={(e) => setChosen((c) => ({ ...c, [slot.key]: e.target.value }))}
            >
              {orphans.map((value) => (
                <option key={value} value={value}>
                  {value} — no longer offered
                </option>
              ))}
              <optgroup label="On this machine">
                {local.length ? (
                  local.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))
                ) : (
                  <option disabled value="">
                    No local models installed
                  </option>
                )}
              </optgroup>
              {providers.map((p) => (
                <optgroup key={p.id} label={`${p.label || "Provider"} — leaves this machine`}>
                  {p.models.map((m) => {
                    const price = p.prices?.[m];
                    return (
                      <option key={m} value={qualify(p.id, m)}>
                        {m}
                        {price ? `  ·  ${priceLabel(price)} per M` : ""}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </label>
        ))}

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={() => onAnswer(request.id, undefined)}>
            Cancel the run
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onAnswer(request.id, JSON.stringify(chosen))}
          >
            Use these
          </button>
        </div>
      </div>
    </div>
  );
}
