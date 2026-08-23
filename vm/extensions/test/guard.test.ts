import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The guard is the enforcement point for pi's BUILT-IN tools. Nothing else
 * polices them: bash, write and edit never reach the host broker, so before
 * this existed the permission matrix in the GUI did not apply to them at all.
 */

const WS = "/home/coding/Documents/karen";

function policyFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "karen-policy-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

/** Drive the extension's tool_call handler with a stub ui. */
async function guard(
  policy: unknown,
  toolName: string,
  input: Record<string, unknown>,
  ui: { confirm?: any; input?: any } = {},
) {
  const path = typeof policy === "string" && policy === "MISSING"
    ? join(mkdtempSync(join(tmpdir(), "karen-none-")), "absent.json")
    : policyFile(policy);
  const prev = process.env["KAREN_POLICY_CONFIG"];
  process.env["KAREN_POLICY_CONFIG"] = path;
  try {
    const { stubApi } = await import("./harness.ts");
    const register = (await import("../guard/index.ts")).default;
    const s = stubApi([]);
    register(s.pi);
    const handler = s.handlers.get("tool_call")!;
    const asked: string[] = [];
    const ctx = {
      ui: {
        confirm: ui.confirm ?? (async (t: string) => { asked.push(t); return false; }),
        input: ui.input ?? (async (t: string) => { asked.push(t); return ""; }),
      },
    };
    const result = await handler({ type: "tool_call", toolCallId: "1", toolName, input }, ctx);
    return { result, asked };
  } finally {
    if (prev === undefined) delete process.env["KAREN_POLICY_CONFIG"];
    else process.env["KAREN_POLICY_CONFIG"] = prev;
  }
}

test("Guarded prompts on rm -rf — the gap this closes", async () => {
  const { result, asked } = await guard(
    { mode: "guarded", workspaceRoot: WS }, "bash", { command: "rm -rf ~/work" },
  );
  assert.equal(result?.block, true, "declining must block the call");
  assert.equal(asked.length, 1, "the user must actually be asked");
  assert.match(asked[0]!, /Dangerous|UNRECOVERABLE/);
});

test("Guarded stays quiet for ordinary work", async () => {
  for (const [tool, input] of [
    ["bash", { command: "ls -la" }],
    ["read", { path: "/etc/hosts" }],
    ["write", { path: `${WS}/draft.md` }],
  ] as const) {
    const { result, asked } = await guard({ mode: "guarded", workspaceRoot: WS }, tool, input);
    assert.equal(result, undefined, `${tool} should run unprompted`);
    assert.equal(asked.length, 0);
  }
});

test("Manual asks even for a read", async () => {
  const { asked } = await guard({ mode: "manual", workspaceRoot: WS }, "read", { path: "/etc/hosts" });
  assert.equal(asked.length, 1);
});

test("YOLO still cannot run an unrecoverable command", async () => {
  // The floor is not a preference. No mode lowers it.
  const { result, asked } = await guard(
    { mode: "yolo", workspaceRoot: WS }, "bash", { command: "rm -rf /" },
  );
  assert.equal(asked.length, 1, "YOLO must still ask here");
  assert.equal(result?.block, true);
  assert.match(asked[0]!, /every permission mode/i);
});

test("an unrecoverable command demands typing, not a click", async () => {
  let usedInput = false, usedConfirm = false;
  await guard(
    { mode: "guarded", workspaceRoot: WS }, "bash", { command: "mkfs.ext4 /dev/sda" },
    { input: async () => { usedInput = true; return "yes"; },
      confirm: async () => { usedConfirm = true; return true; } },
  );
  assert.equal(usedInput, true, "catastrophic calls must require typed confirmation");
  assert.equal(usedConfirm, false);
});

test("typing yes runs it; anything else does not", async () => {
  const yes = await guard({ mode: "guarded", workspaceRoot: WS }, "bash", { command: "rm -rf /" },
    { input: async () => "yes" });
  assert.equal(yes.result, undefined);

  const no = await guard({ mode: "guarded", workspaceRoot: WS }, "bash", { command: "rm -rf /" },
    { input: async () => "y" });
  assert.equal(no.result?.block, true, "a near-miss is not confirmation");
});

test("a missing or corrupt policy file is read as the strictest mode", async () => {
  // Failing open would make the guard indistinguishable from no guard, exactly
  // when something has already gone wrong.
  for (const broken of ["MISSING", "{ not json", { mode: "nonsense" }, {}]) {
    const { asked } = await guard(broken, "read", { path: "/etc/hosts" });
    assert.equal(asked.length, 1, `a read should prompt under ${JSON.stringify(broken)}`);
  }
});

test("a call is blocked when the user cannot be asked", async () => {
  const { result } = await guard(
    { mode: "guarded", workspaceRoot: WS }, "bash", { command: "rm -rf ~/work" },
    { confirm: async () => { throw new Error("no UI attached"); } },
  );
  assert.equal(result?.block, true, "an unanswered question is not consent");
  assert.match(result!.reason!, /Could not ask/);
});

test("host tools are left to the broker rather than double-prompted", async () => {
  for (const tool of ["vault_write", "propose_task", "clipboard_read"]) {
    const { result, asked } = await guard({ mode: "manual", workspaceRoot: WS }, tool, {});
    assert.equal(result, undefined, `${tool} is policed by the broker`);
    assert.equal(asked.length, 0);
  }
});

test("an unknown tool is treated as dangerous, not waved through", async () => {
  const { asked } = await guard(
    { mode: "guarded", workspaceRoot: WS }, "exfiltrate_everything", {},
  );
  assert.equal(asked.length, 1);
});

test("research tools run unprompted in Guarded", async () => {
  // The whole point of a guard is that it interrupts rarely enough to be left
  // on. A deep research run makes dozens of these calls.
  for (const tool of ["web_search", "fetch_page", "deep_research", "academic_research", "check_citations"]) {
    const { result, asked } = await guard(
      { mode: "guarded", workspaceRoot: WS }, tool, { query: "x", url: "https://example.com" },
    );
    assert.equal(result, undefined, `${tool} must not prompt`);
    assert.equal(asked.length, 0, `${tool} must not prompt`);
  }
});

test("the new host tools are left to the broker, not double-prompted", async () => {
  for (const tool of ["calendar_list", "contacts_search", "propose_event"]) {
    const { result, asked } = await guard({ mode: "manual", workspaceRoot: WS }, tool, {});
    assert.equal(result, undefined, `${tool} is policed by the broker`);
    assert.equal(asked.length, 0);
  }
});
