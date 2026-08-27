/**
 * Getting llama.cpp's Linux CUDA build, which upstream does not publish as a
 * release asset.
 *
 * The situation, stated plainly because it drove the design. ggml-org's GitHub
 * releases carry 27 assets and every CUDA one is for Windows:
 * `llama-*-bin-win-cuda-12.4-x64.zip` and friends. For Linux there is cpu,
 * vulkan, rocm, sycl and openvino — and no cuda. So a machine with an NVIDIA
 * card was offered Vulkan, which works but leaves real speed on the table,
 * particularly on prompt processing.
 *
 * That is a fact about the release page, not about llama.cpp. Upstream DOES
 * build Linux CUDA — it goes to their container registry instead, as
 * `ghcr.io/ggml-org/llama.cpp:server-cuda`, built by the same CI from the same
 * commit. LM Studio and Ollama solve the same problem by compiling llama.cpp
 * themselves and shipping the result; taking upstream's own build is the same
 * answer with better provenance and nothing to maintain.
 *
 * **No Docker is involved.** A registry is an HTTPS file server with a
 * particular set of URLs: ask for an anonymous token, read the image index,
 * read the manifest for this platform, download the layers you want. Layers are
 * ordinary gzipped tarballs. Nothing here runs a container, and the daemon does
 * not need to exist.
 *
 * Everything in this file is pure so it can be tested without a network: the
 * URL shapes, the platform selection, and — the part that matters — deciding
 * WHICH layers to pull.
 */

/** Upstream's image. The same organisation that publishes the releases. */
export const CUDA_IMAGE = "ggml-org/llama.cpp";

export const REGISTRY = "ghcr.io";

export interface OciPlatform {
  os: string;
  architecture: string;
  variant?: string;
}

export interface OciDescriptor {
  digest: string;
  size: number;
  mediaType?: string;
  platform?: OciPlatform;
}

export interface OciIndex {
  manifests?: OciDescriptor[];
}

export interface OciManifest {
  config: OciDescriptor;
  layers: OciDescriptor[];
}

export interface OciConfig {
  history?: { created_by?: string; empty_layer?: boolean }[];
  rootfs?: { diff_ids?: string[] };
}

/** One layer, with the build step that produced it. */
export interface Layer {
  digest: string;
  size: number;
  /** The Dockerfile line, from the image config's history. */
  createdBy: string;
}

/* --------------------------------------------------------------- urls ---- */

/**
 * ghcr.io hands out anonymous pull tokens; there is no account involved.
 *
 * Public images need no credentials, but they DO need a token — an
 * unauthenticated request gets 401 rather than the manifest.
 */
export function tokenUrl(repo: string): string {
  return `https://${REGISTRY}/token?scope=${encodeURIComponent(`repository:${repo}:pull`)}&service=${REGISTRY}`;
}

export function manifestUrl(repo: string, reference: string): string {
  return `https://${REGISTRY}/v2/${repo}/manifests/${reference}`;
}

export function blobUrl(repo: string, digest: string): string {
  return `https://${REGISTRY}/v2/${repo}/blobs/${digest}`;
}

/** Both index and manifest media types, since a tag may resolve to either. */
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

/**
 * The tag for a given llama.cpp build number.
 *
 * `server-cuda-b10644` pins the exact build; bare `server-cuda` is whatever is
 * newest. Pinning matters because the runtime pane shows a build number and it
 * has to be the one actually installed.
 */
export function cudaTag(build?: string): string {
  return build ? `server-cuda-${build}` : "server-cuda";
}

/* ---------------------------------------------------------- selection ---- */

/** The manifest for one platform, from a multi-platform index. */
export function pickPlatform(index: OciIndex, want: OciPlatform): OciDescriptor | undefined {
  return (index.manifests ?? []).find(
    (m) => m.platform?.os === want.os && m.platform?.architecture === want.architecture,
  );
}

/**
 * Pair each layer with the build step that created it.
 *
 * The pairing is exact rather than approximate, and that is what makes layer
 * selection reliable instead of a guess: history entries marked `empty_layer`
 * (ENV, WORKDIR, ENTRYPOINT — metadata that changes no files) consume no layer,
 * and every other entry consumes exactly one, in order. Verified against the
 * live image: 13 non-empty history entries, 13 layers, 13 diff_ids.
 *
 * If that invariant ever fails to hold, this returns nothing rather than
 * pairing the wrong description with the wrong bytes — a mislabelled layer
 * would mean downloading two gigabytes and extracting nothing.
 */
export function layersWithHistory(manifest: OciManifest, config: OciConfig): Layer[] {
  const real = (config.history ?? []).filter((h) => !h.empty_layer);
  if (real.length !== manifest.layers.length) return [];
  return manifest.layers.map((layer, i) => ({
    digest: layer.digest,
    size: layer.size,
    createdBy: real[i]?.created_by ?? "",
  }));
}

/**
 * The layers holding llama.cpp itself: its libraries and its binaries.
 *
 * Two `COPY`s in upstream's Dockerfile put everything into `/app` —
 * `COPY /app/lib/ /app` (the ggml and llama shared objects, including the
 * 170 MB libggml-cuda.so) and `COPY /app/full/llama /app/full/llama-server /app`
 * (the executables, together about 25 KB, because the server's implementation
 * lives in a library). Together they are ~165 MB, which is the whole download
 * for anyone who already has CUDA on their machine.
 */
export function appLayers(layers: Layer[]): Layer[] {
  return layers.filter((l) => /\bCOPY\b.*\s\/app\b/.test(l.createdBy));
}

/**
 * Where the CUDA runtime libraries live, in the order worth trying.
 *
 * They are NOT all in one layer, which is the mistake that made a real install
 * fail. Upstream's base image installs them in two separate steps:
 *
 *     layer 2   (64 MB)  apt-get install cuda-cudart-12-8    -> libcudart.so.12
 *     layer 5 (2058 MB)  apt-get install ${NV_LIBCUBLAS_PACKAGE}
 *                                        ${NV_LIBNCCL_PACKAGE}
 *                                                            -> libcublas, libnccl
 *
 * A loop that stopped at the first layer yielding *a* library fetched the two
 * gigabytes, found cublas and nccl, and returned satisfied — leaving cudart
 * missing. Reported from a real machine, confirmed by listing both layers.
 *
 * The ordering uses what the image already tells us. Each layer carries the
 * command that built it, and the CUDA ones say so by name, so those are tried
 * first (smallest among them first, since cudart's layer is a thirtieth the
 * size of cublas's). Everything else follows as a fallback, so a change in
 * upstream's packaging costs some wasted bandwidth rather than a failed
 * install. Layers too small to contain a shared library are skipped.
 */
const MIN_LIBRARY_LAYER = 1024 * 1024;
/* No word boundaries: the packages appear as `${NV_LIBCUBLAS_PACKAGE}` and
   `${NV_LIBNCCL_PACKAGE}`, where an underscore is a word character, so `\b`
   would match neither -- which sent the 2 GB cublas layer to the back of the
   queue behind three layers that could not possibly help. */
const NAMES_CUDA = /(cuda|cudart|cublas|nccl|nvidia)/i;

export function libraryLayers(layers: Layer[]): Layer[] {
  const app = new Set(appLayers(layers).map((l) => l.digest));
  const rest = layers.filter((l) => !app.has(l.digest) && l.size >= MIN_LIBRARY_LAYER);
  const bySize = (a: Layer, b: Layer): number => a.size - b.size;
  return [
    ...rest.filter((l) => NAMES_CUDA.test(l.createdBy)).sort(bySize),
    ...rest.filter((l) => !NAMES_CUDA.test(l.createdBy)).sort(bySize),
  ];
}

/**
 * The CUDA libraries `libggml-cuda.so` links against and we may have to supply.
 *
 * Read off the binary itself with `objdump -p`, not from documentation:
 *
 *     libcudart.so.12   the CUDA runtime
 *     libcublas.so.12   dense linear algebra — the big one, ~500 MB
 *     libnccl.so.2      multi-GPU collectives; linked even for one card
 *     libcuda.so.1      NOT here: that one belongs to the NVIDIA DRIVER and is
 *                       already on any machine with a working card. Shipping a
 *                       driver library would be wrong and would break as soon
 *                       as it disagreed with the installed driver.
 */
export const CUDA_LIBS = /^(?:.*\/)?lib(cudart|cublas|cublasLt|nccl)\.so(?:\.\d+)*$/;

/** Whether an extracted path is one of those libraries. */
export function isCudaLib(path: string): boolean {
  return CUDA_LIBS.test(path);
}

/**
 * Does this error mean "a CUDA library is missing" rather than "no card"?
 *
 * The two need different answers -- one is a download, the other is honest bad
 * news -- and the loader says which in its own words.
 */
export function missingCudaLib(message: string): string | undefined {
  const m = /(lib(?:cudart|cublas|cublasLt|nccl|cuda)\.so[.\d]*)/.exec(message);
  return m ? m[1] : undefined;
}
