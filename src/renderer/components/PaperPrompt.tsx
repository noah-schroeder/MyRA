import { useEffect, useState } from "react";
import { buildSystem, buildUser } from "../../core/papers/prompt.ts";
import type { DraftRequest } from "../types.ts";

/**
 * The author's own instructions, and exactly what they turn into.
 *
 * Two scopes, one dialog: guidance for the whole paper, and guidance for one
 * section. The difference is which box is being edited and how much of the
 * request is worth showing -- a paper-wide instruction only changes the system
 * prompt, so showing the user message beneath it would be noise that never
 * moves while you type.
 *
 * The preview is not a description of the prompt. It is the prompt: the same
 * `buildSystem` and `buildUser` the main process calls, over the same request
 * object it will be handed. Written that way on purpose -- a preview assembled
 * from a copy of the rules is a preview that goes quietly out of date, and this
 * one exists precisely so somebody can check what a tool that writes in their
 * name is being told.
 *
 * Nothing is sent to render it. No model is called, no request leaves the
 * machine, and the dialog works with no endpoint configured at all.
 */
export function PaperPrompt({
  scope,
  value,
  placeholder,
  requestFor,
  onChange,
  onClose,
}: {
  scope: "paper" | "section";
  value: string;
  placeholder: string;
  /** The request as it would be, with the text currently in the box folded in. */
  requestFor: (value: string) => DraftRequest;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);

  /* Applied as you type rather than on a Save button. Everything on this page
     autosaves, and one dialog with different rules is the one somebody closes
     believing their guidance was kept. */
  useEffect(() => onChange(text), [text, onChange]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const request = requestFor(text);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Prompt">
      <div className="dialog dialog-wide paper-dialog">
        <h2 className="dialog-title">
          {scope === "paper" ? "Paper prompt" : "Section prompt"}
          <span className="paper-dialog-sub">
            {scope === "paper" ? "applies to every section" : "this section only"}
          </span>
        </h2>
        <p className="dialog-message">
          {scope === "paper"
            ? "Guidance for the whole paper — tone, audience, conventions, domain context. It is added to the prompt for every section, and it does not override the rule that nothing may be cited."
            : "Instructions for this section alone — “be concise and technical”, “open with the broad problem”, “use past tense”."}
        </p>

        <textarea
          className="dialog-editor paper-dialog-box"
          value={text}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />

        <h3 className="paper-preview-head">Exactly what will be sent</h3>
        <p className="paper-preview-note">
          Updates as you type. Nothing is sent to your model to show you this.
        </p>
        <div className="paper-preview">
          <p className="paper-preview-label">System</p>
          <pre className="paper-preview-body">{buildSystem(request)}</pre>
          {scope === "section" ? (
            <>
              <p className="paper-preview-label">Message</p>
              <pre className="paper-preview-body">{buildUser(request)}</pre>
            </>
          ) : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
