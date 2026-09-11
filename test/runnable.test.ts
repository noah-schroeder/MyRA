/**
 * Whether a model can run here at all, which the list used not to ask.
 *
 * The numbers in these tests are from this machine's own `/system-info`: 79
 * chat models needing an AMD NPU that is not present, all of them showing a
 * Download button and a fit verdict that read as a green light.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  engineStates, engineUsable, partitionByRunnable, runnable,
} from "../src/core/runtime/runnable.ts";
import type { EngineInfo } from "../src/core/runtime/systemInfo.ts";

/** Shaped as the daemon reports it on the machine this was found on. */
const ENGINES: EngineInfo[] = [
  { id: "llamacpp", backends: [
    { id: "cpu", state: "installed" },
    { id: "cuda", state: "unsupported" },
    { id: "vulkan", state: "installed" },
  ] },
  { id: "whispercpp", backends: [
    { id: "cpu", state: "installable" },
    { id: "npu", state: "unsupported" },
  ] },
  { id: "ryzenai-llm", backends: [{ id: "npu", state: "unsupported" }] },
  { id: "vllm", backends: [{ id: "rocm", state: "unsupported" }] },
];

const states = engineStates(ENGINES);

test("an engine with an installed backend is ready", () => {
  assert.equal(runnable("llamacpp", states).state, "ready");
});

test("an engine that could be installed says so rather than looking broken", () => {
  const verdict = runnable("whispercpp", states);
  assert.equal(verdict.state, "needs-engine");
  assert.match(verdict.reason, /Settings → Runtime/);
});

test("an NPU model on a machine with no NPU is unsupported, not merely unfitted", () => {
  const verdict = runnable("ryzenai-llm", states);
  assert.equal(verdict.state, "unsupported");
  // The name is what makes this worth saying: "ryzenai-llm" means nothing to
  // the person deciding whether to spend 9 GB of bandwidth.
  assert.match(verdict.reason, /AMD Ryzen AI NPU/);
});

test("an engine the daemon never mentions is unsupported, not unknown", () => {
  // `collection.omni` is named by four catalogue entries and by no engine.
  assert.equal(runnable("collection.omni", states).state, "unsupported");
});

test("the blocked models are separated out and can be counted", () => {
  const catalog = [
    { id: "Qwen3-0.6B-GGUF", recipe: "llamacpp" },
    { id: "Qwen2.5-0.5B-Instruct-CPU", recipe: "ryzenai-llm" },
    { id: "Llama-3.2-3B-Instruct-Hybrid", recipe: "ryzenai-llm" },
    { id: "some-vllm-model", recipe: "vllm" },
  ];

  const { usable, blocked } = partitionByRunnable(catalog, states);

  assert.deepEqual(usable.map((m) => m.id), ["Qwen3-0.6B-GGUF"]);
  assert.equal(blocked.length, 3);
});

test("a model whose engine merely needs installing is not hidden", () => {
  // Hiding it would be the wrong call: it is one button away from working,
  // and the button is on another screen.
  const { usable, blocked } = partitionByRunnable(
    [{ id: "whisper-base", recipe: "whispercpp" }],
    states,
  );
  assert.equal(usable.length, 1);
  assert.equal(blocked.length, 0);
});

test('a "-CPU" model can still be one this machine cannot run', () => {
  // The trap this whole module exists for: the suffix is AMD's OGA CPU
  // runtime, not "runs on any processor".
  assert.equal(runnable("ryzenai-llm", states).state, "unsupported");
});

/* --------------------------------------------- a build waiting to install -- */

/**
 * `update_required`, which used to fall off the end of the chain.
 *
 * Captured from the daemon with the llama.cpp pin moved from b10375 to b10793
 * and nothing else changed. The engine was on disk and working -- a model
 * loaded and generated through it seconds later -- while MyRA was telling
 * people the hardware was missing.
 */
const PENDING: EngineInfo[] = [
  { id: "llamacpp", backends: [
    { id: "cpu", state: "update_required", version: "b10375" },
    { id: "cuda", state: "unsupported" },
    { id: "vulkan", state: "update_required", version: "b10375" },
  ] },
];

test("an engine with a newer build pinned is not reported as unrunnable", () => {
  const verdict = runnable("llamacpp", engineStates(PENDING));
  assert.equal(verdict.state, "update-pending");
  assert.notEqual(verdict.state, "unsupported");
  assert.doesNotMatch(verdict.reason, /no way to run|hardware it needs/i);
});

test("a pending update says a download is coming, since loading one starts it", () => {
  // The daemon fetches the new build on the next /load without asking, so the
  // one thing worth saying is that it is going to.
  assert.match(runnable("llamacpp", engineStates(PENDING)).reason, /download/i);
});

test("models still run on an engine with an update pending", () => {
  const { usable, blocked } = partitionByRunnable(
    [{ id: "Qwen3-0.6B-GGUF", recipe: "llamacpp" }],
    engineStates(PENDING),
  );
  assert.equal(usable.length, 1);
  assert.equal(blocked.length, 0);
});

test("an installed backend outranks one waiting on an update", () => {
  // Mixed states are the normal case mid-upgrade: Vulkan reinstalled, CPU not.
  const mixed = engineStates([{ id: "llamacpp", backends: [
    { id: "cpu", state: "update_required" },
    { id: "vulkan", state: "installed" },
  ] }]);
  assert.equal(mixed.get("llamacpp"), "ready");
});

test("engineUsable is what every can-this-run gate asks", () => {
  assert.equal(engineUsable("ready"), true);
  assert.equal(engineUsable("update-pending"), true);
  assert.equal(engineUsable("needs-engine"), false);
  assert.equal(engineUsable("unsupported"), false);
  assert.equal(engineUsable(undefined), false);
});
