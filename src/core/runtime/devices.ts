/**
 * What the machine can actually do, as opposed to what it appears to have.
 *
 * Two different questions, deliberately kept apart:
 *
 *   - **Detection** (`suggestBackend`) reads Electron's GPU info and proposes a
 *     build. It is a guess. A vendor id proves a card is present; it does not
 *     prove a working driver is installed, and Vulkan on Linux needs
 *     `libvulkan1` plus mesa drivers that may simply be absent.
 *   - **The probe** (`parseDevices`) reads `llama-server --list-devices` after
 *     the build is on disk. That is ground truth, and it is also the only thing
 *     that knows how much VRAM there is -- Electron reports the vendor and the
 *     device id, never the memory.
 *
 * So the flow is detect, download, probe, and fall back to CPU if the probe
 * finds nothing. The guess only has to be good enough to avoid downloading the
 * wrong 30 MB archive; it is never trusted on its own.
 */

import type { Backend } from "./assets.ts";

/** PCI vendor ids, as Chromium reports them: decimal, not hex. */
export const VENDOR = {
  nvidia: 0x10de, // 4318
  amd: 0x1002, // 4098
  intel: 0x8086, // 32902
  apple: 0x106b, // 4203
  virtio: 0x1af4, // 6900 -- a virtual GPU, i.e. no acceleration to find
} as const;

export interface GpuInfo {
  vendorIds: number[];
  supportsVulkan: boolean;
}

export function vendorName(id: number): string {
  for (const [name, value] of Object.entries(VENDOR)) if (value === id) return name;
  return `0x${id.toString(16)}`;
}

export interface Suggestion {
  backend: Backend;
  /** Shown to the user, so it says why rather than just what. */
  reason: string;
}

/**
 * The build to try first.
 *
 * Vulkan is preferred over vendor-specific backends wherever it is available:
 * one ~33 MB artifact covers NVIDIA, AMD and Intel, against 640 MB for CUDA on
 * Windows. CUDA is worth offering afterwards as an upgrade, never as the first
 * thing a user has to download before they can say hello to a model.
 */
export function suggestBackend(platform: NodeJS.Platform, arch: string, gpu: GpuInfo): Suggestion {
  if (platform === "darwin") {
    return { backend: "metal", reason: "macOS builds include Metal, so there is nothing to choose." };
  }

  const has = (id: number): boolean => gpu.vendorIds.includes(id);
  const onlyVirtual = gpu.vendorIds.length > 0 && gpu.vendorIds.every((id) => id === VENDOR.virtio);

  if (onlyVirtual) {
    return { backend: "cpu", reason: "This machine has a virtual GPU, which cannot accelerate a model." };
  }

  if (gpu.supportsVulkan) {
    const who = has(VENDOR.nvidia) ? "NVIDIA" : has(VENDOR.amd) ? "AMD" : has(VENDOR.intel) ? "Intel" : "your";
    if (platform === "linux" && has(VENDOR.nvidia)) {
      return {
        backend: "cuda",
        reason:
          "NVIDIA card detected. Karen will fetch llama.cpp's CUDA build from upstream's " +
          "container registry, which is where they publish it for Linux.",
      };
    }
    return { backend: "vulkan", reason: `${who} GPU with Vulkan support detected.` };
  }

  if (has(VENDOR.nvidia) && platform === "win32") {
    return { backend: "cuda", reason: "NVIDIA card detected, and this system reports no Vulkan support." };
  }

  /*
   * A real card that Chromium says has no Vulkan is still worth one attempt.
   *
   * `hardwareSupportsVulkan` is Chromium's answer about Chromium's own
   * rendering path, and it reports false in situations where llama.cpp's Vulkan
   * backend works perfectly well -- a headless or EGL session, a machine where
   * the browser fell back to SwiftShader, the NVIDIA proprietary driver under
   * some X11 configurations. Believing it cost the user CPU-only inference on a
   * workstation with a 4090 in it, silently.
   *
   * The download is 33 MB and `setUp` already probes the installed build with
   * `--list-devices` and reinstalls the CPU build when nothing accelerated
   * turns up. So the wrong guess costs one small download; the right guess is
   * the difference between a usable machine and an unusable one.
   *
   * Not extended to virtual GPUs: those are handled above, and a virtio device
   * genuinely has nothing to offer.
   */
  if (has(VENDOR.nvidia) || has(VENDOR.amd) || has(VENDOR.intel)) {
    const who = has(VENDOR.nvidia) ? "NVIDIA" : has(VENDOR.amd) ? "AMD" : "Intel";
    return {
      backend: "vulkan",
      reason:
        `${who} card detected. This system reports no Vulkan support, which is often wrong ` +
        `about what llama.cpp can use, so Karen will try the Vulkan build and fall back to the ` +
        `processor build if it finds no GPU.`,
    };
  }

  return {
    backend: "cpu",
    reason:
      gpu.vendorIds.length === 0
        ? "No GPU was detected, so this uses the processor."
        : "No usable GPU acceleration was detected, so this uses the processor.",
  };
}

export interface Device {
  /** As llama.cpp names it: `CUDA0`, `Vulkan0`, `Metal`. */
  id: string;
  description: string;
  /** Total memory in bytes, when reported. */
  totalBytes?: number;
  /** Free memory in bytes, when reported. */
  freeBytes?: number;
}

const MIB = 1024 * 1024;

/**
 * Parse `llama-server --list-devices`.
 *
 * The format is not guessed. It is one printf in upstream's
 * `common_print_available_devices`, read at tag b10628:
 *
 *     printf("  %s: %s (%zu MiB, %zu MiB free)\n", name, description, total/MiB, free/MiB);
 *
 * so a device line looks like:
 *
 *     Available devices:
 *       CUDA0: NVIDIA GeForce RTX 3090 (24576 MiB, 23000 MiB free)
 *
 * Two things follow from that source, and both matter here:
 *
 *   - **CPU devices are filtered out before printing**, so anything listed is
 *     by definition an accelerator, and an empty list is upstream's own way of
 *     saying there is none. It prints a literal `  (none)` in that case --
 *     confirmed by running the CPU build on this machine.
 *   - **Memory is always printed** for a real device, so a device with no
 *     memory figure means the format moved.
 *
 * Kept tolerant regardless: every field except the id is optional and an
 * unparsable line is skipped rather than thrown on, because a device list we
 * cannot read must degrade to "no accelerator found" -- which is safe, since
 * the CPU build always works -- and never to a crash on startup.
 */
export function parseDevices(stdout: string): Device[] {
  const devices: Device[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available devices/i.test(line)) continue;

    /*
     * Strict on purpose. llama.cpp writes its own diagnostics to the same
     * stream in the same `prefix: text` shape -- `ggml_vulkan: no devices
     * found`, `load_backend: loaded RPC backend` -- and a loose pattern reads
     * those as devices, which turns "no GPU found" into "a GPU called
     * ggml_vulkan". Real device ids are short and alphanumeric (CUDA0, Vulkan0,
     * Metal, CPU); the log prefixes all carry underscores.
     */
    const m = /^([A-Za-z][A-Za-z0-9]{0,15})\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1]!;
    let rest = m[2]!.trim();
    if (!rest) continue;

    // Memory, when present, is a parenthesised tail. Both figures are optional
    // and the units have varied between releases.
    let totalBytes: number | undefined;
    let freeBytes: number | undefined;
    const mem = /\(([^)]*)\)\s*$/.exec(rest);
    if (mem) {
      const inside = mem[1]!;
      const numbers = [...inside.matchAll(/([\d.]+)\s*(MiB|GiB|MB|GB)(\s+free)?/gi)];
      for (const n of numbers) {
        const value = Number(n[1]);
        if (!Number.isFinite(value)) continue;
        const unit = n[2]!.toLowerCase();
        const bytes = Math.round(value * (unit.startsWith("g") ? 1024 * MIB : MIB));
        if (n[3]) freeBytes = bytes;
        else if (totalBytes === undefined) totalBytes = bytes;
        else freeBytes ??= bytes;
      }
      if (numbers.length) rest = rest.slice(0, mem.index).trim();
    }

    devices.push({
      id,
      description: rest,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(freeBytes !== undefined ? { freeBytes } : {}),
    });
  }
  return devices;
}

/** Does the probe show anything that is not the CPU? */
/**
 * Renderers that are not hardware at all.
 *
 * Mesa's software Vulkan (`llvmpipe`, `lavapipe`) and Chromium's SwiftShader
 * enumerate as perfectly ordinary Vulkan devices and report a great deal of
 * "memory", because their memory is system RAM. Treating one as a GPU means
 * loading a model onto a CPU renderer, which is slower than the CPU backend
 * and looks like acceleration while it happens.
 */
const SOFTWARE = /\b(llvmpipe|lavapipe|softpipe|swiftshader|virgl)\b/i;

export function isSoftwareRenderer(description: string): boolean {
  return SOFTWARE.test(description);
}

export function hasAccelerator(devices: Device[]): boolean {
  return devices.some(
    (d) => !/^cpu/i.test(d.id) && !/^cpu\b/i.test(d.description) && !isSoftwareRenderer(d.description),
  );
}

export interface VramChoice {
  device: Device;
  bytes: number;
  /**
   * True when this memory is the machine's RAM seen through a GPU, rather than
   * memory on a card.
   */
  shared: boolean;
}

/**
 * A device reporting more than this share of system RAM is not reporting VRAM.
 *
 * No card has half the machine's memory soldered to it; an integrated GPU, on
 * the other hand, reports a slice of system RAM as its own, and drivers
 * commonly offer around three quarters of it.
 */
const SHARED_RAM_SHARE = 0.5;

/**
 * Which device's memory a model has to fit in.
 *
 * This used to be "the largest number any device reported", and that is wrong
 * on the most ordinary desktop there is. A machine with an RTX 4060 and an
 * integrated GPU enumerates BOTH under Vulkan: the card says 8 GB, the
 * integrated one says a share of system RAM -- about 47 GB on a 64 GB machine.
 * Taking the maximum picked the integrated one, so Karen reported "46.9 GB
 * VRAM" on a machine with 8 GB of it, and would happily recommend a 30B model
 * that cannot possibly fit.
 *
 * Preference order: a real card, largest first; then, only if there is nothing
 * else, a shared-memory device, marked as such so the UI can say so rather than
 * quietly present it as VRAM.
 */
export function pickVram(devices: Device[], ramBytes?: number): VramChoice | undefined {
  const candidates = devices.filter(
    (d) => !/^cpu/i.test(d.id) && !isSoftwareRenderer(d.description) && d.totalBytes !== undefined,
  );
  const shares = (d: Device): boolean =>
    ramBytes !== undefined && ramBytes > 0 && (d.totalBytes ?? 0) > ramBytes * SHARED_RAM_SHARE;

  const dedicated = candidates.filter((d) => !shares(d));
  const pool = dedicated.length ? dedicated : candidates;
  let best: Device | undefined;
  for (const d of pool) if (!best || (d.totalBytes ?? 0) > (best.totalBytes ?? 0)) best = d;
  if (!best) return undefined;
  return { device: best, bytes: best.totalBytes!, shared: !dedicated.length && shares(best) };
}

/** The memory a model must fit in. See `pickVram` for why this is not a max. */
export function largestDeviceBytes(devices: Device[], ramBytes?: number): number | undefined {
  return pickVram(devices, ramBytes)?.bytes;
}
