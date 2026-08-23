/**
 * Reading the permission mode inside the VM.
 *
 * The host writes this file whenever the mode changes and once at handshake, so
 * it is read fresh on every tool call rather than cached: a user who switches to
 * Manual mid-task expects the very next call to ask.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "@karen/protocol";

export interface GuardPolicy {
  mode: PermissionMode;
  workspaceRoot: string;
}

export function policyPath(): string {
  return (
    process.env["KAREN_POLICY_CONFIG"] ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "karen", "policy.json")
  );
}

/*
 * FAILS CLOSED, and this is the whole point of the module.
 *
 * If the file is missing, truncated or malformed, the safe reading is not "no
 * policy, carry on" -- it is the strictest mode. A guard that fails open is
 * indistinguishable from no guard exactly when something has gone wrong.
 */
const STRICTEST: GuardPolicy = { mode: "manual", workspaceRoot: join(homedir(), "Documents", "karen") };

export function readPolicy(path = policyPath()): GuardPolicy {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GuardPolicy>;
    const mode = parsed.mode;
    if (mode !== "manual" && mode !== "guarded" && mode !== "yolo") return STRICTEST;
    const workspaceRoot =
      typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot
        ? parsed.workspaceRoot
        : STRICTEST.workspaceRoot;
    return { mode, workspaceRoot };
  } catch {
    return STRICTEST;
  }
}
