/**
 * Choosing a whisper.cpp build.
 *
 * The asset names below are upstream's real ones, read from the b4938 release
 * while this was written. Two facts about that feed drive everything here, and
 * a made-up fixture would show neither: the tags alternate between `v1.9.2` and
 * `b4938` with nothing to sort on, and a release can carry no assets at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  WHISPER_MODELS, newestWhisperRelease, suggestWhisperModel, whisperAsset, whisperUnavailable,
} from "../src/core/runtime/whisperAssets.ts";
import type { Release } from "../src/core/runtime/assets.ts";

const NAMES = [
  "whisper-b4938-xcframework.zip",
  "whisper-bin-ubuntu-arm64.tar.gz",
  "whisper-bin-ubuntu-x64.tar.gz",
  "whisper-bin-Win32.zip",
  "whisper-bin-x64.zip",
  "whisper-blas-bin-Win32.zip",
  "whisper-blas-bin-x64.zip",
  "whisper-cublas-11.8.0-bin-x64.zip",
  "whisper-cublas-12.4.0-bin-x64.zip",
];

const asset = (name: string) => ({
  name,
  size: 1,
  digest: "sha256:" + "a".repeat(64),
  browser_download_url: `https://example.invalid/${name}`,
});

const release = (tag: string, published: string, names = NAMES): Release => ({
  tag_name: tag,
  prerelease: false,
  published_at: published,
  assets: names.map(asset),
});

test("each machine gets a build it can actually run", () => {
  for (const [platform, arch, backend, expected] of [
    ["linux", "x64", undefined, "whisper-bin-ubuntu-x64.tar.gz"],
    ["linux", "arm64", undefined, "whisper-bin-ubuntu-arm64.tar.gz"],
    ["win32", "x64", undefined, "whisper-bin-x64.zip"],
    ["win32", "x64", "cuda", "whisper-cublas-12.4.0-bin-x64.zip"],
  ] as const) {
    const picked = whisperAsset(NAMES.map(asset), { platform, arch, ...(backend ? { backend } : {}) });
    assert.equal(picked?.name, expected, `${platform}/${arch}/${backend ?? "cpu"}`);
  }
});

test("the 32-bit Windows build is never picked for a 64-bit machine", () => {
  // `whisper-bin-Win32.zip` and `whisper-bin-x64.zip` differ by four characters
  // and a substring match would find the wrong one.
  const picked = whisperAsset(NAMES.map(asset), { platform: "win32", arch: "x64" });
  assert.equal(picked?.name, "whisper-bin-x64.zip");
});

test("macOS has nothing to download, and is told why", () => {
  assert.equal(whisperAsset(NAMES.map(asset), { platform: "darwin", arch: "arm64" }), undefined);
  // An xcframework is a thing you compile into an Xcode project, not a server
  // this app can start, so the message names the way out rather than the gap.
  assert.match(String(whisperUnavailable("darwin", "arm64")), /brew install whisper-cpp/);
});

test("Linux and Windows x64 report no obstacle", () => {
  assert.equal(whisperUnavailable("linux", "x64"), undefined);
  assert.equal(whisperUnavailable("win32", "x64"), undefined);
});

test("the newest release is the newest that carries a build, not the newest tag", () => {
  /*
   * The real trap. `v1.9.3` was published *after* `b4938` and carries no assets
   * at all, and the tags cannot be compared to each other -- "v1.9.3" against
   * "b4938" sorts on nothing meaningful. Picking by tag or by date alone gives
   * a release with nothing in it.
   */
  const releases: Release[] = [
    { tag_name: "v1.9.3", prerelease: true, published_at: "2026-08-20T12:00:00Z", assets: [] },
    release("b4938", "2026-08-20T09:00:00Z"),
    release("v1.9.2", "2026-08-04T09:00:00Z"),
  ];
  const chosen = newestWhisperRelease(releases, { platform: "linux", arch: "x64" });
  assert.equal(chosen?.tag_name, "b4938");
});

test("a machine with no build gets no release rather than the wrong one", () => {
  const releases = [release("b4938", "2026-08-20T09:00:00Z")];
  assert.equal(newestWhisperRelease(releases, { platform: "darwin", arch: "arm64" }), undefined);
});

test("every offered model states its size and whether it speaks other languages", () => {
  assert.ok(WHISPER_MODELS.length >= 3);
  for (const m of WHISPER_MODELS) {
    assert.match(m.file, /^ggml-.+\.bin$/, `${m.file} should be a ggml weights file`);
    assert.ok(m.bytes > 0, `${m.file} needs a real size`);
    assert.ok(m.hint.length > 10, `${m.file} needs a reason to pick it`);
    assert.equal(m.multilingual, !/\.en[-.]/.test(m.file), `${m.file}: .en files are English-only`);
  }
});

test("a small machine is not pointed at a model that will not fit beside a chat model", () => {
  assert.equal(suggestWhisperModel(4 * 1024 ** 3).file, "ggml-base.en-q5_1.bin");
  assert.equal(suggestWhisperModel(16 * 1024 ** 3).file, "ggml-small.en-q5_1.bin");
});
