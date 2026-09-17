/**
 * Whether a newer MyRA release exists, asked only when the user presses the button.
 *
 * Mirrors `core/runtime/engineReleases.ts`'s discipline for the app's own releases,
 * at a fraction of the size: MyRA's own tags are plain semver with no per-asset
 * matching to do, so there is one repository, one release, and one comparison.
 * Nothing here runs on a timer, at launch, or after an install -- see
 * `main/appUpdate.ts` for the fetch this feeds.
 */

const REPO = "noah-schroeder/MyRA";

export function latestReleaseUrl(): string {
  return `https://api.github.com/repos/${REPO}/releases/latest`;
}

export interface LatestRelease {
  /** As GitHub has it, e.g. "v0.1.2". */
  tag: string;
  /** The release's page, for someone who wants to read what changed. */
  url?: string | undefined;
}

export function parseLatestRelease(raw: unknown): LatestRelease | undefined {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tag = r["tag_name"];
  if (typeof tag !== "string" || !tag) return undefined;
  const url = r["html_url"];
  return { tag, ...(typeof url === "string" && url ? { url } : {}) };
}

/** "v0.1.2" and "0.1.2" alike -- the tag carries a leading v, package.json does not. */
function parts(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** Numeric, segment by segment, so "0.1.10" is newer than "0.1.9" rather than lexically smaller. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
