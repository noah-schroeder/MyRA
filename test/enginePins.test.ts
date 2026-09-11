/**
 * Writing a chosen engine build into Lemonade's own version table.
 *
 * The fixture is the real shape of `resources/backend_versions.json` from
 * lemonade 11.8.0, cut down but not rearranged -- including the two keys that
 * are not versions at all, which is what the merge has to survive.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  mergeBackendVersions, parsePinKey, pinKey, shippedVersion, withoutPin, withPin,
} from "../src/core/runtime/enginePins.ts";
import { applyEnginePins, shippedPath, shippedVersions, versionsPath } from "../src/main/runtime/engineVersions.ts";

const SHIPPED = {
  comment: "This configuration file controls which llama.cpp … versions are downloaded.",
  llamacpp: { vulkan: "b10375", cuda: "b10397", cpu: "b10375" },
  whispercpp: { cpu: "v1.8.4", vulkan: "v1.8.4" },
  kokoro: { cpu: "b17" },
  therock: { version: "7.14.0", architectures: ["gfx1151", "gfx1200"] },
};

test("a pin replaces exactly one backend and leaves its siblings alone", () => {
  const merged = mergeBackendVersions(SHIPPED, { "llamacpp:vulkan": "b10793" });
  assert.deepEqual(merged["llamacpp"], { vulkan: "b10793", cuda: "b10397", cpu: "b10375" });
  assert.deepEqual(merged["whispercpp"], SHIPPED.whispercpp);
});

test("the table MyRA was given is not mutated", () => {
  mergeBackendVersions(SHIPPED, { "llamacpp:vulkan": "b10793" });
  assert.equal(SHIPPED.llamacpp.vulkan, "b10375");
});

test("a pin cannot overwrite something that is not a version", () => {
  // `therock.architectures` is an array and `comment` is prose. Writing a
  // string over either gives the daemon a resources file it cannot parse.
  const merged = mergeBackendVersions(SHIPPED, {
    "therock:architectures": "b1",
    "llamacpp:comment": "x",
  });
  assert.deepEqual(merged["therock"], SHIPPED.therock);
  assert.deepEqual(merged["llamacpp"], SHIPPED.llamacpp);
});

test("a pin naming a backend the table does not version is dropped", () => {
  // It can only be a leftover from a Lemonade that had it, and inventing the
  // key would put a version somewhere nothing reads.
  const merged = mergeBackendVersions(SHIPPED, { "llamacpp:metal": "b1", "made-up:cpu": "b1" });
  assert.deepEqual(merged["llamacpp"], SHIPPED.llamacpp);
  assert.equal(merged["made-up"], undefined);
});

test("keys round-trip, including a backend name with no separator trouble", () => {
  assert.equal(pinKey("llamacpp", "rocm-stable"), "llamacpp:rocm-stable");
  assert.deepEqual(parsePinKey("llamacpp:rocm-stable"), { recipe: "llamacpp", backend: "rocm-stable" });
  assert.equal(parsePinKey("llamacpp"), undefined);
  assert.equal(parsePinKey(":vulkan"), undefined);
  assert.equal(parsePinKey("llamacpp:"), undefined);
});

test("shippedVersion reads through the table, not around it", () => {
  assert.equal(shippedVersion(SHIPPED, "llamacpp", "cuda"), "b10397");
  assert.equal(shippedVersion(SHIPPED, "therock", "architectures"), undefined);
  assert.equal(shippedVersion(SHIPPED, "nope", "cpu"), undefined);
});

test("dropping a pin is how a build goes back to the shipped one", () => {
  const pinned = withPin({}, "llamacpp:vulkan", "b10793");
  assert.equal(mergeBackendVersions(SHIPPED, pinned)["llamacpp"]?.["vulkan" as never], "b10793");
  const cleared = withoutPin(pinned, "llamacpp:vulkan");
  assert.deepEqual(mergeBackendVersions(SHIPPED, cleared)["llamacpp"], SHIPPED.llamacpp);
});

/* ------------------------------------------------------------- on disk -- */

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "myra-pins-"));
  await mkdir(join(dir, "resources"), { recursive: true });
  await writeFile(versionsPath(dir), JSON.stringify(SHIPPED, null, 2));
  return dir;
}

test("the shipped table is copied before it is written over", async () => {
  const dir = await fixture();
  try {
    await applyEnginePins(dir, { "llamacpp:vulkan": "b10793" });
    const live = JSON.parse(await readFile(versionsPath(dir), "utf8")) as typeof SHIPPED;
    const copy = JSON.parse(await readFile(shippedPath(dir), "utf8")) as typeof SHIPPED;
    assert.equal(live.llamacpp.vulkan, "b10793");
    assert.equal(copy.llamacpp.vulkan, "b10375");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second pin still merges onto the shipped table, not the last write", async () => {
  // The bug this guards: merging onto the live file makes every previous
  // choice permanent, so nothing can ever be undone.
  const dir = await fixture();
  try {
    await applyEnginePins(dir, { "llamacpp:vulkan": "b10793" });
    await applyEnginePins(dir, { "llamacpp:cuda": "b10789" });
    const live = JSON.parse(await readFile(versionsPath(dir), "utf8")) as typeof SHIPPED;
    assert.equal(live.llamacpp.cuda, "b10789");
    assert.equal(live.llamacpp.vulkan, "b10375");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearing every pin restores the file Lemonade shipped", async () => {
  const dir = await fixture();
  try {
    await applyEnginePins(dir, { "llamacpp:vulkan": "b10793" });
    await applyEnginePins(dir, {});
    const live = JSON.parse(await readFile(versionsPath(dir), "utf8")) as typeof SHIPPED;
    assert.deepEqual(live.llamacpp, SHIPPED.llamacpp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no resources directory is a missing answer, not a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "myra-pins-"));
  try {
    assert.equal(await shippedVersions(dir), undefined);
    assert.equal(await applyEnginePins(dir, { "llamacpp:vulkan": "b1" }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
