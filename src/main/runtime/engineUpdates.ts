/**
 * Asking, when somebody presses the button, whether a newer engine exists.
 *
 * **Only when somebody presses the button.** Karen has no auto-updater and
 * this does not add one: nothing here runs at launch, on a timer, or after an
 * install. A runtime that changed underneath a piece of work could change an
 * answer between one run and the next, and the whole point of pinning versions
 * was that moving one is a decision somebody makes.
 *
 * Two questions, answered from two different places, neither of them guessed:
 *
 *   - **Which repository publishes this engine, and under what filename?**
 *     The daemon, through `/install/dry-run`. Karen keeps no table of its own;
 *     see `installDryRun` for why one would already be wrong.
 *   - **What has that repository released since?** GitHub's releases API, read
 *     once per repository even when several backends share it -- llama.cpp's
 *     CPU and Vulkan builds both come from `ggml-org/llama.cpp`.
 *
 * A backend that is not installed is not checked. There is nothing to update,
 * and the screen already offers it an Install button.
 */

import {
  newestBuild, parseRelease, parseReleases, releasesUrl, releaseTagUrl,
  type EngineUpdate, type InstalledBuild, type Release,
} from "../../core/runtime/engineReleases.ts";
import { pinKey } from "../../core/runtime/enginePins.ts";
import type { MachineInfo } from "../../core/runtime/systemInfo.ts";
import type { LemonadeApi } from "./lemonadeApi.ts";

/** A build already chosen and waiting for the daemon to fetch it. */
export interface PendingUpdate {
  recipe: string;
  backend: string;
  from: string;
  to: string;
  releaseUrl?: string | undefined;
}

export interface UpdateCheck {
  /** Newer builds found on GitHub, one per backend at most. */
  updates: EngineUpdate[];
  /**
   * Updates already pinned but not yet installed.
   *
   * Reachable without anybody pressing anything: a Karen release that bumps
   * LEMONADE_VERSION ships a new version table, and every engine installed
   * under the old one sits here until it is reinstalled. Found in the
   * daemon's own report, so this costs no network at all.
   */
  pending: PendingUpdate[];
  /** How many installed backends were looked at, so "nothing" can say so. */
  checked: number;
  /** Backends whose repository could not be read, named for the message. */
  unreachable: string[];
  /** ISO 8601, for "last checked" on the screen. */
  checkedAt: string;
}

/** Injected so the check is testable without a network. */
export type FetchJson = (url: string) => Promise<unknown>;

const USER_AGENT = "Karen";

export const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: {
      /* GitHub asks for a User-Agent and answers 403 without one. Karen's own
         name and nothing else: a version string here would be the closest
         thing in the app to telemetry, since it would tell GitHub which builds
         are in use. */
      "user-agent": USER_AGENT,
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
};

/**
 * When the installed build was released, so "newer" can be decided.
 *
 * Needed because the installed build is usually far behind the page of
 * releases that gets fetched -- b10375 is four hundred builds back -- so its
 * position in that list cannot settle the ordering. A tag that no longer
 * exists gives nothing, and `newestBuild` then offers nothing rather than
 * risking a downgrade.
 */
async function installedRelease(
  repo: string,
  tag: string,
  get: FetchJson,
): Promise<{ publishedAt?: string | undefined; prerelease?: boolean } | undefined> {
  const release = parseRelease(await get(releaseTagUrl(repo, tag)).catch(() => undefined));
  if (!release) return undefined;
  return {
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    prerelease: release.prerelease,
  };
}

/** Every backend with something on the disk, in a stable order. */
function installedBackends(info: MachineInfo): { recipe: string; backend: string; state: string }[] {
  return info.engines.flatMap((engine) =>
    engine.backends
      .filter((b) => b.state === "installed")
      .map((b) => ({ recipe: engine.id, backend: b.id, state: b.state })));
}

export interface CheckDeps {
  api: Pick<LemonadeApi, "systemInfo" | "installDryRun">;
  get?: FetchJson;
  now?: () => Date;
}

export async function checkEngineUpdates(deps: CheckDeps): Promise<UpdateCheck> {
  const get = deps.get ?? fetchJson;
  const info = await deps.api.systemInfo();

  const pending: PendingUpdate[] = info.engines.flatMap((engine) =>
    engine.backends
      .filter((b) => b.state === "update_required" && b.version && b.pendingVersion)
      .map((b) => ({
        recipe: engine.id,
        backend: b.id,
        from: b.version ?? "",
        to: b.pendingVersion ?? "",
        ...(b.releaseUrl ? { releaseUrl: b.releaseUrl } : {}),
      })));

  const backends = installedBackends(info);
  const updates: EngineUpdate[] = [];
  const unreachable: string[] = [];
  /* One fetch per repository, not per backend: llama.cpp's CPU and Vulkan
     builds are the same repository, and asking GitHub twice for the same page
     is rude in a way that also counts against a rate limit shared with the
     model downloader. */
  const releases = new Map<string, Release[]>();

  for (const { recipe, backend } of backends) {
    const dry = await deps.api.installDryRun(recipe, backend).catch(() => undefined);
    if (!dry?.repo || !dry.version || !dry.filename) {
      unreachable.push(pinKey(recipe, backend));
      continue;
    }
    try {
      let list = releases.get(dry.repo);
      if (!list) {
        list = parseReleases(await get(releasesUrl(dry.repo)));
        releases.set(dry.repo, list);
      }
      /*
       * `dry.version` is the pin, and every backend here is `installed`, which
       * the daemon reports only when the pin and the version.txt on disk
       * agree. So for these it is also the installed build -- and where they
       * disagree the backend is `update_required` and is in `pending` above,
       * not here.
       */
      /* Two things come from this one request: when the installed build was
         released, which is the only way to order it against a page of newer
         ones, and whether it is itself a prerelease -- which decides whether
         prereleases are the stream this engine is on. */
      const installed = await installedRelease(dry.repo, dry.version, get);
      const current: InstalledBuild = {
        recipe, backend, repo: dry.repo, version: dry.version, filename: dry.filename,
        ...(installed?.publishedAt ? { publishedAt: installed.publishedAt } : {}),
        ...(installed?.prerelease !== undefined ? { prerelease: installed.prerelease } : {}),
      };
      const found = newestBuild(current, list);
      if (found) updates.push(found);
    } catch {
      unreachable.push(pinKey(recipe, backend));
    }
  }

  return {
    updates,
    pending,
    checked: backends.length,
    unreachable,
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}
