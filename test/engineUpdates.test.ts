/**
 * The check itself: which backends get looked at, and what it asks about them.
 *
 * The daemon and GitHub are both stubbed, because the properties worth pinning
 * are about restraint -- what this does NOT ask, and when it declines to offer
 * anything -- and neither is observable against a live service.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkEngineUpdates, type CheckDeps } from "../src/main/runtime/engineUpdates.ts";
import type { MachineInfo } from "../src/core/runtime/systemInfo.ts";

const INFO: MachineInfo = {
  devices: [],
  backends: [],
  engines: [
    { id: "llamacpp", backends: [
      { id: "cpu", state: "installed", version: "b10375" },
      { id: "vulkan", state: "installed", version: "b10375" },
      { id: "cuda", state: "unsupported" },
      { id: "rocm", state: "installable", version: "b10470" },
    ] },
    { id: "kokoro", backends: [{ id: "cpu", state: "installed", version: "b17" }] },
  ],
};

const DRY: Record<string, { repo: string; version: string; filename: string }> = {
  "llamacpp:cpu": {
    repo: "ggml-org/llama.cpp", version: "b10375",
    filename: "llama-b10375-bin-ubuntu-x64.tar.gz",
  },
  "llamacpp:vulkan": {
    repo: "ggml-org/llama.cpp", version: "b10375",
    filename: "llama-b10375-bin-ubuntu-vulkan-x64.tar.gz",
  },
  "kokoro:cpu": {
    repo: "lemonade-sdk/Kokoros", version: "b17", filename: "kokoros-linux-x86_64.tar.gz",
  },
};

/*
 * The installed build's own release, which is fetched separately.
 *
 * Real and necessary: b10375 is four hundred builds behind llama.cpp's head,
 * so it is never on the page of recent releases, and its date is the only
 * thing that can prove b10793 is newer rather than merely different.
 */
const TAGS: Record<string, { tag_name: string; published_at: string }> = {
  "ggml-org/llama.cpp:b10375": { tag_name: "b10375", published_at: "2026-05-02T09:00:00Z" },
};

const RELEASES: Record<string, unknown> = {
  "ggml-org/llama.cpp": [{
    tag_name: "b10793",
    published_at: "2026-09-03T22:18:00Z",
    html_url: "https://github.com/ggml-org/llama.cpp/releases/tag/b10793",
    assets: [
      { name: "llama-b10793-bin-ubuntu-vulkan-x64.tar.gz", size: 33_802_116 },
      { name: "llama-b10793-bin-ubuntu-x64.tar.gz", size: 28_000_000 },
    ],
  }],
  "lemonade-sdk/Kokoros": [{
    tag_name: "b17",
    published_at: "2026-05-01T22:07:33Z",
    assets: [{ name: "kokoros-linux-x86_64.tar.gz", size: 21_400_000 }],
  }],
};

/** GitHub, reduced to the two routes this module uses. */
function serve(url: string): unknown {
  const repo = /repos\/(.+?)\/releases/.exec(url)?.[1] ?? "";
  if (url.includes("/releases/tags/")) {
    const tag = url.split("/").pop() ?? "";
    const pinned = TAGS[`${repo}:${tag}`];
    if (pinned) return pinned;
    const list = (RELEASES[repo] ?? []) as { tag_name: string }[];
    const hit = list.find((r) => r.tag_name === tag);
    if (!hit) throw new Error("404");
    return hit;
  }
  return RELEASES[repo] ?? [];
}

function harness(info: MachineInfo = INFO): { deps: CheckDeps; asked: string[] } {
  const asked: string[] = [];
  const deps: CheckDeps = {
    api: {
      systemInfo: async () => info,
      installDryRun: async (recipe: string, backend: string) => {
        const found = DRY[`${recipe}:${backend}`];
        if (!found) throw new Error(`no dry-run for ${recipe}:${backend}`);
        return { recipe, backend, url: "", supported: true, ...found };
      },
    },
    get: async (url: string) => {
      asked.push(url);
      return serve(url);
    },
    now: () => new Date("2026-09-03T12:00:00Z"),
  };
  return { deps, asked };
}

test("only installed backends are checked", async () => {
  // `installable` has nothing to update and already has an Install button;
  // `unsupported` cannot run here at all. Asking about either would spend a
  // request to be told something the screen already says.
  const { deps, asked } = harness();
  const check = await checkEngineUpdates(deps);
  assert.equal(check.checked, 3);
  assert.equal(asked.some((u) => u.includes("rocm")), false);
});

test("one release list per repository, not per backend", async () => {
  // llama.cpp's CPU and Vulkan builds are the same repository.
  const { deps, asked } = harness();
  await checkEngineUpdates(deps);
  const lists = asked.filter((u) => u.endsWith("/releases?per_page=30"));
  assert.equal(lists.length, 2);
  assert.equal(new Set(lists).size, 2);
});

test("each backend is offered its own file, not the engine's newest anything", async () => {
  const { deps } = harness();
  const check = await checkEngineUpdates(deps);
  const vulkan = check.updates.find((u) => u.backend === "vulkan");
  const cpu = check.updates.find((u) => u.backend === "cpu" && u.recipe === "llamacpp");
  assert.equal(vulkan?.asset, "llama-b10793-bin-ubuntu-vulkan-x64.tar.gz");
  assert.equal(cpu?.asset, "llama-b10793-bin-ubuntu-x64.tar.gz");
  assert.equal(vulkan?.sizeBytes, 33_802_116);
});

test("an engine already on the newest build is not offered one", async () => {
  const { deps } = harness();
  const check = await checkEngineUpdates(deps);
  assert.equal(check.updates.some((u) => u.recipe === "kokoro"), false);
});

test("a build already chosen is reported without asking GitHub about it", async () => {
  const info: MachineInfo = {
    devices: [], backends: [],
    engines: [{ id: "llamacpp", backends: [{
      id: "vulkan", state: "update_required", version: "b10375",
      pendingVersion: "b10793",
      releaseUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10793",
    }] }],
  };
  const { deps, asked } = harness(info);
  const check = await checkEngineUpdates(deps);
  assert.deepEqual(check.pending, [{
    recipe: "llamacpp", backend: "vulkan", from: "b10375", to: "b10793",
    releaseUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10793",
  }]);
  assert.equal(check.checked, 0);
  assert.equal(asked.length, 0);
});

test("a repository that cannot be read is named, and the rest still checked", async () => {
  const { deps } = harness();
  deps.get = async (url: string) => {
    if (url.includes("Kokoros")) throw new Error("network down");
    return serve(url);
  };
  const check = await checkEngineUpdates(deps);
  assert.deepEqual(check.unreachable, ["kokoro:cpu"]);
  assert.equal(check.updates.length, 2);
});

test("a backend the daemon will not resolve is reported, not skipped silently", async () => {
  // /install/dry-run answers 500 with a real sentence when no compatible
  // device is present. Swallowing that would leave a backend that looks
  // checked and never was.
  const { deps } = harness();
  deps.api = {
    ...deps.api,
    installDryRun: async () => { throw new Error("No compatible device detected"); },
  };
  const check = await checkEngineUpdates(deps);
  assert.equal(check.updates.length, 0);
  assert.equal(check.unreachable.length, 3);
});
