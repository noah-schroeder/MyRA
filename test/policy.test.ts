import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES,
  RISK_CLASSES,
  FLOOR_CLASSES,
  decide,
  isFloorClass,
} from "../src/core/policy.ts";

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

test("the floor is enforced by decide, not by the matrix agreeing with it", () => {
  /* `requiresTypedConfirm` used to be asserted here. It was exported, tested,
     unreachable -- nothing is classified `catastrophic` -- and NOT
     implemented: UiDialog is a plain two-button confirm. A guard that is
     promised and not enforced is the failure mode that made risk.ts look
     maintained for a year, so it is gone and the property it gestured at is
     asserted where something can act on it (test/approval.test.ts).

     What is pinned here instead: decide() itself refuses, so the floor
     survives someone editing a column of MATRIX. */
  for (const risk of FLOOR_CLASSES) {
    for (const mode of PERMISSION_MODES) {
      assert.equal(decide(mode, risk), "ask");
    }
  }
});

/*
 * v1 tested this against the host broker's verb table -- planify.propose,
 * calendar.propose_event, clipboard.*. There is no broker in v2 and no host
 * verbs, so what survives is the property that mattered: the floor classes are
 * a floor, and no mode can lower them. The tool registry re-attaches specific
 * tools to these classes in its own test.
 */
test("the floor classes are never auto-approved in any mode", () => {
  for (const risk of FLOOR_CLASSES) {
    for (const mode of PERMISSION_MODES) {
      assert.equal(decide(mode, risk), "ask", `${risk} auto-approved in ${mode}`);
    }
  }
});

test("a sandbox write is auto-approved, or Guarded becomes unusable", () => {
  // The agent's output drop is jailed to a subtree and every write is rendered
  // as a diff. Treating it as a system of record would mean a click per
  // meeting report, and that friction is what drives people into YOLO.
  assert.equal(decide("guarded", "write"), "auto");
  assert.equal(decide("manual", "write"), "ask");
});
