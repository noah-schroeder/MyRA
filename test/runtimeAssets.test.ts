/**
 * Choosing a llama.cpp build.
 *
 * The asset list below is upstream's real one, copied from release b10628 on
 * 2026-08-25. That matters: the two bugs this module exists to avoid are both
 * facts about the real feed rather than things a made-up fixture would show.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  availableBackends, buildNumber, newestBuild, pickAsset, pickCudart, sha256Of,
  type Release,
} from "../src/core/runtime/assets.ts";

const NAMES = [
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.3-x64.zip",
  "llama-b10628-bin-macos-arm64.tar.gz",
  "llama-b10628-bin-macos-x64.tar.gz",
  "llama-b10628-bin-ubuntu-arm64.tar.gz",
  "llama-b10628-bin-ubuntu-rocm-7.14-x64.tar.gz",
  "llama-b10628-bin-ubuntu-sycl-fp16-x64.tar.gz",
  "llama-b10628-bin-ubuntu-vulkan-arm64.tar.gz",
  "llama-b10628-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b10628-bin-ubuntu-x64.tar.gz",
  "llama-b10628-bin-win-cpu-x64.zip",
  "llama-b10628-bin-win-cuda-12.4-x64.zip",
  "llama-b10628-bin-win-cuda-13.3-x64.zip",
  "llama-b10628-bin-win-vulkan-x64.zip",
];

const asset = (name: string) => ({
  name,
  size: 1,
  digest: "sha256:" + "a".repeat(64),
  browser_download_url: `https://example.invalid/${name}`,
});

const build: Release = {
  tag_name: "b10628",
  prerelease: true,
  published_at: "2026-08-25T18:06:50Z",
  assets: NAMES.map(asset),
};

test("the newest build is found by build number, and v-tags are ignored", () => {
  // This is the actual trap: GitHub's own releases/latest answers v0.3.0,
  // because every real build is flagged prerelease and gets filtered out.
  const releases: Release[] = [
    { tag_name: "v0.3.0", prerelease: false, published_at: "2026-08-25T10:22:58Z", assets: [] },
    { ...build, tag_name: "b10621" },
    build,
    { ...build, tag_name: "b10625" },
  ];
  assert.equal(newestBuild(releases)?.tag_name, "b10628");
  assert.equal(buildNumber("v0.3.0"), undefined);
  assert.equal(buildNumber("b10628"), 10628);
});

test("each platform gets the build it can actually run", () => {
  const pick = (platform: NodeJS.Platform, arch: string, backend: Parameters<typeof pickAsset>[1]["backend"]) =>
    pickAsset(build, { platform, arch, backend })?.name;

  assert.equal(pick("darwin", "arm64", "metal"), "llama-b10628-bin-macos-arm64.tar.gz");
  assert.equal(pick("darwin", "x64", "metal"), "llama-b10628-bin-macos-x64.tar.gz");
  assert.equal(pick("linux", "x64", "cpu"), "llama-b10628-bin-ubuntu-x64.tar.gz");
  assert.equal(pick("linux", "x64", "vulkan"), "llama-b10628-bin-ubuntu-vulkan-x64.tar.gz");
  assert.equal(pick("linux", "arm64", "vulkan"), "llama-b10628-bin-ubuntu-vulkan-arm64.tar.gz");
  assert.equal(pick("win32", "x64", "cpu"), "llama-b10628-bin-win-cpu-x64.zip");
  assert.equal(pick("win32", "x64", "vulkan"), "llama-b10628-bin-win-vulkan-x64.zip");
});

test("the ROCm version number is absorbed rather than pinned", () => {
  // 7.14 today, something else next quarter; a hardcoded filename would break.
  assert.equal(
    pickAsset(build, { platform: "linux", arch: "x64", backend: "rocm" })?.name,
    "llama-b10628-bin-ubuntu-rocm-7.14-x64.tar.gz",
  );
});

test("Linux CUDA does not exist, and asking for it says so rather than guessing", () => {
  // Upstream ships no such asset -- rechecked at b10642, whose ubuntu builds are
  // cpu, vulkan, rocm, sycl and openvino and nothing else. Returning undefined
  // is what makes the caller fall back instead of downloading something that is
  // not a CUDA build.
  assert.equal(pickAsset(build, { platform: "linux", arch: "x64", backend: "cuda" }), undefined);
});

test("a Linux CUDA asset would be recognised on the day upstream ships one", () => {
  /*
   * The pattern is written ahead of the asset, following upstream's own naming
   * for the build they *do* publish for Linux -- rocm-7.14 -- so the day a
   * cuda-12.4 appears beside it, or we build one ourselves under the same name,
   * it is picked up with no code change. This is the only test that has ever
   * exercised that branch, because no real release has matched it.
   */
  const future: Release = {
    ...build,
    assets: [
      ...build.assets,
      asset("llama-b10628-bin-ubuntu-cuda-12.4-x64.tar.gz"),
      asset("llama-b10628-bin-ubuntu-cuda-13.3-x64.tar.gz"),
    ],
  };
  const chosen = pickAsset(future, { platform: "linux", arch: "x64", backend: "cuda" });
  assert.equal(chosen?.name, "llama-b10628-bin-ubuntu-cuda-13.3-x64.tar.gz", "newest toolchain wins");
});

test("the newest CUDA toolchain wins when a release carries several", () => {
  const chosen = pickAsset(build, { platform: "win32", arch: "x64", backend: "cuda" });
  assert.equal(chosen?.name, "llama-b10628-bin-win-cuda-13.3-x64.zip");
  // And its separate runtime archive has to come with it, or nothing starts.
  assert.equal(pickCudart(build, chosen!)?.name, "cudart-llama-bin-win-cuda-13.3-x64.zip");
});

test("Apple is offered no backend choice, because there is none to make", () => {
  assert.deepEqual(availableBackends("darwin", "arm64"), ["metal"]);
  assert.ok(availableBackends("linux", "x64").includes("vulkan"));
  assert.ok(!availableBackends("linux", "x64").includes("cuda"));
});

test("a digest is only accepted in the form GitHub actually sends", () => {
  assert.equal(sha256Of({ name: "x", size: 1, digest: "sha256:" + "A".repeat(64), browser_download_url: "" }), "a".repeat(64));
  assert.equal(sha256Of({ name: "x", size: 1, digest: "md5:abc", browser_download_url: "" }), undefined);
  assert.equal(sha256Of({ name: "x", size: 1, browser_download_url: "" }), undefined);
});
