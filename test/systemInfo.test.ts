/**
 * Reading Lemonade's account of the machine.
 *
 * The fixture is the real payload from `/api/v1/system-info`, captured from
 * lemond 11.8.0 -- including the exact wording of the strings MyRA now shows
 * to users instead of composing its own.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  explainNoAccelerator, installableBackends, parseBackends, parseDevices, parseSystemInfo, toBytes,
} from "../src/core/runtime/systemInfo.ts";

/** Measured on a machine with no discrete GPU. */
const NO_GPU = {
  "OS Version": "Linux-6.17.0-41-generic (Ubuntu 25.10)",
  "Physical Memory": "15.11 GB",
  devices: {
    amd_gpu: [],
    amd_npu: { available: false, error: "No NPU device found with amdxdna driver", name: "i5-13600K" },
    cpu: { available: true, cores: 20, family: "x86_64", name: "13th Gen Intel(R) Core(TM) i5-13600K", threads: 20 },
    nvidia_gpu: [{ available: false, error: "No NVIDIA discrete GPU found", name: "" }],
  },
  model_storage: { free_bytes: 45_380_395_008, path: "/home/x/.cache/huggingface/hub", total_bytes: 105_493_626_880 },
  recipes: {
    llamacpp: {
      backends: {
        cpu: { state: "installable", message: "Backend is supported but not installed.", version: "b10375" },
        cuda: { state: "unsupported", message: "Unsupported GPU" },
        metal: { state: "unsupported", message: "Requires macOS" },
        vulkan: { state: "installable", message: "Backend is supported but not installed.", version: "b10375" },
      },
    },
  },
};

/** The same machine with a card, in the shape the daemon builds from nvidia-smi. */
const WITH_GPU = {
  ...NO_GPU,
  devices: {
    ...NO_GPU.devices,
    nvidia_gpu: [{
      available: true, name: "NVIDIA GeForce RTX 4060", memory_total: 8188,
      compute_capability: "8.9", driver_version: "580.173.02",
    }],
  },
  recipes: { llamacpp: { backends: { cuda: { state: "installable", message: "Backend is supported but not installed." } } } },
};

describe("toBytes", () => {
  it("reads nvidia-smi's unitless megabytes", () => {
    // `--format=csv,noheader,nounits` yields a bare number in MB.
    assert.equal(toBytes(8188), 8188 * 1024 * 1024);
  });

  it("reads the human strings the same payload uses elsewhere", () => {
    assert.equal(toBytes("15.11 GB"), Math.round(15.11 * 1024 ** 3));
    assert.equal(toBytes("8192 MiB"), 8192 * 1024 ** 2);
  });

  it("treats a large bare number as bytes, not megabytes", () => {
    assert.equal(toBytes(45_380_395_008), 45_380_395_008);
  });

  it("returns nothing rather than zero or NaN", () => {
    for (const v of [0, -1, "", "n/a", null, undefined, {}]) assert.equal(toBytes(v), undefined);
  });
});

describe("parseDevices", () => {
  it("lists a working card with its memory", () => {
    const [gpu] = parseDevices(WITH_GPU);
    assert.equal(gpu?.id, "CUDA0");
    assert.equal(gpu?.description, "NVIDIA GeForce RTX 4060");
    assert.equal(gpu?.totalBytes, 8188 * 1024 * 1024);
  });

  it("omits devices that are present but unavailable", () => {
    /* An entry exists for nvidia_gpu on every machine; `available` is what says
       whether there is one. Listing it anyway would put a card with no memory
       into the "will this model fit" calculation. */
    assert.deepEqual(parseDevices(NO_GPU), []);
  });

  it("survives a payload with none of the expected keys", () => {
    for (const v of [{}, null, { devices: null }, { devices: { nvidia_gpu: "no" } }]) {
      assert.deepEqual(parseDevices(v), []);
    }
  });
});

describe("parseBackends", () => {
  it("reports each backend's state and upstream's own wording", () => {
    const backends = parseBackends(NO_GPU);
    const cuda = backends.find((b) => b.id === "cuda");
    assert.equal(cuda?.state, "unsupported");
    assert.equal(cuda?.message, "Unsupported GPU");
  });

  it("offers only what would actually work here", () => {
    const ids = installableBackends(parseBackends(NO_GPU)).map((b) => b.id).sort();
    assert.deepEqual(ids, ["cpu", "vulkan"]);
  });
});

describe("parseSystemInfo", () => {
  it("reads memory, storage and driver in one pass", () => {
    const info = parseSystemInfo(WITH_GPU);
    assert.equal(info.ramBytes, Math.round(15.11 * 1024 ** 3));
    assert.equal(info.modelStorageFreeBytes, 45_380_395_008);
    assert.equal(info.driverVersion, "580.173.02");
    assert.match(info.osVersion!, /Ubuntu 25\.10/);
  });
});

describe("explainNoAccelerator", () => {
  it("uses the daemon's own reason rather than one written here", () => {
    /* MyRA used to compose this from nvidia-smi, because ggml reports "driver
       too old" and "no card" identically. Lemonade states it per device, so the
       explanation stays true as its support changes. */
    const why = explainNoAccelerator(NO_GPU);
    assert.match(why!, /No NVIDIA discrete GPU found/);
  });

  it("mentions a backend that is blocked, but not one that needs another OS", () => {
    const why = explainNoAccelerator(NO_GPU)!;
    assert.match(why, /cuda: Unsupported GPU/);
    // "Requires macOS" on Linux is noise, not a diagnosis.
    assert.doesNotMatch(why, /macOS/);
  });

  it("leaves out backends that say nothing about this machine", () => {
    /* `system` means "a llama.cpp you installed yourself"; its absence is not a
       reason the GPU is unused, and it crowds out the reason that is. */
    const why = explainNoAccelerator({
      ...NO_GPU,
      recipes: { llamacpp: { backends: {
        cuda: { state: "unsupported", message: "Unsupported GPU" },
        system: { state: "unsupported", message: "llama-server not found in PATH" },
      } } },
    })!;
    assert.match(why, /cuda: Unsupported GPU/);
    assert.doesNotMatch(why, /PATH/);
  });

  it("says nothing when there is an accelerator", () => {
    assert.equal(explainNoAccelerator(WITH_GPU), undefined);
  });

  it("says nothing rather than inventing a cause", () => {
    assert.equal(explainNoAccelerator({ devices: {} }), undefined);
  });
});
