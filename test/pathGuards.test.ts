/**
 * Names that arrive over IPC and end up in a filesystem path.
 *
 * None of these is reachable by the model, and there is no way for web content
 * to drive the renderer (nothing in the UI ever builds HTML from a string). They
 * are checked anyway, for the reason `sessions.pathFor` already gives: the value
 * lands in a path, so it is checked rather than trusted.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { repoId } from "../src/core/runtime/hf.ts";
import { assertRunId } from "../src/core/research/run.ts";
import { assertTaskId } from "../src/core/tasks/task.ts";

describe("repoId", () => {
  it("accepts the shape HuggingFace actually uses", () => {
    assert.equal(repoId("ggerganov/whisper.cpp"), "ggerganov/whisper.cpp");
    assert.equal(repoId("unsloth/Qwen3-8B-GGUF"), "unsloth/Qwen3-8B-GGUF");
    assert.equal(repoId("TheBloke/Llama-2-7B-Chat-GGUF"), "TheBloke/Llama-2-7B-Chat-GGUF");
  });

  it("refuses the id that escaped the models directory", () => {
    /* The concrete bug: `repo.replace("/", "__")` has no `g`, so only the first
       slash was flattened and the rest were left for `join` to resolve. */
    assert.throws(() => repoId("a/b/../../../etc"), /not a HuggingFace repository id/);
  });

  it("refuses anything that is not exactly owner/name", () => {
    for (const bad of ["", "noslash", "a/b/c", "/leading", "trailing/", "../..", "a/.."]) {
      assert.throws(() => repoId(bad), /not a HuggingFace repository id/, `accepted ${bad}`);
    }
  });
});

describe("assertRunId", () => {
  it("accepts an id the app generates", () => {
    assert.equal(assertRunId("2026-08-26-spacing-effect-a1b2"), "2026-08-26-spacing-effect-a1b2");
  });

  it("refuses a separator or a climb", () => {
    for (const bad of ["..", ".", "../secrets", "a/b", "", "a\0b"]) {
      assert.throws(() => assertRunId(bad), /no research run named/, `accepted ${bad}`);
    }
  });
});

describe("assertTaskId", () => {
  it("accepts an id the app generates", () => {
    assert.equal(
      assertTaskId("20260915-140530-review-frank-s-paper-ab12"),
      "20260915-140530-review-frank-s-paper-ab12",
    );
  });

  it("refuses a separator or a climb", () => {
    for (const bad of ["..", ".", "../secrets", "a/b", "", "a\0b"]) {
      assert.throws(() => assertTaskId(bad), /no task named/, `accepted ${bad}`);
    }
  });
});
