/**
 * Getting the Lemonade daemon onto the machine.
 *
 * Downloaded on first use rather than shipped inside the installer, which is
 * the same bargain MyRA already makes for llama.cpp: the app stays small, the
 * download is visible and cancellable in the place people already expect to see
 * it, and one build works on every platform without vendoring four binaries.
 *
 * The embeddable build is deliberately the one used rather than the system
 * package. It is 18 MB, carries no telemetry, keeps all of its state in
 * directories MyRA names, and a MyRA uninstall takes it with it -- none of
 * which is true of a snap or a .deb that installs a service.
 */

import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { makePrivateDir } from "../../core/paths.ts";
import {
  embeddableAsset, embeddableSha256, embeddableUrl, LEMONADE_VERSION, lemondName,
} from "../../core/runtime/lemonade.ts";
import { ensureCRuntime, type CRuntimeOptions } from "./cruntime.ts";
import { DownloadError, downloadFile, extractArchive, findExecutable, type Progress } from "./download.ts";

export interface LemonadeInstallOptions {
  /** Where this version should end up. */
  dir: string;
  /** Somewhere to stage the archive; removed afterwards either way. */
  staging: string;
  version?: string;
  signal?: AbortSignal;
  onProgress?: (p: Progress & { what: string }) => void;
  onPhase?: (what: string) => void;
}

export interface LemonadeInstall {
  binary: string;
  version: string;
  /** True when a C runtime had to be brought along for this machine. */
  bundledLibc: boolean;
}

/**
 * Find an already-installed daemon, without downloading anything.
 *
 * Separate from installing so that starting an existing install costs nothing:
 * this runs on every launch, an install runs once.
 */
export async function findLemonade(dir: string): Promise<string | undefined> {
  return findExecutable(dir, lemondName());
}

export async function installLemonade(opts: LemonadeInstallOptions): Promise<LemonadeInstall> {
  const version = opts.version ?? LEMONADE_VERSION;
  const asset = embeddableAsset(process.platform, process.arch, version);
  if (!asset) {
    throw new DownloadError(
      `Lemonade does not publish a build for ${process.platform}/${process.arch}, so MyRA ` +
        `cannot run models on this machine. You can still point MyRA at an endpoint of your own.`,
    );
  }

  await makePrivateDir(opts.staging);
  const archive = join(opts.staging, asset);

  /* Refused rather than installed unverified. This archive becomes a daemon
     MyRA spawns for the life of the app, so "we could not check it" is not a
     reason to run it -- and an unpinned asset means the version was bumped
     without its hashes, which is a mistake in this repo rather than anything
     about the user's machine. */
  const sha = embeddableSha256(asset);
  if (!sha) {
    throw new DownloadError(
      `This build of MyRA has no checksum recorded for ${asset}, so it will not install it.`,
    );
  }

  opts.onPhase?.("downloading Lemonade");
  await downloadFile(embeddableUrl(asset, version), archive, {
    sha256: sha,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: (p) => opts.onProgress!({ ...p, what: "Lemonade" }) } : {}),
  });

  opts.onPhase?.("unpacking Lemonade");
  await rm(opts.dir, { recursive: true, force: true });
  await makePrivateDir(opts.dir);
  await extractArchive(archive, opts.dir);
  await rm(archive, { force: true }).catch(() => undefined);

  const binary = await findLemonade(opts.dir);
  if (!binary) throw new DownloadError("the Lemonade download contained no daemon.");

  /*
   * The C runtime goes beside the daemon, inside whatever directory the archive
   * unpacked it into -- not at the top of `dir`. lemond finds its `resources/`
   * through /proc/self/exe, so the loader has to sit in the same directory as
   * both. See cruntime.ts.
   */
  const runtime: CRuntimeOptions = {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
  };
  const bundledLibc = await ensureCRuntime(binary, dirname(binary), runtime);

  await rm(opts.staging, { recursive: true, force: true }).catch(() => undefined);
  return { binary, version, bundledLibc };
}

/** Older versions left behind by an upgrade, so they can be cleared out. */
export async function staleVersions(root: string, keep: string): Promise<string[]> {
  const names = await readdir(root).catch(() => []);
  return names.filter((n) => n !== keep);
}
