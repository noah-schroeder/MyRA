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
        backend: "vulkan",
        // Stated plainly rather than left to be discovered as "why is Linux slower".
        reason:
          "NVIDIA card detected. llama.cpp publishes no Linux CUDA build, so this uses Vulkan — " +
          "it works on your card, and is somewhat slower than CUDA would be.",
      };
    }
    return { backend: "vulkan", reason: `${who} GPU with Vulkan support detected.` };
  }

  if (has(VENDOR.nvidia) && platform === "win32") {
    return { backend: "cuda", reason: "NVIDIA card detected, and this system reports no Vulkan support." };
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
 * Written to tolerate a format we do not control and have not been able to
 * exercise against a real GPU here -- this machine has a virtio adapter and no
 * Vulkan, so it reports no devices at all. Every field except the id is
 * therefore optional, and a line that does not parse is skipped rather than
 * throwing: a device list we cannot read must degrade to "no accelerator
 * found", which is safe, not to a crash on startup.
 *
 * The shape being matched:
 *
 *     Available devices:
 *       CUDA0: NVIDIA GeForce RTX 3090 (24576 MiB, 23000 MiB free)
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
export function hasAccelerator(devices: Device[]): boolean {
  return devices.some((d) => !/^cpu/i.test(d.id) && !/^cpu\b/i.test(d.description));
}

/** The largest device memory the probe reported, which is what a model must fit in. */
export function largestDeviceBytes(devices: Device[]): number | undefined {
  let best: number | undefined;
  for (const d of devices) {
    if (/^cpu/i.test(d.id)) continue;
    const value = d.totalBytes;
    if (value !== undefined && (best === undefined || value > best)) best = value;
  }
  return best;
}
