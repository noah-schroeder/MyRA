import { useState } from "react";

import { MEMORY_SLOTS, SLOT_LABELS } from "../../core/projects/memory.ts";
import type { MemorySlot } from "../types.ts";

/**
 * "Remember this": one message, or the part of it you selected, into the
 * active project's notes.
 *
 * The person's own action, so nothing here is grounded or checked -- it is
 * the same write "+ Add a note" makes on the project page, reached from where
 * the thing worth keeping was actually said. The text is prefilled and
 * editable because a whole reply is rarely the note: it is what the note gets
 * cut down from, and a note is read at the start of every conversation in the
 * project, so the short version is the one that costs nothing.
 */
export function RememberDialog({
  projectName,
  initialText,
  onCancel,
  onSave,
}: {
  projectName: string;
  initialText: string;
  onCancel: () => void;
  onSave: (slot: MemorySlot, text: string) => void;
}) {
  const [slot, setSlot] = useState<MemorySlot>("context");
  const [text, setText] = useState(initialText);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Remember this">
      <div className="dialog">
        <h2 className="dialog-title">Remember this in “{projectName}”</h2>
        <p className="dialog-message">
          Every conversation in this project starts by reading its notes, so keep it to what will
          still matter next time.
        </p>
        <select
          className="select-sm"
          value={slot}
          aria-label="Where this note belongs"
          onChange={(e) => setSlot(e.target.value as MemorySlot)}
        >
          {MEMORY_SLOTS.map((s) => (
            <option key={s} value={s}>
              {SLOT_LABELS[s]}
            </option>
          ))}
        </select>
        <textarea
          className="dialog-editor remember-text"
          value={text}
          rows={Math.min(10, Math.max(3, Math.ceil(text.length / 70)))}
          aria-label="The note"
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!text.trim()} onClick={() => onSave(slot, text.trim())}>
            Save note
          </button>
        </div>
      </div>
    </div>
  );
}
