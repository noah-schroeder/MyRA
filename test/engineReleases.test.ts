/**
 * Choosing an engine build to offer, against the release data that broke the
 * obvious implementations.
 *
 * Every name, tag and repository below was read off GitHub and off the
 * daemon's own `/install/dry-run` while this was written. They are here
 * because each one is a trap: an asset-less release, a dependency drop wearing
 * a release's clothes, a tag that does not appear in its own filename, and a
 * filename with no version in it at all.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assetShape, matchingAsset, newerThan, newestBuild, parseReleases,
  type InstalledBuild, type Release,
} from "../src/core/runtime/engineReleases.ts";

const release = (
  tag: string, assets: string[], publishedAt?: string, prerelease = false,
): Release => ({
  tag,
  prerelease,
  ...(publishedAt ? { publishedAt } : {}),
  assets: assets.map((name) => ({ name, sizeBytes: 33_802_116 })),
});

/* ------------------------------------------------------------- the shape -- */

test("a build number is blanked because the tag contains it", () => {
  assert.equal(
    assetShape("llama-b10375-bin-ubuntu-vulkan-x64.tar.gz", "b10375"),
    "llama-*-bin-ubuntu-vulkan-x64.tar.gz",
  );
});

test("the distro version survives, because the tag says nothing about it", () => {
  // Ubuntu 24.04 is what the build targets, not when it was cut. A
  // looks-like-a-version rule blanks it and makes a 22.04 asset and a 24.04
  // asset the same file.
  const shape = assetShape("sd-master-97d2990-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip", "master-827-97d2990");
  assert.equal(shape, "sd-*-*-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip");
  assert.match(shape, /24\.04/);
});

test("a filename carrying no version at all is left alone", () => {
  assert.equal(assetShape("kokoros-linux-x86_64.tar.gz", "b17"), "kokoros-linux-x86_64.tar.gz");
});

/* ------------------------------------------------ picking the same file -- */

test("stable-diffusion's dropped middle segment still matches", () => {
  // The tag is master-827-97d2990 and the file is sd-master-97d2990-…: the
  // build number in the middle of the tag never reaches the filename.
  const current: InstalledBuild = {
    recipe: "sd-cpp", backend: "vulkan", repo: "leejet/stable-diffusion.cpp",
    version: "master-827-97d2990",
    filename: "sd-master-97d2990-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
    publishedAt: "2026-05-01T00:00:00Z",
  };
  const found = newestBuild(current, [
    release("master-841-6b3edaa", [
      "sd-master-6b3edaa-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
      "sd-master-6b3edaa-bin-Linux-Ubuntu-24.04-x86_64-cpu.zip",
    ], "2026-08-30T18:29:03Z"),
  ]);
  assert.equal(found?.to, "master-841-6b3edaa");
  assert.equal(found?.asset, "sd-master-6b3edaa-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip");
});

test("two candidate assets in one release means no offer", () => {
  // Guessing between a CPU build and a Vulkan one costs somebody an engine
  // that will not start. Losing the update costs them nothing today.
  const ambiguous = release("b2", ["x-b2-linux.tar.gz", "x-b2-linux.tar.gz"]);
  assert.equal(matchingAsset(ambiguous, "x-*-linux.tar.gz"), undefined);
});

/* -------------------------------------------------- what is not a build -- */

test("a source-only release is skipped rather than offered", () => {
  // ggml-org/whisper.cpp v1.9.3, read from GitHub: zero assets.
  const current: InstalledBuild = {
    recipe: "whispercpp", backend: "vulkan", repo: "lemonade-sdk/whisper.cpp-rocm",
    version: "v1.8.4", filename: "whisper-v1.8.4-linux-vulkan-x86_64.tar.gz",
    publishedAt: "2026-06-20T18:31:26Z",
  };
  assert.equal(newestBuild(current, [release("v1.9.3", [], "2026-08-20T11:39:36Z")]), undefined);
});

test("a dependency drop is not mistaken for an engine", () => {
  // The newest tag in whisper.cpp-rocm is `deps`, carrying flexmlrt.
  const current: InstalledBuild = {
    recipe: "whispercpp", backend: "vulkan", repo: "lemonade-sdk/whisper.cpp-rocm",
    version: "v1.8.4", filename: "whisper-v1.8.4-linux-vulkan-x86_64.tar.gz",
    publishedAt: "2026-06-20T18:31:26Z",
  };
  const found = newestBuild(current, [
    release("deps", ["flexmlrt-1.8.0-linux.tar.gz"], "2026-07-30T05:49:37Z"),
  ]);
  assert.equal(found, undefined);
});

test("a real build behind a dependency drop is still found", () => {
  const current: InstalledBuild = {
    recipe: "whispercpp", backend: "vulkan", repo: "lemonade-sdk/whisper.cpp-rocm",
    version: "v1.8.3", filename: "whisper-v1.8.3-linux-vulkan-x86_64.tar.gz",
    publishedAt: "2026-01-01T00:00:00Z",
  };
  const found = newestBuild(current, [
    release("deps", ["flexmlrt-1.8.0-linux.tar.gz"], "2026-07-30T05:49:37Z"),
    release("v1.8.4", [
      "whisper-v1.8.4-linux-vulkan-x86_64.tar.gz",
      "whisper-v1.8.4-linux-cpu-x86_64.tar.gz",
      "whisper-b4281-linux-musl-vulkan-x86_64.tar.gz",
    ], "2026-06-20T18:31:26Z"),
  ]);
  assert.equal(found?.to, "v1.8.4");
  assert.equal(found?.asset, "whisper-v1.8.4-linux-vulkan-x86_64.tar.gz");
});

test("drafts never reach the list, prereleases are kept and labelled", () => {
  // Dropping prereleases here excluded every llama.cpp build there has ever
  // been: ggml-org flags all of them, including the b10375 already installed.
  const parsed = parseReleases([
    { tag_name: "b3", draft: true, assets: [] },
    { tag_name: "b2", prerelease: true, assets: [] },
    { tag_name: "b1", assets: [{ name: "x", size: 5 }] },
  ]);
  assert.deepEqual(parsed.map((r) => r.tag), ["b2", "b1"]);
  assert.equal(parsed[0]?.prerelease, true);
  assert.equal(parsed[1]?.prerelease, false);
});

/* ---------------------------------------------- upstream's own labelling -- */

const LLAMA: InstalledBuild = {
  recipe: "llamacpp", backend: "vulkan", repo: "ggml-org/llama.cpp",
  version: "b10375", filename: "llama-b10375-bin-ubuntu-vulkan-x64.tar.gz",
  publishedAt: "2026-08-12T12:18:24Z",
};

test("a prerelease flag does not hide a build, it travels with it", () => {
  // Real values: b10375 is installed and is a FULL release, while b10793 is
  // flagged prerelease -- llama.cpp changed how it publishes on 21 August
  // 2026, mid-history. Two earlier rules keyed on this flag, and both offered
  // nothing at all for the engine that runs chat.
  const found = newestBuild(
    LLAMA,
    [release("b10793", ["llama-b10793-bin-ubuntu-vulkan-x64.tar.gz"], "2026-09-03T22:18:00Z", true)],
  );
  assert.equal(found?.to, "b10793");
  assert.equal(found?.prerelease, true);
});

test("a full release says so too, so the label is never merely absent", () => {
  const found = newestBuild(
    LLAMA,
    [release("b10793", ["llama-b10793-bin-ubuntu-vulkan-x64.tar.gz"], "2026-09-03T22:18:00Z", false)],
  );
  assert.equal(found?.prerelease, false);
});

test("the installed tag's position in the list settles what is newer", () => {
  const list = [release("b3", []), release("b2", []), release("b1", [])];
  assert.deepEqual(newerThan(list, "b2").map((r) => r.tag), ["b3"]);
});

test("a build older than the page is ordered by date instead", () => {
  // b10375 is four hundred builds behind llama.cpp's head, so it is never on
  // the page that gets fetched.
  const list = [
    release("b10793", [], "2026-09-03T22:18:00Z"),
    release("b10792", [], "2026-09-03T21:00:00Z"),
  ];
  assert.deepEqual(
    newerThan(list, "b10375", "2026-05-01T00:00:00Z").map((r) => r.tag),
    ["b10793", "b10792"],
  );
});

test("with no way to prove a release is newer, nothing is offered", () => {
  // Kokoro's filename is the same in every release, so the file matching says
  // yes to all of them. Only the ordering stops b10 being sold as an update
  // to b17.
  const current: InstalledBuild = {
    recipe: "kokoro", backend: "cpu", repo: "lemonade-sdk/Kokoros",
    version: "b17", filename: "kokoros-linux-x86_64.tar.gz",
  };
  const older = [release("b16", ["kokoros-linux-x86_64.tar.gz"], "2025-01-01T00:00:00Z")];
  assert.equal(newestBuild(current, older), undefined);
});

test("kokoro at the head of its own list is offered nothing", () => {
  const current: InstalledBuild = {
    recipe: "kokoro", backend: "cpu", repo: "lemonade-sdk/Kokoros",
    version: "b17", filename: "kokoros-linux-x86_64.tar.gz",
    publishedAt: "2026-05-01T22:07:33Z",
  };
  const list = [
    release("b17", ["kokoros-linux-x86_64.tar.gz"], "2026-05-01T22:07:33Z"),
    release("b16", ["kokoros-linux-x86_64.tar.gz"], "2025-11-01T00:00:00Z"),
  ];
  assert.equal(newestBuild(current, list), undefined);
});

test("the size offered is the one GitHub reports for that exact file", () => {
  const current: InstalledBuild = {
    recipe: "llamacpp", backend: "vulkan", repo: "ggml-org/llama.cpp",
    version: "b10375", filename: "llama-b10375-bin-ubuntu-vulkan-x64.tar.gz",
    publishedAt: "2026-05-01T00:00:00Z",
  };
  const found = newestBuild(current, [{
    tag: "b10793",
    prerelease: false,
    publishedAt: "2026-09-03T22:18:00Z",
    url: "https://github.com/ggml-org/llama.cpp/releases/tag/b10793",
    assets: [
      { name: "llama-b10793-bin-ubuntu-vulkan-x64.tar.gz", sizeBytes: 33_802_116 },
      { name: "llama-b10793-bin-ubuntu-x64.tar.gz", sizeBytes: 28_000_000 },
    ],
  }]);
  assert.equal(found?.sizeBytes, 33_802_116);
  assert.equal(found?.releaseUrl, "https://github.com/ggml-org/llama.cpp/releases/tag/b10793");
});
