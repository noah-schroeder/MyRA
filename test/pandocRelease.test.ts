/**
 * Picking a pandoc build out of a release listing.
 *
 * The asset names below are the real ones from pandoc 3.10.2, read from
 * api.github.com while this was written. The trap they encode: Linux writes the
 * architecture after the platform and macOS writes it before, so a naive
 * "contains arm64" match picks the Linux arm64 tarball for an Apple Silicon
 * Mac — and a naive "contains amd64" match finds nothing on macOS at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { digestOf, pandocAsset } from "../src/core/documents/pandocRelease.ts";
import type { ReleaseAsset } from "../src/core/runtime/assets.ts";

const NAMES = [
  "pandoc-3.10.2-1-amd64.deb",
  "pandoc-3.10.2-1-arm64.deb",
  "pandoc-3.10.2-arm64-macOS.pkg",
  "pandoc-3.10.2-arm64-macOS.zip",
  "pandoc-3.10.2-linux-amd64.tar.gz",
  "pandoc-3.10.2-linux-arm64.tar.gz",
  "pandoc-3.10.2-windows-x86_64.msi",
  "pandoc-3.10.2-windows-x86_64.zip",
  "pandoc-3.10.2-x86_64-macOS.pkg",
  "pandoc-3.10.2-x86_64-macOS.zip",
  "pandoc-wasm-3.10.2.zip",
];

const ASSETS: ReleaseAsset[] = NAMES.map((name) => ({
  name,
  size: 1,
  digest: "sha256:" + "a".repeat(64),
  browser_download_url: `https://example.invalid/${name}`,
}));

test("each platform gets its own archive, not an installer", () => {
  for (const [platform, arch, expected] of [
    ["linux", "x64", "pandoc-3.10.2-linux-amd64.tar.gz"],
    ["linux", "arm64", "pandoc-3.10.2-linux-arm64.tar.gz"],
    ["darwin", "arm64", "pandoc-3.10.2-arm64-macOS.zip"],
    ["darwin", "x64", "pandoc-3.10.2-x86_64-macOS.zip"],
    ["win32", "x64", "pandoc-3.10.2-windows-x86_64.zip"],
    // No arm64 Windows build exists; the x86_64 one runs under emulation.
    ["win32", "arm64", "pandoc-3.10.2-windows-x86_64.zip"],
  ] as const) {
    const picked = pandocAsset(ASSETS, { platform, arch });
    assert.equal(picked?.name, expected, `${platform}/${arch}`);
  }
});

test("installers and the wasm build are never chosen", () => {
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const) {
    const picked = pandocAsset(ASSETS, { platform, arch });
    assert.ok(picked);
    assert.ok(!/\.(deb|pkg|msi)$/.test(picked.name), `${picked.name} is an installer`);
    assert.ok(!picked.name.startsWith("pandoc-wasm"), `${picked.name} is not a native binary`);
  }
});

test("an unsupported platform picks nothing rather than the wrong thing", () => {
  assert.equal(pandocAsset(ASSETS, { platform: "freebsd", arch: "x64" }), undefined);
});

test("the digest is unwrapped, and a malformed one is refused", () => {
  const good = { ...ASSETS[0]!, digest: "sha256:" + "F".repeat(64) };
  assert.equal(digestOf(good), "f".repeat(64));
  assert.equal(digestOf({ ...ASSETS[0]!, digest: "md5:abc" }), undefined);
  assert.equal(digestOf({ name: "x", size: 1, browser_download_url: "u" }), undefined);
});
