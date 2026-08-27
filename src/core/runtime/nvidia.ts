/**
 * What the NVIDIA driver says about itself, and whether it can run our build.
 *
 * This exists because of a failure that looks like nothing at all: the CUDA
 * build installs, every library resolves, `llama-server --list-devices` exits
 * zero, and it lists no devices. ggml loads its backends with dlopen and treats
 * a backend that fails to initialise exactly like one that is not there, so
 * "your driver is too old for this build" and "you have no graphics card"
 * arrive at the user as the same sentence.
 *
 * The most common cause is a version ceiling, and it is invisible without
 * asking: **a driver supports CUDA runtimes up to a version and no further.**
 * Upstream's image is built against CUDA 12.8, so a driver whose ceiling is
 * 12.4 will load every library successfully and then refuse to initialise. That
 * is a fixable situation — update the driver, or use Vulkan — but only if
 * somebody says which of the two it is.
 *
 * `nvidia-smi` reports the ceiling in its header as "CUDA Version: 12.4", and
 * it is installed with the driver rather than with the toolkit, so it is
 * present exactly when there is a driver to ask about.
 */

/** What the driver reports. Every field optional: nvidia-smi may not be there. */
export interface NvidiaInfo {
  /* `?: T | undefined` throughout, because these are assigned from regex
     captures that the compiler cannot prove are present. */
  /** Driver package version, e.g. `550.144.03`. */
  driverVersion?: string | undefined;
  /** The highest CUDA runtime this driver can run, e.g. `12.4`. */
  cudaCeiling?: string | undefined;
  /** Card names, in the order nvidia-smi lists them. */
  names: string[];
}

/**
 * Parse `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`
 * plus the CUDA version from the plain `nvidia-smi` header.
 *
 * Both are parsed from whatever text is given, because the two calls are
 * cheaper to make together than to coordinate.
 */
export function parseNvidiaSmi(text: string): NvidiaInfo {
  const info: NvidiaInfo = { names: [] };

  // The header line: "| NVIDIA-SMI 550.144.03   Driver Version: 550.144.03   CUDA Version: 12.4 |"
  const ceiling = /CUDA Version:\s*(\d+\.\d+)/i.exec(text);
  if (ceiling) info.cudaCeiling = ceiling[1];
  const driver = /Driver Version:\s*([\d.]+)/i.exec(text);
  if (driver) info.driverVersion = driver[1];

  for (const line of text.split(/\r?\n/)) {
    // The csv rows: "NVIDIA GeForce RTX 4060, 550.144.03"
    const row = /^([^|,]*NVIDIA[^,|]*|[^,|]*GeForce[^,|]*|[^,|]*Quadro[^,|]*|[^,|]*Tesla[^,|]*),\s*([\d.]+)\s*$/.exec(
      line.trim(),
    );
    if (row) {
      info.names.push(row[1]!.trim());
      info.driverVersion ??= row[2];
    }
  }
  return info;
}

/** Compare two dotted versions. Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The CUDA version upstream's image is built against.
 *
 * Read from the image's own build steps, which name the packages
 * (`cuda-cudart-12-8`), rather than hardcoded — this is the fallback for when
 * that cannot be read.
 */
export const IMAGE_CUDA_DEFAULT = "12.8";

/** `cuda-cudart-12-8` -> `12.8`, from the layer that installed it. */
export function cudaVersionOf(createdBy: string): string | undefined {
  const m = /cuda-cudart-(\d+)-(\d+)/.exec(createdBy);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * Why a CUDA build found no device, when the driver can say.
 *
 * Returns undefined when nothing is provably wrong -- an absent answer is not
 * a diagnosis, and inventing one would be worse than the silence it replaces.
 */
export function explainNoCudaDevice(
  info: NvidiaInfo,
  imageCuda = IMAGE_CUDA_DEFAULT,
): string | undefined {
  if (!info.names.length && !info.driverVersion) {
    return (
      "No NVIDIA driver was found by nvidia-smi, so nothing can run CUDA on this machine. " +
      "Install the driver from your distribution, or use the Vulkan build."
    );
  }
  if (info.cudaCeiling && compareVersions(info.cudaCeiling, imageCuda) < 0) {
    return (
      `Your NVIDIA driver${info.driverVersion ? ` (${info.driverVersion})` : ""} supports CUDA up ` +
      `to ${info.cudaCeiling}, and this build needs ${imageCuda}. Every library loaded, which is ` +
      `why it started, but the driver then refused to initialise it. Update the driver, or use ` +
      `the Vulkan build, which has no such ceiling.`
    );
  }
  if (info.names.length) {
    return (
      `nvidia-smi can see ${info.names.join(" and ")}, so the card and driver are working — but ` +
      `llama.cpp's CUDA backend did not initialise. The probe output below is what it said.`
    );
  }
  return undefined;
}
