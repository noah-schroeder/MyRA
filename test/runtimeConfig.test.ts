/**
 * The runtime config is a stored value that decides where the process looks.
 *
 * `myra:runtime-config` handed the window's patch straight to a spread and a
 * write. Three fields matter: `modelsDir` is the jail root model deletion
 * checks against, `extraModelDirs` are symlinked into the index and given to
 * the daemon, and an engine pin's version becomes part of a URL it fetches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assertModelId, mergeRuntimeConfig, type StoredRuntimeConfig,
} from "../src/core/runtime/runtimeConfig.ts";

const DEFAULTS: StoredRuntimeConfig = {
  modelsDir: join(homedir(), ".local", "share", "myra", "models"),
  startOnLaunch: false,
  useForChat: true,
  importForeignModels: true,
};

test("a models directory that cannot be a jail root falls back", () => {
  for (const bad of ["/", "", "relative/dir", 42, null, homedir()]) {
    const out = mergeRuntimeConfig({ modelsDir: bad }, DEFAULTS);
    assert.equal(out.modelsDir, DEFAULTS.modelsDir, `${JSON.stringify(bad)} was accepted`);
  }
  const mine = join(homedir(), "models");
  assert.equal(mergeRuntimeConfig({ modelsDir: mine }, DEFAULTS).modelsDir, mine);
});

test("extra model directories are filtered rather than trusted as a list", () => {
  const good = join(homedir(), "lmstudio");
  const out = mergeRuntimeConfig({ extraModelDirs: ["/", good, "", 7, "rel"] }, DEFAULTS);
  assert.deepEqual(out.extraModelDirs, [good]);
  // All bad is no list at all, not a list of empty strings.
  assert.equal(mergeRuntimeConfig({ extraModelDirs: ["/"] }, DEFAULTS).extraModelDirs, undefined);
});

test("a switch that is not a boolean is the default, not truthy", () => {
  const out = mergeRuntimeConfig({ startOnLaunch: "yes", useForChat: 0 }, DEFAULTS);
  assert.equal(out.startOnLaunch, false);
  assert.equal(out.useForChat, true);
});

test("an engine pin keeps its shape or is dropped", () => {
  const out = mergeRuntimeConfig(
    {
      enginePins: {
        "llamacpp:vulkan": "b1234",
        "../../etc": "x",
        "llamacpp:cuda": "../../../evil",
        "no-separator": "b1",
        "llamacpp:rocm": 9,
      },
    },
    DEFAULTS,
  );
  assert.deepEqual(out.enginePins, { "llamacpp:vulkan": "b1234" });
});

test("a model id may carry one slash and nothing else", () => {
  for (const ok of ["Qwen3-8B-GGUF", "user/Qwen3-8B", "a.b_c-d"]) {
    assert.equal(assertModelId(ok), ok);
  }
  for (const bad of ["../../etc/passwd", "/etc/passwd", "a/b/c", "..", ".", "a\0b", "", "a b"]) {
    assert.throws(() => assertModelId(bad), /no model named/, `${JSON.stringify(bad)} was accepted`);
  }
});

test("a stored model id that is not one is cleared, not substituted", () => {
  const out = mergeRuntimeConfig({ activeModel: "../../x", defaultModel: "user/ok" }, DEFAULTS);
  assert.equal(out.activeModel, undefined, "no model chosen is a real state");
  assert.equal(out.defaultModel, "user/ok");
});
