import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES,
  RISK_CLASSES,
  FLOOR_CLASSES,
  decide,
  isFloorClass,
  requiresTypedConfirm,
} from "../src/policy.ts";
import { HOST_VERBS, HOST_VERB_RISK, isHostVerb } from "../src/frames.ts";

test("guarded auto-approves safe and sandbox writes, but not dangerous", () => {
  assert.equal(decide("guarded", "safe"), "auto");
  assert.equal(decide("guarded", "write"), "auto");
  assert.equal(decide("guarded", "dangerous"), "ask");
});

test("manual asks for absolutely everything", () => {
  for (const risk of RISK_CLASSES) {
    assert.equal(decide("manual", risk), "ask", `manual must ask for ${risk}`);
  }
});

test("yolo auto-approves everything EXCEPT the floor", () => {
  assert.equal(decide("yolo", "safe"), "auto");
  assert.equal(decide("yolo", "write"), "auto");
  assert.equal(decide("yolo", "dangerous"), "auto");
  assert.equal(decide("yolo", "catastrophic"), "ask");
  assert.equal(decide("yolo", "system_of_record"), "ask");
});

// The invariant the whole permission design rests on.
test("NO mode can lower the floor", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of FLOOR_CLASSES) {
      assert.equal(
        decide(mode, risk),
        "ask",
        `${mode} must never auto-approve ${risk} — this is a hard floor`,
      );
    }
  }
});

test("floor classes are exactly catastrophic and system_of_record", () => {
  const floors = RISK_CLASSES.filter(isFloorClass);
  assert.deepEqual([...floors].sort(), ["catastrophic", "system_of_record"]);
});

test("only catastrophic demands a typed confirmation", () => {
  const typed = RISK_CLASSES.filter(requiresTypedConfirm);
  assert.deepEqual(typed, ["catastrophic"]);
});

test("every host verb has a risk classification", () => {
  for (const verb of HOST_VERBS) {
    assert.ok(HOST_VERB_RISK[verb], `${verb} is unclassified`);
    assert.ok(RISK_CLASSES.includes(HOST_VERB_RISK[verb]));
  }
});

test("the user's systems of record are never auto-approved in any mode", () => {
  const sacred = ["planify.propose", "calendar.propose_event", "clipboard.read", "clipboard.write"] as const;
  for (const verb of sacred) {
    assert.equal(HOST_VERB_RISK[verb], "system_of_record", `${verb} must be a system of record`);
    for (const mode of PERMISSION_MODES) {
      assert.equal(decide(mode, HOST_VERB_RISK[verb]), "ask", `${verb} auto-approved in ${mode}`);
    }
  }
});

test("vault.write is a sandbox write, not a system of record", () => {
  // It is the agent's output drop, jailed to a subtree; the broker enforces the
  // jail. Treating it as a system of record would mean a click per meeting report.
  assert.equal(HOST_VERB_RISK["vault.write"], "write");
  assert.equal(decide("guarded", HOST_VERB_RISK["vault.write"]), "auto");
});

test("no filesystem-write or shell verb exists on the host", () => {
  for (const forbidden of ["fs.write", "fs.read", "shell", "bash", "exec", "doc.create"]) {
    assert.equal(isHostVerb(forbidden), false, `${forbidden} must not be a host verb`);
  }
});
