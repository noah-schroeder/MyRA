/**
 * Installing pandoc on first run.
 *
 * Karen writes Word, OpenDocument and HTML by driving pandoc, and there is no
 * sensible way to require a non-technical user to install it themselves: on
 * Linux that is a package manager, on macOS a `.pkg` that wants an
 * administrator, on Windows an `.msi`. So the app fetches the plain archive
 * that needs none of those and keeps the binary with the user's own data,
 * beside the model runtime it already downloads for the same reasons.
 *
 * Nothing here is reachable by the model. Installing a binary is not a tool
 * call; it happens once, from the setup screen, on a gesture from the user.
 */

import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installedPandocPath, pandocBinaryName, forgetEngines } from "../../core/documents/office.ts";
import { makeOwnDir, toolsDir } from "../../core/paths.ts";
import { digestOf, pandocAsset } from "../../core/documents/pandocRelease.ts";
import type { Release } from "../../core/runtime/assets.ts";
import { DownloadError, downloadFile, extractArchive, findExecutable, type Progress } from "../runtime/download.ts";

/**
 * `releases/latest` is correct here.
 *
 * The llama.cpp picker cannot use it, because every llama.cpp build is a
 * prerelease and "latest" filters exactly those out. pandoc publishes ordinary
 * releases, so this is the endpoint that means what it says.
 */
const LATEST = "https://api.github.com/repos/jgm/pandoc/releases/latest";

export interface InstallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress & { what: string }) => void;
}

export interface InstallResult {
  path: string;
  version: string;
}

export async function installPandoc(opts: InstallOptions = {}): Promise<InstallResult> {
  const res = await fetch(LATEST, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Karen" },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    throw new DownloadError(`could not reach GitHub to find pandoc (${res.status})`);
  }
  const release = (await res.json()) as Release;
  const asset = pandocAsset(release.assets ?? [], {
    platform: process.platform,
    arch: process.arch,
  });
  if (!asset) {
    throw new DownloadError(
      `pandoc publishes no build for ${process.platform}/${process.arch}. ` +
        `Install it yourself and Karen will use the one on your PATH.`,
    );
  }

  /*
   * `mkdtemp`, not `karen-pandoc-<pid>`.
   *
   * The predictable name was a real hazard rather than an untidiness: another
   * account on the machine can create that directory first and wait. The
   * archive is checksummed, but `findExecutable` then searches the whole
   * directory for anything named `pandoc` and the app COPIES WHAT IT FINDS into
   * the tools directory and runs it from then on. A planted binary would be
   * installed by Karen and executed as the user, for as long as it sat there.
   *
   * mkdtemp makes the name unguessable and the directory 0700.
   */
  const work = await mkdtemp(join(tmpdir(), "karen-pandoc-"));
  const archive = join(work, asset.name);
  try {
    const sha = digestOf(asset);
    await downloadFile(asset.browser_download_url, archive, {
      ...(sha ? { sha256: sha } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress
        ? { onProgress: (p: Progress) => opts.onProgress!({ ...p, what: `pandoc ${release.tag_name}` }) }
        : {}),
    });

    await extractArchive(archive, work);
    // Layout varies by platform -- `pandoc-3.10.2/bin/pandoc` on Linux,
    // `pandoc-3.10.2/pandoc.exe` on Windows -- so it is found rather than
    // assumed.
    const found = await findExecutable(work, "pandoc");
    if (!found) throw new DownloadError("the pandoc archive did not contain a pandoc binary");

    await makeOwnDir(toolsDir());
    const dest = installedPandocPath();
    /* Copied, not renamed: the temporary directory is often on a different
       filesystem from the config directory, where rename fails with EXDEV. */
    await copyFile(found, dest);
    if (process.platform !== "win32") await chmod(dest, 0o755);

    // The probe is cached for the life of the process, and it was taken before
    // this ran. Without this the app goes on reporting pandoc missing until
    // it is restarted -- on the very screen that just installed it.
    forgetEngines();
    return { path: dest, version: release.tag_name };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The binary's name, for a UI that wants to say what it is about to fetch. */
export { pandocBinaryName };
