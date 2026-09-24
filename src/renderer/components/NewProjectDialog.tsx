import { useState } from "react";

/**
 * What a new project starts as.
 *
 * A project is always just an index (see core/projects/project.ts) -- this
 * choice decides nothing about storage, only whether the very first
 * conversation filed to it runs the setup chat (core/projects/intake.ts)
 * before anything else. Declining costs nothing later: "Start research
 * setup" on the project page runs the same chat on a plain folder at any
 * point, so this is a default, not a fork in what a project can become.
 *
 * Reuses the same `.dialog-choice` chrome the agent's own choice prompts
 * draw (UiDialog.tsx's ChoiceDialog) -- a plain local dialog, not one of
 * those: nothing here is asking on a model's behalf.
 */
export function NewProjectDialog({
  onCancel,
  onChoose,
}: {
  onCancel: () => void;
  onChoose: (research: boolean) => void;
}) {
  const [picked, setPicked] = useState<"simple" | "research">("simple");

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="New project">
      <div className="dialog dialog-choice">
        <h2 className="dialog-title">New project</h2>
        <p className="dialog-message">
          Either way, you can file conversations, meetings, runs, papers, reviews and images into
          it, and export it all as one folder later.
        </p>

        <ul className="choice-list" role="radiogroup">
          <li>
            <label className={picked === "simple" ? "choice on" : "choice"}>
              <input
                type="radio"
                name="new-project-kind"
                checked={picked === "simple"}
                onChange={() => setPicked("simple")}
              />
              <span>
                <span className="role-name">Simple folder</span>
                <br />
                <span className="role-hint">Just a place to group work. Nothing else happens.</span>
              </span>
            </label>
          </li>
          <li>
            <label className={picked === "research" ? "choice on" : "choice"}>
              <input
                type="radio"
                name="new-project-kind"
                checked={picked === "research"}
                onChange={() => setPicked("research")}
              />
              <span>
                <span className="role-name">Research project</span>
                <br />
                <span className="role-hint">
                  Opens a short chat about what you're studying, and keeps what comes out of it as
                  notes every later conversation in this project can read.
                </span>
              </span>
            </label>
          </li>
        </ul>

        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onChoose(picked === "research")}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
