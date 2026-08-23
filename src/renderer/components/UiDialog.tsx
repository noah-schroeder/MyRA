import { useEffect, useState } from "react";
import type { PromptRequest } from "../types.ts";

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
