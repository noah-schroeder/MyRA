/**
 * The permission guard for pi's own tools.
 *
 * The host broker polices every verb that crosses to the host. It never sees
 * pi's BUILT-IN tools -- bash, write, edit, read -- because those act inside the
 * VM and never touch the broker. Until this extension existed, the permission
 * matrix in the GUI simply did not apply to them: Guarded ran `rm -rf ~/work`
 * without a word.
 *
 * This is the missing enforcement point. It classifies each call, consults the
 * same matrix the GUI displays, and blocks the ones the user declines.
 *
 * FRAMING, honestly stated: this is defence in depth, not a security boundary.
 * Shell is not reliably parseable and a determined adversary can obfuscate past
 * any pattern list. What actually contains a hostile agent is the VM plus the
 * broker's tiny allowlist. This stops honest accidents, catches the obvious
 * shapes prompt injection takes, and decides when to interrupt the user.
 *
 * Every judgement call therefore fails toward asking:
 *   - an unreadable policy file is read as Manual, not as "no policy"
 *   - an unrecognised tool is `dangerous`, not `safe`
 *   - a UI that cannot be reached blocks the call rather than allowing it
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyToolCall } from "@karen/protocol";
import {
  decide,
  requiresTypedConfirm,
  type PolicyVerdict,
} from "@karen/protocol";
import { readPolicy } from "./policy.ts";

/** Tools whose own extension already asks, or that the broker polices. */
const ALREADY_POLICED = new Set([
  // Host tools: every one of these ends at the broker, which applies the same
  // matrix plus its floor. Asking here as well would double-prompt.
  "notify", "vault_read", "vault_write", "tasks_list", "propose_task",
  "clipboard_read", "clipboard_write", "calendar_list", "contacts_search", "propose_event",
]);

function summarise(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "shell") {
    return String(input["command"] ?? "").slice(0, 400);
  }
  for (const key of ["path", "file_path", "filePath", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v) return v;
  }
  return JSON.stringify(input).slice(0, 200);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName as string;
    if (ALREADY_POLICED.has(toolName)) return;

    const policy = readPolicy();
    const input = (event.input ?? {}) as Record<string, unknown>;

    let verdict: PolicyVerdict;
    try {
      verdict = classifyToolCall(toolName, input, { workspaceRoot: policy.workspaceRoot });
    } catch {
      // A classifier that throws must not become a classifier that permits.
      verdict = {
        risk: "dangerous",
        reason: "could not classify this call",
        decision: "ask",
        floor: false,
      };
    }

    if (decide(policy.mode, verdict.risk) === "auto") return;

    const what = summarise(toolName, input);
    const typed = requiresTypedConfirm(verdict.risk);
    const heading =
      verdict.risk === "catastrophic"
        ? `UNRECOVERABLE — ${toolName}`
        : verdict.risk === "dangerous"
          ? `Dangerous — ${toolName}`
          : `${toolName}`;

    /*
     * The floor is worth naming in the prompt.
     *
     * When a call is catastrophic, the dialog says so and demands typed
     * confirmation, because "click OK" is too easy for `rm -rf /`. And it says
     * that no mode would have allowed it, so the user understands they are not
     * being asked out of excessive caution.
     */
    const detail = [
      what,
      "",
      `Why: ${verdict.reason}.`,
      verdict.floor
        ? "This always asks, in every permission mode — including YOLO."
        : `Mode: ${policy.mode}.`,
    ].join("\n");

    try {
      let approved: boolean;
      if (typed) {
        // Typed confirmation, not a click: OK is far too easy for `rm -rf /`.
        const answer = await ctx.ui.input(
          `${heading}\n\n${detail}\n\nType "yes" to run it.`,
          "yes",
        );
        approved = String(answer ?? "").trim().toLowerCase() === "yes";
      } else {
        approved = Boolean(await ctx.ui.confirm(heading, detail));
      }
      if (approved) return;
      return { block: true, reason: `Blocked by the user (${verdict.risk}: ${verdict.reason}).` };
    } catch (err) {
      // No UI, or the user closed the app mid-prompt. An unanswered question is
      // not consent.
      return {
        block: true,
        reason: `Could not ask for approval, so this ${verdict.risk} call was blocked: ${(err as Error).message}`,
      };
    }
  });
}
