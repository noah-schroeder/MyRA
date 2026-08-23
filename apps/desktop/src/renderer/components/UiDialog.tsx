import { useEffect, useRef, useState } from "react";
import type { UiRequest } from "../types.ts";

/**
 * Native rendering for a pi extension's UI request.
 *
 * These are BLOCKING calls on the agent side: the extension is suspended inside
 * `pi.ui.editor(...)` until a response arrives. So every path out of this
 * component sends exactly one response -- including dismissal, which sends
 * `cancelled` rather than nothing.
 *
 * The editor variant is what the research pipeline's plan step rides on: the
 * whole plan is handed over as text, edited freely, and handed back.
 */
export function UiDialog({
  req,
  onRespond,
}: {
  req: UiRequest;
  onRespond: (response: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(req.prefill ?? "");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isEditor = req.method === "editor";

  useEffect(() => {
    setValue(req.prefill ?? "");
    // A dialog that needs a click before you can type interrupts twice.
    requestAnimationFrame(() => (areaRef.current ?? inputRef.current)?.focus());
  }, [req.id, req.prefill]);

  const cancel = () => onRespond({ cancelled: true });
  const submit = () => onRespond({ value });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    // Plain Enter is a newline in the editor, so submitting needs a modifier.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  };

  return (
    <div className="overlay">
      <div className={`modal${isEditor ? " modal-wide" : ""}`} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <span className="modal-title">{req.title ?? "Karen needs an answer"}</span>
        </div>

        <div className="modal-body">
          {req.message ? <div className="help">{req.message}</div> : null}

          {req.method === "select" ? (
            <div className="field">
              {(req.options ?? []).map((opt) => (
                <button key={opt} className="btn" onClick={() => onRespond({ value: opt })}>
                  {opt}
                </button>
              ))}
            </div>
          ) : null}

          {req.method === "input" ? (
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder={req.placeholder ?? ""}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            />
          ) : null}

          {isEditor ? (
            <textarea
              ref={areaRef}
              className="textarea modal-editor"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
            />
          ) : null}
        </div>

        <div className="modal-foot">
          {isEditor ? (
            <span className="help" style={{ marginRight: "auto" }}>
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel
            </span>
          ) : null}
          <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
          {req.method === "confirm" ? (
            <>
              <button className="btn" onClick={() => onRespond({ confirmed: false })}>No</button>
              <button className="btn btn-primary" onClick={() => onRespond({ confirmed: true })}>Yes</button>
            </>
          ) : null}
          {req.method === "input" || isEditor ? (
            <button className="btn btn-primary" onClick={submit}>
              {isEditor ? "Save and continue" : "OK"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
