/**
 * Detection proposes; the probe decides.
 *
 * The GPU info in these cases is the shape Electron really returns -- including
 * the one measured on the machine this was written on, whose virtio adapter is
 * exactly the case a vendor-id lookup gets wrong if it is not thought about.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAccelerator, largestDeviceBytes, parseDevices, pickVram, suggestBackend, VENDOR,
  vendorName, type Device,
} from "../src/core/runtime/devices.ts";

test("Apple hardware is not asked a question it cannot answer", () => {
  const s = suggestBackend("darwin", "arm64", { vendorIds: [VENDOR.apple], supportsVulkan: false });
  assert.equal(s.backend, "metal");
});

test("a virtual GPU is not mistaken for an accelerator", () => {
  // Measured on this machine: vendorId 6900 (0x1AF4, virtio), Vulkan false.
  // A naive "is there a gpuDevice entry" check would download a Vulkan build
  // that finds nothing.
  const s = suggestBackend("linux", "x64", { vendorIds: [VENDOR.virtio], supportsVulkan: false });
  assert.equal(s.backend, "cpu");
  assert.match(s.reason, /virtual GPU/);
});

test("Vulkan is preferred wherever it is available", () => {
  for (const vendor of [VENDOR.nvidia, VENDOR.amd, VENDOR.intel]) {
    const s = suggestBackend("win32", "x64", { vendorIds: [vendor], supportsVulkan: true });
    assert.equal(s.backend, "vulkan", `${vendorName(vendor)} should take the 33MB build, not the 640MB one`);
  }
});

test("an NVIDIA card on Linux is offered CUDA, not Vulkan", () => {
  /*
   * This test used to assert the opposite, on the grounds that llama.cpp
   * publishes no Linux CUDA release asset -- which is true and was the wrong
   * conclusion. Upstream builds it into their container image instead, so the
   * card gets what it is for. See core/runtime/oci.ts.
   */
  const s = suggestBackend("linux", "x64", { vendorIds: [VENDOR.nvidia], supportsVulkan: true });
  assert.equal(s.backend, "cuda");
  assert.match(s.reason, /NVIDIA/);
});

test("Windows falls back to CUDA only when Vulkan is genuinely absent", () => {
  const s = suggestBackend("win32", "x64", { vendorIds: [VENDOR.nvidia], supportsVulkan: false });
  assert.equal(s.backend, "cuda");
});

test("no GPU at all is a supported answer, not an error", () => {
  const s = suggestBackend("linux", "x64", { vendorIds: [], supportsVulkan: false });
  assert.equal(s.backend, "cpu");
});

test("the device list is parsed for memory, which is the whole point of probing", () => {
  const devices = parseDevices(`Available devices:
  CUDA0: NVIDIA GeForce RTX 3090 (24576 MiB, 23000 MiB free)
  CUDA1: NVIDIA GeForce RTX 3060 (12288 MiB, 12000 MiB free)`);
  assert.equal(devices.length, 2);
  assert.equal(devices[0]!.id, "CUDA0");
  assert.equal(devices[0]!.description, "NVIDIA GeForce RTX 3090");
  assert.equal(devices[0]!.totalBytes, 24576 * 1024 * 1024);
  assert.equal(devices[0]!.freeBytes, 23000 * 1024 * 1024);
  // A model has to fit in one device, so the largest is what matters.
  assert.equal(largestDeviceBytes(devices), 24576 * 1024 * 1024);
  assert.ok(hasAccelerator(devices));
});

test("a device line without memory still yields a device", () => {
  // The exact format is upstream's and has changed between releases; losing the
  // memory figure must not lose the device.
  const devices = parseDevices("Available devices:\n  Vulkan0: AMD Radeon RX 7900 XTX");
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.totalBytes, undefined);
  assert.ok(hasAccelerator(devices));
});

test("an unreadable device list degrades to 'no accelerator', never to a crash", () => {
  // This is the safe direction: CPU always works.
  const devices = parseDevices("ggml_vulkan: no devices found\n\n???");
  assert.equal(hasAccelerator(devices), false);
  assert.equal(largestDeviceBytes(devices), undefined);
});

test("upstream's literal 'no devices' output is understood", () => {
  // Verbatim from running the b10628 CPU build on this machine. Upstream
  // filters CPU devices out of the listing entirely, so this is what a machine
  // with no accelerator genuinely prints.
  const devices = parseDevices("Available devices:\n  (none)\n");
  assert.deepEqual(devices, []);
  assert.equal(hasAccelerator(devices), false);
});

/*
 * Written blind, for hardware this was never run on.
 *
 * Chromium's `hardwareSupportsVulkan` answers a question about Chromium's own
 * rendering path, not about what llama.cpp can use. It reports false on
 * headless and EGL sessions, when the browser has fallen back to SwiftShader,
 * and under some X11 configurations of the NVIDIA proprietary driver -- all of
 * which are ordinary states for a Linux workstation with a real card in it.
 * Believing it meant that machine got CPU-only inference and no explanation.
 */
test("a real card with no reported Vulkan still gets one attempt", () => {
  for (const [vendor, name] of [
    [VENDOR.nvidia, "NVIDIA"],
    [VENDOR.amd, "AMD"],
    [VENDOR.intel, "Intel"],
  ] as const) {
    const s = suggestBackend("linux", "x64", { vendorIds: [vendor], supportsVulkan: false });
    assert.equal(s.backend, "vulkan", `${name} should still try Vulkan`);
    assert.match(s.reason, /fall back/, "and the reason has to say it might not work");
  }
});

test("a virtual GPU is still not given that benefit of the doubt", () => {
  // The check above must not undo the virtio case: a paravirtual display
  // adapter has nothing to accelerate with, and a 33 MB download would be spent
  // to learn what the vendor id already said.
  const s = suggestBackend("linux", "x64", { vendorIds: [VENDOR.virtio], supportsVulkan: false });
  assert.equal(s.backend, "cpu");
});

test("Windows NVIDIA still prefers CUDA over a hopeful Vulkan", () => {
  // The new fallback sits below the CUDA branch deliberately: on Windows there
  // is a real CUDA build to download, so a card with no Vulkan takes it.
  const s = suggestBackend("win32", "x64", { vendorIds: [VENDOR.nvidia], supportsVulkan: false });
  assert.equal(s.backend, "cuda");
});

/* ------------------------------------------------- which memory is VRAM -- */

const GB = 1024 ** 3;
const dev = (id: string, description: string, totalBytes?: number): Device =>
  ({ id, description, ...(totalBytes === undefined ? {} : { totalBytes }) });

test("a card is preferred over an integrated GPU reporting system RAM", () => {
  /*
   * The reported machine: RTX 4060 (8 GB) plus integrated graphics, 64 GB RAM.
   * Vulkan enumerates both, and the integrated one claims a slice of system
   * memory -- so taking the largest figure reported "46.9 GB VRAM" on a
   * machine with 8 GB of it, and would size models against a number three
   * times too big.
   */
  const devices = [
    dev("Vulkan0", "AMD Radeon Graphics (RADV)", 46.9 * GB),
    dev("Vulkan1", "NVIDIA GeForce RTX 4060", 8 * GB),
    dev("CPU", "CPU"),
  ];
  const choice = pickVram(devices, 64 * GB);
  assert.equal(choice?.bytes, 8 * GB);
  assert.match(choice!.device.description, /RTX 4060/);
  assert.equal(choice?.shared, false);
});

test("device order does not decide it", () => {
  const devices = [
    dev("Vulkan0", "NVIDIA GeForce RTX 4060", 8 * GB),
    dev("Vulkan1", "Intel(R) UHD Graphics", 46.9 * GB),
  ];
  assert.equal(pickVram(devices, 64 * GB)?.bytes, 8 * GB);
});

test("two real cards still take the larger", () => {
  const devices = [
    dev("CUDA0", "NVIDIA GeForce RTX 4060", 8 * GB),
    dev("CUDA1", "NVIDIA GeForce RTX 4090", 24 * GB),
  ];
  assert.equal(pickVram(devices, 64 * GB)?.bytes, 24 * GB);
});

test("an integrated GPU on its own is reported, and marked shared", () => {
  // A laptop with no discrete card is not a machine with no GPU -- but the
  // number is system RAM, and the UI has to be able to say so.
  const choice = pickVram([dev("Vulkan0", "Intel(R) Iris Xe Graphics", 24 * GB)], 32 * GB);
  assert.equal(choice?.bytes, 24 * GB);
  assert.equal(choice?.shared, true);
});

test("a software renderer is not a GPU", () => {
  // llvmpipe enumerates as a normal Vulkan device and reports plenty of
  // "memory". Loading a model onto it is slower than the CPU backend.
  const devices = [dev("Vulkan0", "llvmpipe (LLVM 19.1.0, 256 bits)", 30 * GB)];
  assert.equal(pickVram(devices, 64 * GB), undefined);
  assert.equal(hasAccelerator(devices), false);
});

test("with no RAM figure to compare against, the largest is still the answer", () => {
  // Better than refusing: the shared-memory test needs system RAM to make
  // sense, and without it the old behaviour is the honest fallback.
  const devices = [dev("Vulkan0", "NVIDIA GeForce RTX 4060", 8 * GB)];
  assert.equal(pickVram(devices, undefined)?.bytes, 8 * GB);
});
