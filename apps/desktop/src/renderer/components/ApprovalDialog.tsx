import { useState } from "react";
import type { ApprovalReq } from "../types.ts";

/**
 * The approval prompt.
 *
 * Floor-class requests (catastrophic commands, and anything touching the user's
 * systems of record) show no "always allow" affordance at all -- that decision
 * is not delegable, in any mode.
 */
export function ApprovalDialog({
  req,
  onRespond,
}: {
  req: ApprovalReq;
  onRespond: (allowed: boolean, alwaysAllowVerb?: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const danger = req.verdict.risk === "dangerous" || req.verdict.risk === "catastrophic";
  const needsTyped = req.verdict.risk === "catastrophic";
  const canAlwaysAllow = !req.verdict.floor;
  const confirmed = !needsTyped || typed.trim().toUpperCase() === "ALLOW";

  return (
    <div className="overlay">
      <div className={`modal${danger ? " danger" : ""}`}>
        <div className="modal-head">
          <span className={`pill ${danger ? "mode-yolo" : ""}`}>
            <span className="pill-dot" />
            {req.verdict.risk.replace("_", " ")}
          </span>
          <span className="modal-title">Approve “{req.verb}”?</span>
        </div>

        <div className="modal-body">
          <div className="help">{req.verdict.reason}</div>

          {req.verdict.floor ? (
            <div className="warn">
              This always requires your approval — in every mode, including YOLO.
              There is no setting that turns it off.
            </div>
          ) : null}

          <div className="field">
            <span className="label">Request</span>
            <div className="code-block">{JSON.stringify(req.args, null, 2)}</div>
          </div>

          {needsTyped ? (
            <div className="field">
              <span className="label">Type ALLOW to confirm</span>
              <input
                className="input"
                value={typed}
                autoFocus
                onChange={(e) => setTyped(e.target.value)}
                placeholder="ALLOW"
              />
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          {canAlwaysAllow ? (
            <button className="btn btn-ghost" onClick={() => onRespond(true, req.verb)}>
              Always allow this session
            </button>
          ) : null}
          <div className="spacer" />
          <button className="btn" onClick={() => onRespond(false)}>Deny</button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={!confirmed}
            onClick={() => onRespond(true)}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
