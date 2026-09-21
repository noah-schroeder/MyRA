/**
 * The permission model, shared by the enforcement point and by the UI that
 * displays it.
 *
 * Keeping the matrix here rather than duplicating it means the badge the user
 * sees and the decision actually taken can never drift apart.
 *
 * What enforces it is `approve` in main/index.ts, which looks the tool up in
 * the registry, asks `decide`, and puts the question to the window. There is
 * no VM and no broker -- see docs/threat-model.md for what the boundary
 * actually is. Note what this means in practice for the tool set MyRA ships:
 * nothing is classified above `write`, so in the default mode no prompt ever
 * fires, and the jail is what is actually containing the agent.
 */

export const PERMISSION_MODES = ["manual", "guarded", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Risk classes, ordered from least to most consequential.
 *
 * - `safe`             reads and queries; no side effects
 * - `write`            writes confined to the agent's own sandbox
 * - `dangerous`        destructive shell, or any write escaping the sandbox
 * - `catastrophic`     unrecoverable (rm -rf /, mkfs on a real device, fork bomb)
 * - `system_of_record` mutates the user's real data: the calendar, contacts and
 *                      task list kept in the user's OWN applications, and the
 *                      clipboard. Lives on the host, outside the sandbox.
 *                      NOT MyRA's own task list, which is a flat directory of
 *                      JSON files in MyRA's own folder, read by no other
 *                      program -- see the header of agent/tools/tasks.ts,
 *                      which argues the `write` classification in full.
 */
export const RISK_CLASSES = ["safe", "write", "dangerous", "catastrophic", "system_of_record"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export type Decision = "auto" | "ask";

/**
 * Classes whose decision is fixed at `ask` in EVERY mode, including yolo.
 *
 * This is a hard floor, not a preference: there is deliberately no setting that
 * lowers it. yolo removes friction inside the agent's own sandbox; it never
 * reaches the user's systems of record, and never runs an unrecoverable command.
 */
export const FLOOR_CLASSES: readonly RiskClass[] = ["catastrophic", "system_of_record"];

export function isFloorClass(risk: RiskClass): boolean {
  return FLOOR_CLASSES.includes(risk);
}

const MATRIX: Record<RiskClass, Record<PermissionMode, Decision>> = {
  safe: { manual: "ask", guarded: "auto", yolo: "auto" },
  // Sandbox-only writes are auto in guarded: prompting on scratch writes is
  // noise, and that noise is what drives people into yolo, which is worse.
  write: { manual: "ask", guarded: "auto", yolo: "auto" },
  dangerous: { manual: "ask", guarded: "ask", yolo: "auto" },
  catastrophic: { manual: "ask", guarded: "ask", yolo: "ask" },
  system_of_record: { manual: "ask", guarded: "ask", yolo: "ask" },
};

export function decide(mode: PermissionMode, risk: RiskClass): Decision {
  /* Asked here rather than left to the matrix happening to agree with it.
     "No mode lowers the floor" was true only because two rows above are all
     "ask" -- so an editor tuning the yolo column would have made the claim
     false while the test asserting it went on passing, for a reason that had
     nothing to do with the claim. */
  if (isFloorClass(risk)) return "ask";
  return MATRIX[risk][mode];
}

export interface PolicyVerdict {
  risk: RiskClass;
  decision: Decision;
  /** Why it was classified this way — shown in the dialog and the audit log. */
  reason: string;
  /** Set when the decision cannot be changed by any mode. */
  floor: boolean;
}
