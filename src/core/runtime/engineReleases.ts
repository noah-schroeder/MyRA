/**
 * Which newer engine build, if any, Karen can honestly offer.
 *
 * The naive version of this -- take the repository's latest tag -- is wrong in
 * three different ways, and all three were hit on the first attempt against
 * real data:
 *
 *   - **`ggml-org/whisper.cpp v1.9.3` has no assets at all.** Source-only
 *     releases are normal, and there is nothing to install in one.
 *   - **The repository that publishes an engine is not the obvious one.**
 *     Whisper's binaries come from `lemonade-sdk/whisper.cpp-rocm`, whose
 *     newest tag is `deps` -- a dependency drop carrying `flexmlrt-1.8.0`, not
 *     a whisper build.
 *   - **A tag is not a filename.** stable-diffusion.cpp's tag
 *     `master-827-97d2990` produces
 *     `sd-master-97d2990-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`: the middle
 *     segment is dropped. Anything that composed a URL from a tag would ask
 *     for a file that is not there.
 *
 * So nothing here is composed. The daemon says which repository and which
 * exact filename it would use for the build now installed
 * (`POST /install/dry-run`), GitHub says which files each release actually
 * contains, and this module's whole job is to decide which file in a newer
 * release is *the same file*. Both sides are real data; neither is guessed.
 */

/** One file attached to a release, as GitHub reports it. */
export interface ReleaseAsset {
  name: string;
  sizeBytes: number;
}

export interface Release {
  tag: string;
  /** ISO 8601, and the only ordering that works for every repository here. */
  publishedAt?: string | undefined;
  /** The release's page, for someone who wants to read what changed. */
  url?: string | undefined;
  assets: ReleaseAsset[];
}

export function releasesUrl(repo: string, perPage = 30): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`;
}

export function releaseTagUrl(repo: string, tag: string): string {
  return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function parseRelease(raw: unknown): Release | undefined {
  const r = obj(raw);
  const tag = str(r["tag_name"]);
  if (!tag) return undefined;
  /* Drafts are not published and prereleases are not what an academic writing
     a paper wants underneath them. Both are dropped here rather than filtered
     by the caller, because "offer only what is finished" is a property of this
     module, not a preference of one screen. */
  if (r["draft"] === true || r["prerelease"] === true) return undefined;
  const assets = Array.isArray(r["assets"]) ? r["assets"] : [];
  return {
    tag,
    ...(str(r["published_at"]) ? { publishedAt: str(r["published_at"]) } : {}),
    ...(str(r["html_url"]) ? { url: str(r["html_url"]) } : {}),
    assets: assets.flatMap((value) => {
      const a = obj(value);
      const name = str(a["name"]);
      const size = a["size"];
      return name ? [{ name, sizeBytes: typeof size === "number" ? size : 0 }] : [];
    }),
  };
}

export function parseReleases(raw: unknown): Release[] {
  return (Array.isArray(raw) ? raw : []).flatMap((r) => {
    const parsed = parseRelease(r);
    return parsed ? [parsed] : [];
  });
}

const ARCHIVE_SUFFIX = /\.(tar\.gz|tar\.xz|tar\.bz2|tgz|zip|gz|xz|7z)$/i;

/**
 * An asset name with the parts its own tag supplied blanked out.
 *
 * The rule is deliberately narrow: **a segment is blanked only when the tag it
 * came from contains it.** Not "looks like a version" -- that heuristic blanks
 * the `24.04` in `Linux-Ubuntu-24.04`, which is the operating system the build
 * targets and not something that changes with the release, and blanking it
 * makes an Ubuntu 22.04 asset and an Ubuntu 24.04 asset indistinguishable.
 *
 * Using the tag as the authority means the transform works for every shape met
 * so far without knowing any of them:
 *
 *   llama-b10375-bin-ubuntu-vulkan-x64.tar.gz  (b10375)
 *     -> llama-*-bin-ubuntu-vulkan-x64.tar.gz
 *   whisper-v1.8.4-linux-vulkan-x86_64.tar.gz  (v1.8.4)
 *     -> whisper-*-linux-vulkan-x86_64.tar.gz
 *   sd-master-97d2990-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip  (master-827-97d2990)
 *     -> sd-*-*-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip
 *   kokoros-linux-x86_64.tar.gz  (b17)
 *     -> kokoros-linux-x86_64.tar.gz      (its name carries no version at all)
 */
export function assetShape(name: string, tag: string): string {
  const lower = tag.toLowerCase();
  return name
    .split("-")
    .map((segment) => {
      const bare = segment.replace(ARCHIVE_SUFFIX, "");
      /* Two characters minimum, so a stray "b" or "v" in a tag cannot blank
         half an architecture name. */
      if (bare.length < 2 || !lower.includes(bare.toLowerCase())) return segment;
      return segment.replace(bare, "*");
    })
    .join("-");
}

/**
 * The one asset in this release that is the same file as `shape`.
 *
 * Exactly one, or nothing. Ambiguity here would mean guessing between two
 * builds -- a CPU one and a Vulkan one, say -- and the cost of guessing wrong
 * is somebody's chat engine replaced by something that will not start. A
 * release Karen cannot read unambiguously is simply not offered, which loses a
 * feature rather than breaking a machine.
 */
export function matchingAsset(release: Release, shape: string): ReleaseAsset | undefined {
  const hits = release.assets.filter((a) => assetShape(a.name, release.tag) === shape);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The releases that are genuinely newer than the one installed.
 *
 * GitHub returns releases newest-first, so finding the installed tag in the
 * list settles the ordering exactly -- everything before it is newer, and no
 * date arithmetic is involved. That fails only when the installed build is
 * further back than the page fetched, which is the normal case here: b10375 is
 * four hundred builds behind llama.cpp's head. Then the publish date decides.
 *
 * With neither available this returns nothing, deliberately. Offering the
 * newest tag on the page and calling it an update would be a guess, and the
 * failure it produces -- an "update" that is actually a downgrade -- is
 * invisible until somebody wonders why a bug came back.
 */
export function newerThan(
  releases: Release[],
  currentTag: string,
  currentPublishedAt?: string,
): Release[] {
  const at = releases.findIndex((r) => r.tag === currentTag);
  if (at >= 0) return releases.slice(0, at);
  if (!currentPublishedAt) return [];
  return releases.filter((r) => r.publishedAt !== undefined && r.publishedAt > currentPublishedAt);
}

/** What the installed build is, in the terms `/install/dry-run` reports it. */
export interface InstalledBuild {
  recipe: string;
  backend: string;
  repo: string;
  version: string;
  /** The exact file the daemon would download for this version. */
  filename: string;
  publishedAt?: string | undefined;
}

export interface EngineUpdate {
  recipe: string;
  backend: string;
  repo: string;
  /** The build on the disk now. */
  from: string;
  /** The build being offered. */
  to: string;
  asset: string;
  sizeBytes: number;
  releaseUrl?: string | undefined;
  publishedAt?: string | undefined;
}

/**
 * The newest build Karen can name a real file for, or nothing.
 *
 * Walks newest-first and stops at the first release carrying an unambiguous
 * match, rather than taking the newest release and giving up if it has none:
 * source-only tags and dependency drops are interleaved with real builds, and
 * skipping them is the difference between offering v1.8.4 and offering
 * nothing.
 */
export function newestBuild(
  current: InstalledBuild,
  releases: Release[],
): EngineUpdate | undefined {
  const shape = assetShape(current.filename, current.version);
  for (const release of newerThan(releases, current.version, current.publishedAt)) {
    const asset = matchingAsset(release, shape);
    if (!asset) continue;
    return {
      recipe: current.recipe,
      backend: current.backend,
      repo: current.repo,
      from: current.version,
      to: release.tag,
      asset: asset.name,
      sizeBytes: asset.sizeBytes,
      ...(release.url ? { releaseUrl: release.url } : {}),
      ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    };
  }
  return undefined;
}
