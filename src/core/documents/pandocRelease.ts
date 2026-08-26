/**
 * Choosing which pandoc build to fetch.
 *
 * Checked against the API rather than assumed, the same discipline the
 * llama.cpp picker follows next door — and pandoc differs from llama.cpp in two
 * ways that matter:
 *
 *   1. **`releases/latest` is the right endpoint here.** pandoc publishes
 *      ordinary releases (`3.10.2`, `prerelease: false`), so unlike llama.cpp
 *      there is no need to list and sort tags ourselves.
 *   2. **Every asset carries a sha256 digest**, so the bytes from the CDN can
 *      be checked against a figure from the API.
 *
 * The naming is inconsistent between platforms and that is the whole reason
 * this is a pattern match rather than a table: Linux writes the architecture
 * after the platform (`linux-amd64`) and macOS writes it before
 * (`arm64-macOS`). Installers are excluded deliberately — a `.deb`, `.pkg` or
 * `.msi` would need a privileged install for a binary we only ever run
 * ourselves — and so is `pandoc-wasm`, which is not a native binary at all.
 */

import type { ReleaseAsset } from "../runtime/assets.ts";

/** A tarball or zip holding a runnable binary, as opposed to an installer. */
const ARCHIVE = /\.(tar\.gz|zip)$/i;

export interface PandocTarget {
  /** Node's `process.platform`. */
  platform: string;
  /** Node's `process.arch`. */
  arch: string;
}

/** The fragment of an asset name that identifies a platform and architecture. */
function pattern(target: PandocTarget): RegExp | undefined {
  const arm = target.arch === "arm64";
  switch (target.platform) {
    case "linux":
      return arm ? /linux-arm64/i : /linux-amd64/i;
    case "darwin":
      return arm ? /arm64-macOS/i : /x86_64-macOS/i;
    case "win32":
      // pandoc ships no 32-bit or arm64 Windows build; x86_64 runs under
      // emulation on arm64 Windows, which is better than nothing at all.
      return /windows-x86_64/i;
    default:
      return undefined;
  }
}

export function pandocAsset(
  assets: ReleaseAsset[],
  target: PandocTarget,
): ReleaseAsset | undefined {
  const wanted = pattern(target);
  if (!wanted) return undefined;
  return assets.find(
    (a) => ARCHIVE.test(a.name) && wanted.test(a.name) && !/^pandoc-wasm/i.test(a.name),
  );
}

/** "sha256:abc…" as GitHub returns it, reduced to the digest itself. */
export function digestOf(asset: ReleaseAsset): string | undefined {
  const raw = asset.digest;
  if (!raw) return undefined;
  const hex = raw.startsWith("sha256:") ? raw.slice(7) : raw;
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : undefined;
}
