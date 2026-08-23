import { useState } from "react";
import type { Status } from "../types.ts";

/**
 * Proposals waiting for a human click.
 *
 * The agent cannot create a task, an event, or anything else that belongs to a
 * system of record. It can only propose, and the proposal lands here. That is a
 * hard floor in the broker -- no permission mode, YOLO included, can turn it
 * into a direct write -- so this panel is not a convenience. It is the only
 * path from a proposal to a real task, and without it proposals pile up
 * invisibly behind a counter in the status bar.
 */
export function ReviewQueue({
  queue,
  onClose,
}: {
  queue: Status["reviewQueue"];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const act = async (id: string, what: "commit" | "dismiss") => {
    setBusy(id);
    setError(undefined);
    try {
      if (what === "commit") await window.karen.commitTask(id);
      else await window.karen.dismissTask(id);
    } catch (err) {
      // Committing shells out to Planify on the host, which can fail for
      // ordinary reasons (not installed, no such project). Say so and keep the
      // proposal, rather than dropping it on the floor.
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Review queue">
        <div className="modal-head">
          <span className="modal-title">Review queue</span>
          <span className="review-count">{queue.length} waiting</span>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          {error ? <div className="warn">{error}</div> : null}

          {queue.length === 0 ? (
            <div className="help">
              Nothing waiting. When Karen proposes a task it appears here, and is only
              created once you accept it.
            </div>
          ) : (
            queue.map((item) => (
              <div key={item.id} className="review-item">
                <div className="review-verb">{label(item.verb)}</div>
                <div className="review-title">{title(item.args)}</div>
                <Fields args={item.args} />
                <div className="review-actions">
                  <button
                    className="btn btn-sm"
                    disabled={busy === item.id}
                    onClick={() => void act(item.id, "dismiss")}
                  >
                    Discard
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy === item.id}
                    onClick={() => void act(item.id, "commit")}
                  >
                    {busy === item.id ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const VERB_LABEL: Record<string, string> = {
  "planify.propose": "Task",
  "calendar.propose_event": "Calendar event",
};
function label(verb: string): string {
  return VERB_LABEL[verb] ?? verb;
}

/** The one field that carries the proposal's identity. */
function title(args: Record<string, unknown>): string {
  for (const key of ["content", "title", "summary", "name"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "(untitled)";
}

/** Everything else, shown so nothing is committed unseen. */
function Fields({ args }: { args: Record<string, unknown> }) {
  const rest = Object.entries(args).filter(
    ([k, v]) => !["content", "title", "summary", "name"].includes(k) && v !== "" && v != null,
  );
  if (rest.length === 0) return null;
  return (
    <dl className="review-fields">
      {rest.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
