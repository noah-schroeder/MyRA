/**
 * The permission model, shared by the enforcement point (the pi extension in
 * the VM, and the host broker) and by the UI that displays it.
 *
 * Keeping the matrix here rather than duplicating it means the badge the user
 * sees and the decision actually taken can never drift apart.
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
 * - `system_of_record` mutates the user's real data: tasks, calendar, contacts,
 *                      clipboard. Lives on the host, outside the sandbox.
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
  return MATRIX[risk][mode];
}


/** True when the user must type to confirm rather than just click. */
export function requiresTypedConfirm(risk: RiskClass): boolean {
  return risk === "catastrophic";
}

export interface PolicyVerdict {
  risk: RiskClass;
  decision: Decision;
  /** Why it was classified this way — shown in the dialog and the audit log. */
  reason: string;
  /** Set when the decision cannot be changed by any mode. */
  floor: boolean;
}
