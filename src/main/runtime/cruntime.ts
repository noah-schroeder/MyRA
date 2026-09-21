/**
 * Giving a binary the C library it was built against.
 *
 * Two different programs now need this and for the same reason: upstream builds
 * on Ubuntu 24.04, and Ubuntu 22.04, Debian 12 and Mint 21 are all still in
 * wide use. A binary needing `GLIBC_2.38` does not fail gracefully on those --
 * it does not load at all, which arrives at the user as "no GPU found" or as a
 * daemon that never starts.
 *
 * The remedy is to carry glibc and libstdc++ from the image the binary was
 * compiled in, and to start the program through THAT loader. The two halves are
 * inseparable: a newer libc under the host's loader dies on
 * `undefined symbol: __nptl_change_stack_perm`. See core/runtime/libc.ts.
 *
 * The one piece of placement that is easy to get wrong, and was got wrong once
 * for ggml and once for lemond: **the loader goes beside the binary, not in the
 * library directory**. Both programs locate things relative to
 * `/proc/self/exe`, which when a bundled loader is used IS the loader -- ggml
 * its backends, lemond its `resources/`. Put the loader one directory down and
 * both look in that directory and find nothing.
 *
 * Only fetched when actually needed. The check is to run the program and read
 * what the loader says, rather than to compare version numbers against the
 * host: the question is not "which Ubuntu is this" but "does this binary run
 * here", and only one of those can be answered without guessing.
 */

import { spawn } from "node:child_process";
import { chmod, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { makePrivateDir } from "../../core/paths.ts";
import {
  cRuntimeEssentials, cRuntimePatterns, isSharedObject, LIBC_DIR, loaderName, missingVersions,
} from "../../core/runtime/libc.ts";
import {
  baseLayers, blobUrl, CUDA_IMAGE, cudaTag, layersWithHistory, manifestUrl, MANIFEST_ACCEPT,
  pickPlatform, tokenUrl, type OciConfig, type OciIndex, type OciManifest,
} from "../../core/runtime/oci.ts";
import { DownloadError, downloadFile, type Progress } from "./download.ts";
import { launchSpec } from "./loader.ts";
import { scrubbedEnv } from "../../core/childEnv.ts";

export interface CRuntimeOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress & { what: string }) => void;
  onPhase?: (what: string) => void;
}

/**
 * Run a program and collect what it said, however it failed.
 *
 * `--version` because it is the cheapest thing every one of these accepts, and
 * because a loader failure happens before the program's own code runs -- so it
 * reports the missing symbol versions just as well as a real command would.
 */
export async function probe(binary: string, args = ["--version"]): Promise<string> {
  const launch = launchSpec(binary, args);
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      /* The engine set, because a working Vulkan or ROCm stack can
         depend on any of it, and a model that stops using the card is a
         worse bug than an inherited variable. launch.env still wins. */
      env: scrubbedEnv(process.env, "engine", launch.env),
    });
    let out = "";
    const take = (b: Buffer): void => { out += b.toString(); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => resolve(out));
    child.on("close", () => resolve(out));
    setTimeout(() => child.kill("SIGKILL"), 20_000).unref?.();
  });
}

/** The symbol versions this machine cannot satisfy, empty when it can. */
export async function tooOldFor(binary: string): Promise<string[]> {
  return missingVersions(await probe(binary));
}

/** Unpack selected paths out of a layer, flattening them into one directory. */
async function extractMatching(archive: string, into: string, patterns: string[]): Promise<string[]> {
  await makePrivateDir(into);
  const before = new Set(await readdir(into).catch(() => []));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", archive, "-C", into, "--wildcards", "--no-anchored",
       "--transform", "s|.*/||", "--no-same-owner", ...patterns],
      { stdio: ["ignore", "ignore", "pipe"], env: scrubbedEnv(process.env) },
    );
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => reject(new DownloadError(`could not run tar: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0 || /Not found in archive/i.test(stderr)) return resolve();
      reject(new DownloadError(`tar failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
  const after = await readdir(into).catch(() => []);
  return after.filter((name) => !before.has(name));
}

/**
 * Where a matching glibc comes from.
 *
 * Upstream's llama.cpp CUDA image, because its base layer is the same Ubuntu
 * 24.04 rootfs these binaries were built on and it is a 30 MB download that
 * carries the loader, glibc and libstdc++ together. Using a container image as
 * a file server is odd but it is the honest source: the exact runtime the
 * binaries expect, fetched by content digest.
 */
async function fetchBaseLayer(into: string, opts: CRuntimeOptions): Promise<string[]> {
  const { signal } = opts;
  const res = await fetch(tokenUrl(CUDA_IMAGE), { ...(signal ? { signal } : {}) });
  if (!res.ok) throw new DownloadError(`could not reach the runtime registry (${res.status})`);
  const bearer = ((await res.json()) as { token?: string }).token;
  if (!bearer) throw new DownloadError("the registry did not issue a pull token");

  const json = async <T>(url: string, accept: string): Promise<T> => {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${bearer}`, accept },
      ...(signal ? { signal } : {}),
    });
    if (!r.ok) throw new DownloadError(`${r.status} ${r.statusText} from the registry`);
    return (await r.json()) as T;
  };

  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const index = await json<OciIndex>(manifestUrl(CUDA_IMAGE, cudaTag()), MANIFEST_ACCEPT);
  const platform = pickPlatform(index, { os: "linux", architecture: arch });
  if (!platform) throw new DownloadError(`no C library is published for linux/${arch}.`);
  const manifest = await json<OciManifest>(manifestUrl(CUDA_IMAGE, platform.digest), MANIFEST_ACCEPT);
  const config = await json<OciConfig>(blobUrl(CUDA_IMAGE, manifest.config.digest), "application/json");

  const layers = layersWithHistory(manifest, config);
  if (!layers.length) throw new DownloadError("the runtime image could not be read.");

  const patterns = cRuntimePatterns(process.arch);
  const found: string[] = [];
  for (const layer of baseLayers(layers)) {
    const archive = join(into, "..", `${layer.digest.replace(/^sha256:/, "").slice(0, 16)}.tar.gz`);
    await downloadFile(blobUrl(CUDA_IMAGE, layer.digest), archive, {
      headers: { authorization: `Bearer ${bearer}` },
      sha256: layer.digest.replace(/^sha256:/, ""),
      ...(signal ? { signal } : {}),
      ...(opts.onProgress
        ? { onProgress: (p) => opts.onProgress!({ ...p, what: "the C library this build needs" }) }
        : {}),
    });
    opts.onPhase?.("unpacking the C library");
    found.push(...(await extractMatching(archive, into, patterns)));
    await rm(archive, { force: true });
    if (cRuntimeEssentials().every((n) => found.includes(n))) break;
  }
  return found;
}

/**
 * Make sure `binary` can run here, bringing a C runtime if it cannot.
 *
 * Returns true when a runtime was installed, false when the machine was already
 * capable. A failure to obtain one is reported rather than thrown: the caller
 * has a working install of something that may well run anyway, and refusing to
 * proceed would be worse than letting it try.
 */
export async function ensureCRuntime(
  binary: string,
  appDir: string,
  opts: CRuntimeOptions = {},
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (!(await tooOldFor(binary)).length) return false;

  opts.onPhase?.("fetching the C library this build was compiled against");
  const libDir = join(appDir, LIBC_DIR);
  const loader = loaderName(process.arch);
  await fetchBaseLayer(libDir, opts);

  for (const name of await readdir(libDir).catch(() => [])) {
    const path = join(libDir, name);
    /* `libstdc++.so.*` also matches the gdb helper script packaged beside it.
       Nothing should ship out of here that is not a shared object. */
    if (!isSharedObject(name)) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    await chmod(path, 0o755).catch(() => undefined);
    // The loader moves up beside the binary; see the header for why.
    if (name === loader) await rename(path, join(appDir, name));
  }

  const ready = Boolean(await stat(join(appDir, loader)).catch(() => undefined));
  if (!ready) {
    await rm(libDir, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  return true;
}
