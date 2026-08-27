/**
 * Installing llama.cpp's Linux CUDA build from upstream's container registry.
 *
 * See core/runtime/oci.ts for why this exists at all. In short: ggml-org builds
 * Linux CUDA and publishes it to ghcr.io rather than to the releases page, so
 * this is the same binary the release assets would have carried, obtained from
 * the other place upstream puts it. No Docker, no daemon — a registry is an
 * HTTPS file server and layers are gzipped tarballs.
 *
 * The download is staged in two parts on purpose:
 *
 *   1. **llama.cpp itself** — ~165 MB, always.
 *   2. **The CUDA runtime libraries** — ~2 GB, only if the machine turns out
 *      not to have them.
 *
 * Anyone who already runs CUDA work on that machine has cudart and cublas
 * somewhere the loader can find them, and pays only the 165 MB. Someone with a
 * bare driver pays for the rest, once. Deciding by asking the loader is the
 * only honest way to know -- a version check against `nvidia-smi` would guess.
 */

import { spawn } from "node:child_process";
import { chmod, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { makePrivateDir } from "../../core/paths.ts";
import {
  appLayers, blobUrl, cudaTag, CUDA_IMAGE, isCudaLib, layersWithHistory, libraryLayers,
  manifestUrl, MANIFEST_ACCEPT, pickPlatform, tokenUrl,
  type Layer, type OciConfig, type OciIndex, type OciManifest,
} from "../../core/runtime/oci.ts";
import { DownloadError, downloadFile, type Progress } from "./download.ts";

export interface CudaInstallOptions {
  /** Where the build should end up. */
  dir: string;
  /** Somewhere to stage layers; removed afterwards either way. */
  staging: string;
  signal?: AbortSignal;
  onProgress?: (p: Progress & { what: string }) => void;
  onPhase?: (what: string) => void;
}

export interface CudaInstallResult {
  binary: string;
  /** The llama.cpp build the image was made from, e.g. `b10644`. */
  build: string;
  /** True when the CUDA runtime libraries had to be fetched as well. */
  bundledLibraries: boolean;
}

/** A pull token. Public images still need one; without it ghcr answers 401. */
async function token(signal?: AbortSignal): Promise<string> {
  const res = await fetch(tokenUrl(CUDA_IMAGE), { ...(signal ? { signal } : {}) });
  if (!res.ok) throw new DownloadError(`could not reach ${CUDA_IMAGE} (${res.status})`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new DownloadError("the registry did not issue a pull token");
  return body.token;
}

async function json<T>(url: string, bearer: string, accept: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}`, accept },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new DownloadError(`${res.status} ${res.statusText} from the registry`);
  return (await res.json()) as T;
}

/**
 * Unpack selected paths out of a layer.
 *
 * `--wildcards` with a pattern rather than extracting everything: the CUDA base
 * layer is a whole Ubuntu filesystem and we want four shared objects from it.
 * Extracting the lot would cost gigabytes of disk to then delete.
 *
 * `--strip-components` is deliberately NOT used -- the paths inside these
 * layers differ (`app/…` versus `usr/local/cuda/lib64/…`) and flattening them
 * here is what makes both land in one directory beside the binary.
 */
async function extractMatching(archive: string, into: string, patterns: string[]): Promise<string[]> {
  await makePrivateDir(into);
  const before = new Set(await readdir(into).catch(() => []));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", archive, "-C", into, "--wildcards", "--no-anchored",
       "--transform", "s|.*/||", "--no-same-owner", ...patterns],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => reject(new DownloadError(`could not run tar: ${err.message}`)));
    /*
     * Exit 2 with "Not found in archive" is not a failure here: layers are
     * searched in turn for the libraries and most of them will not have any.
     * Any other non-zero is real.
     */
    child.on("close", (code) => {
      if (code === 0 || /Not found in archive/i.test(stderr)) return resolve();
      reject(new DownloadError(`tar failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
  const after = await readdir(into).catch(() => []);
  return after.filter((name) => !before.has(name));
}

/**
 * Which libraries the CUDA backend cannot find.
 *
 * `ldd`, not "run it and see". This was written the other way first and the
 * other way is wrong: `llama-server --list-devices` with no CUDA runtime
 * present prints "Available devices: (none)" and exits ZERO. ggml loads its
 * backends with dlopen and treats a backend that will not load as a backend
 * that is not there, so a missing libcublas is indistinguishable from an empty
 * PCI bus -- measured here, on a machine with neither.
 *
 * That failure mode is the dangerous one: Karen would have concluded "no GPU",
 * fallen back to the processor build, and told someone with a 4090 that their
 * card could not be used. Asking the linker directly gives a real answer.
 */
export async function missingLibraries(soPath: string, dir: string): Promise<string[]> {
  const output = await new Promise<string>((resolve) => {
    const child = spawn("ldd", [soPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [dir, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
      },
    });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (out += b.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
  const missing: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\S+)\s*=>\s*not found/.exec(line);
    if (m?.[1]) missing.push(m[1]);
  }
  return missing;
}

/**
 * The driver's own library, which Karen must never supply.
 *
 * libcuda.so.1 ships with the NVIDIA kernel driver and is version-locked to it.
 * A copy taken from a container image would be the wrong version on most
 * machines and would fail in ways far more confusing than its absence. If this
 * is missing the honest answer is "install the NVIDIA driver, or use Vulkan".
 */
export const DRIVER_LIB = "libcuda.so.1";

export async function installLinuxCuda(opts: CudaInstallOptions): Promise<CudaInstallResult> {
  const { dir, staging, signal } = opts;
  const bearer = await token(signal);

  opts.onPhase?.("reading the image index");
  const index = await json<OciIndex>(
    manifestUrl(CUDA_IMAGE, cudaTag()), bearer, MANIFEST_ACCEPT, signal,
  );
  const platform = pickPlatform(index, { os: "linux", architecture: archName() });
  if (!platform) {
    throw new DownloadError(
      `upstream publishes no CUDA image for linux/${archName()}. Use the Vulkan build instead.`,
    );
  }

  const manifest = await json<OciManifest>(
    manifestUrl(CUDA_IMAGE, platform.digest), bearer, MANIFEST_ACCEPT, signal,
  );
  const config = await json<OciConfig>(
    blobUrl(CUDA_IMAGE, manifest.config.digest), bearer, "application/json", signal,
  );

  const layers = layersWithHistory(manifest, config);
  if (!layers.length) {
    throw new DownloadError(
      "the CUDA image's layers could not be matched to its build steps, so Karen will not " +
        "guess which ones to download.",
    );
  }
  const wanted = appLayers(layers);
  if (!wanted.length) throw new DownloadError("the CUDA image contains no llama.cpp layer.");

  await makePrivateDir(staging);
  const unpacked = join(staging, "app");

  const pull = async (layer: Layer, what: string): Promise<string> => {
    const path = join(staging, `${layer.digest.replace(/^sha256:/, "").slice(0, 16)}.tar.gz`);
    await downloadFile(blobUrl(CUDA_IMAGE, layer.digest), path, {
      headers: { authorization: `Bearer ${bearer}` },
      // The digest IS the sha256 of the compressed layer, so this is verified
      // by the same mechanism as a release asset -- and by the registry's own
      // content addressing, which is what a digest means.
      sha256: layer.digest.replace(/^sha256:/, ""),
      ...(signal ? { signal } : {}),
      ...(opts.onProgress ? { onProgress: (p) => opts.onProgress!({ ...p, what }) } : {}),
    });
    return path;
  };

  for (const layer of wanted) {
    const archive = await pull(layer, "llama.cpp CUDA build");
    opts.onPhase?.("unpacking");
    await extractMatching(archive, unpacked, ["app/*"]);
    await rm(archive, { force: true });
  }

  const binary = join(unpacked, "llama-server");
  if (!(await stat(binary).catch(() => undefined))) {
    throw new DownloadError("the CUDA image contained no llama-server binary.");
  }
  await chmod(binary, 0o755);
  for (const name of await readdir(unpacked)) {
    if (/\.so(\.|$)/.test(name)) await chmod(join(unpacked, name), 0o755).catch(() => undefined);
  }

  /*
   * Does this machine already have the CUDA runtime?
   *
   * Asked of the linker rather than of `nvidia-smi`: the question is not which
   * toolkit is installed but whether THIS library can resolve its imports.
   */
  opts.onPhase?.("checking this machine's CUDA libraries");
  const backend = join(unpacked, "libggml-cuda.so");
  let bundledLibraries = false;
  let missing = await missingLibraries(backend, unpacked);

  if (missing.includes(DRIVER_LIB)) {
    throw new DownloadError(
      `this machine has no NVIDIA driver installed (${DRIVER_LIB} is missing), so the CUDA ` +
        `build cannot run. Install the driver, or choose the Vulkan build, which works on ` +
        `NVIDIA cards too.`,
    );
  }

  if (missing.length) {
    bundledLibraries = true;
    opts.onPhase?.(`this machine has no CUDA runtime, so Karen will bring one (${missing.join(", ")})`);
    missing = await fetchCudaLibraries(layers, pull, backend, unpacked, opts);
    if (missing.length) {
      throw new DownloadError(
        `the CUDA build still cannot find ${missing.join(", ")} after searching every layer of ` +
          `the image. This is a bug in Karen rather than a problem with your machine.`,
      );
    }
  }

  await rm(dir, { recursive: true, force: true });
  await makePrivateDir(join(dir, ".."));
  await rename(unpacked, dir);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);

  return {
    binary: join(dir, "llama-server"),
    build: buildOf(config) ?? "server-cuda",
    bundledLibraries,
  };
}

/**
 * Pull layers until nothing is missing.
 *
 * The subtlety that broke this the first time: the libraries are NOT all in one
 * layer. `libcudart.so.12` is installed by an early 64 MB step and
 * `libcublas.so.12` by the 2 GB one, so a loop that stopped at the first layer
 * yielding anything fetched two gigabytes, found cublas and nccl, and returned
 * satisfied -- leaving cudart missing and the install failing with "still
 * cannot find libcudart.so.12 after downloading the runtime". Reported from a
 * real machine; confirmed by listing both layers.
 *
 * So the stopping condition is the question we actually care about -- does
 * anything still fail to resolve -- asked again after every layer, rather than
 * "did this layer contain a file with a promising name".
 *
 * Smallest first, skipping layers too small to hold a shared library, so the
 * cheap wins come before the expensive one and a machine missing only cudart
 * pays 64 MB instead of two gigabytes.
 */
async function fetchCudaLibraries(
  layers: Layer[],
  pull: (layer: Layer, what: string) => Promise<string>,
  backend: string,
  into: string,
  opts: CudaInstallOptions,
): Promise<string[]> {
  const patterns = ["*libcudart.so*", "*libcublas.so*", "*libcublasLt.so*", "*libnccl.so*"];
  let missing = await missingLibraries(backend, into);

  for (const layer of libraryLayers(layers)) {
    if (!missing.length) break;
    const archive = await pull(layer, `NVIDIA CUDA runtime (${missing.join(", ")})`);
    opts.onPhase?.("unpacking the CUDA runtime");
    const found = await extractMatching(archive, into, patterns);
    await rm(archive, { force: true });
    for (const name of found.filter(isCudaLib)) {
      await chmod(join(into, name), 0o755).catch(() => undefined);
    }
    missing = await missingLibraries(backend, into);
  }
  return missing;
}

/** The llama.cpp build number the image was made from, from its OCI labels. */
function buildOf(config: OciConfig & { config?: { Labels?: Record<string, string> } }): string | undefined {
  const version = config.config?.Labels?.["org.opencontainers.image.version"];
  return version && /^b\d+$/.test(version) ? version : undefined;
}

function archName(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}
