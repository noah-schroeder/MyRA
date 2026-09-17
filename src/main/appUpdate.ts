/**
 * Asking GitHub, once, whether a newer MyRA release exists.
 *
 * **Only when somebody presses the button.** Nothing here runs at launch or
 * on a timer -- see the "no update check that you did not press" line in
 * Settings → About, which this is the button behind.
 */

import { isNewer, latestReleaseUrl, parseLatestRelease } from "../core/updates.ts";

export interface UpdateCheckResult {
  ok: boolean;
  current: string;
  latest?: string;
  url?: string;
  newer: boolean;
  error?: string;
}

/** Injected so the check is testable without a network. */
export type FetchJson = (url: string) => Promise<unknown>;

export const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: {
      /* GitHub asks for a User-Agent and answers 403 without one. MyRA's own
         name and nothing else, the same restraint the engine-update check
         already keeps. */
      "user-agent": "MyRA",
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
};

export async function checkForUpdate(current: string, get: FetchJson = fetchJson): Promise<UpdateCheckResult> {
  try {
    const release = parseLatestRelease(await get(latestReleaseUrl()));
    if (!release) throw new Error("GitHub's response did not include a release");
    return {
      ok: true,
      current,
      latest: release.tag,
      newer: isNewer(release.tag, current),
      ...(release.url ? { url: release.url } : {}),
    };
  } catch (err) {
    return { ok: false, current, newer: false, error: (err as Error).message };
  }
}
