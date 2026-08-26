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
  hasAccelerator, largestDeviceBytes, parseDevices, suggestBackend, VENDOR, vendorName,
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

test("an NVIDIA card on Linux is told why it is not getting CUDA", () => {
  const s = suggestBackend("linux", "x64", { vendorIds: [VENDOR.nvidia], supportsVulkan: true });
  assert.equal(s.backend, "vulkan");
  // Otherwise the user's conclusion is "this app is slow", not "upstream ships
  // no Linux CUDA build".
  assert.match(s.reason, /no Linux CUDA build/);
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
