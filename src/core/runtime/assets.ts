/**
 * Choosing which llama.cpp build to download.
 *
 * Upstream publishes 27 assets per build and names them by platform, then
 * backend, then architecture -- with a version number embedded in the CUDA and
 * ROCm names that moves without warning. So the mapping is done with patterns
 * rather than a hardcoded table of filenames, which would break on the next
 * toolchain bump.
 *
 * Two facts about upstream's releases drive everything here, and both were
 * checked against the API rather than assumed:
 *
 *   1. **`releases/latest` is the wrong endpoint.** It answers `v0.3.0`, a
 *      release carrying a single text file. Every actual build is tagged `bNNNN`
 *      and marked `prerelease: true`, which is exactly what "latest" filters
 *      out. So we list releases and take the newest `b`-tag ourselves.
 *   2. **Every asset carries a sha256 in the API response.** The digest comes
 *      from api.github.com and the bytes come from the release CDN, so checking
 *      one against the other is worth doing and costs nothing.
 */

export type Backend = "cpu" | "vulkan" | "cuda" | "rocm" | "metal";

export interface ReleaseAsset {
  name: string;
  size: number;
  /** "sha256:abc…" as GitHub returns it, or undefined on older releases. */
  digest?: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  assets: ReleaseAsset[];
}

/** A build tag, `b10628`. Anything else is not a llama.cpp build release. */
export const BUILD_TAG = /^b(\d+)$/;

export function buildNumber(tag: string): number | undefined {
  const m = BUILD_TAG.exec(tag);
  return m ? Number(m[1]) : undefined;
}

/**
 * The newest build in a release listing.
 *
 * Sorted by build number rather than by date: the API returns creation order,
 * which is *usually* the same thing and is not guaranteed to be.
 */
export function newestBuild(releases: Release[]): Release | undefined {
  let best: Release | undefined;
  let bestN = -1;
  for (const r of releases) {
    const n = buildNumber(r.tag_name);
    if (n !== undefined && n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

export interface Target {
  /** As `process.platform` reports it. */
  platform: NodeJS.Platform;
  /** As `process.arch` reports it. */
  arch: string;
  backend: Backend;
}

/**
 * Patterns for one platform+arch, keyed by backend.
 *
 * `[^.]*` before the architecture is what absorbs the version numbers in
 * `rocm-7.14` and `cuda-12.4` without pinning us to a particular toolchain
 * release.
 */
function pattern(t: Target): RegExp | undefined {
  const { platform, arch, backend } = t;

  if (platform === "darwin") {
    // Metal is compiled into the mac binaries; there is no separate build and
    // therefore no backend choice to offer an Apple user.
    if (backend !== "metal" && backend !== "cpu") return undefined;
    return arch === "arm64" ? /-bin-macos-arm64\.tar\.gz$/ : /-bin-macos-x64\.tar\.gz$/;
  }

  if (platform === "linux") {
    const a = arch === "arm64" ? "arm64" : "x64";
    switch (backend) {
      case "cpu":
        return new RegExp(`-bin-ubuntu-${a}\\.tar\\.gz$`);
      case "vulkan":
        return new RegExp(`-bin-ubuntu-vulkan-${a}\\.tar\\.gz$`);
      case "rocm":
        return new RegExp(`-bin-ubuntu-rocm-[^-]*-${a}\\.tar\\.gz$`);
      // Deliberately absent: upstream publishes no Linux CUDA asset. Checked
      // across b10598..b10629. See RUNTIME-PLAN.md R7 -- an NVIDIA card on
      // Linux takes the Vulkan build until we build CUDA ourselves.
      default:
        return undefined;
    }
  }

  if (platform === "win32") {
    const a = arch === "arm64" ? "arm64" : "x64";
    switch (backend) {
      case "cpu":
        return new RegExp(`-bin-win-cpu-${a}\\.zip$`);
      case "vulkan":
        return a === "x64" ? /-bin-win-vulkan-x64\.zip$/ : undefined;
      case "cuda":
        return new RegExp(`-bin-win-cuda-[^-]*-${a}\\.zip$`);
      case "rocm":
        return a === "x64" ? /-bin-win-rocm-[^-]*-x64\.zip$/ : undefined;
      default:
        return undefined;
    }
  }

  return undefined;
}

/**
 * The asset to download, or undefined when this combination does not exist.
 *
 * When several match -- two CUDA toolchain versions ship in the same release --
 * the highest version wins, which is why the sort is by name descending.
 */
export function pickAsset(release: Release, target: Target): ReleaseAsset | undefined {
  const re = pattern(target);
  if (!re) return undefined;
  const matches = release.assets.filter((a) => re.test(a.name));
  if (matches.length <= 1) return matches[0];
  return [...matches].sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))[0];
}

/**
 * The CUDA runtime archive that must be unpacked alongside a Windows CUDA
 * build. Upstream ships the toolkit DLLs separately, and the server will not
 * start without them.
 */
export function pickCudart(release: Release, asset: ReleaseAsset): ReleaseAsset | undefined {
  const version = /-cuda-([^-]+)-/.exec(asset.name)?.[1];
  if (!version) return undefined;
  const arch = /-(x64|arm64)\.zip$/.exec(asset.name)?.[1] ?? "x64";
  return release.assets.find((a) => a.name === `cudart-llama-bin-win-cuda-${version}-${arch}.zip`);
}

/** Backends worth offering on this platform, best first. */
export function availableBackends(platform: NodeJS.Platform, arch: string): Backend[] {
  if (platform === "darwin") return ["metal"];
  if (platform === "win32") {
    return arch === "arm64" ? ["cuda", "cpu"] : ["cuda", "vulkan", "rocm", "cpu"];
  }
  if (platform === "linux") return ["vulkan", "rocm", "cpu"];
  return ["cpu"];
}

/** The sha256 hex from GitHub's `digest`, which is prefixed with the algorithm. */
export function sha256Of(asset: ReleaseAsset): string | undefined {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
  return m ? m[1]!.toLowerCase() : undefined;
}
