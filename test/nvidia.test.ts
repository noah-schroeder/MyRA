/**
 * Telling "your driver is too old" apart from "you have no graphics card".
 *
 * ggml loads its backends with dlopen and treats one that fails to initialise
 * exactly like one that is absent, so both arrive at the user as "found no GPU
 * on this machine". The driver knows the difference and can be asked.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  compareVersions, cudaVersionOf, explainNoCudaDevice, parseNvidiaSmi,
} from "../src/core/runtime/nvidia.ts";

/** The real header nvidia-smi prints, trimmed to the line that matters. */
const HEADER = `
Wed Aug 27 11:20:04 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 550.144.03             Driver Version: 550.144.03     CUDA Version: 12.4     |
|-----------------------------------------+------------------------+----------------------+
`;

const ROWS = "NVIDIA GeForce RTX 4060, 550.144.03\n";

describe("parseNvidiaSmi", () => {
  it("reads the driver version and the CUDA ceiling from the header", () => {
    const info = parseNvidiaSmi(HEADER);
    assert.equal(info.driverVersion, "550.144.03");
    assert.equal(info.cudaCeiling, "12.4");
  });

  it("reads card names from the csv rows", () => {
    const info = parseNvidiaSmi(`${HEADER}\n${ROWS}`);
    assert.deepEqual(info.names, ["NVIDIA GeForce RTX 4060"]);
  });

  it("does not mistake the header's own table borders for a card", () => {
    const info = parseNvidiaSmi(HEADER);
    assert.deepEqual(info.names, []);
  });

  it("answers emptily when nvidia-smi is not installed", () => {
    const info = parseNvidiaSmi("");
    assert.deepEqual(info, { names: [] });
  });
});

describe("compareVersions", () => {
  it("orders CUDA versions the way a ceiling needs", () => {
    assert.ok(compareVersions("12.4", "12.8") < 0);
    assert.ok(compareVersions("12.8", "12.8") === 0);
    assert.ok(compareVersions("13.0", "12.8") > 0);
    // 12.10 is newer than 12.8, which string comparison gets backwards.
    assert.ok(compareVersions("12.10", "12.8") > 0);
  });
});

describe("cudaVersionOf", () => {
  it("reads the version out of the image's own build step", () => {
    assert.equal(
      cudaVersionOf("apt-get install -y --no-install-recommends cuda-cudart-12-8=${NV_CUDA_CUDART_VERSION}"),
      "12.8",
    );
    assert.equal(cudaVersionOf("apt-get install libgomp1"), undefined);
  });
});

describe("explainNoCudaDevice", () => {
  it("names the ceiling when the driver is too old for the build", () => {
    const why = explainNoCudaDevice(parseNvidiaSmi(`${HEADER}\n${ROWS}`), "12.8");
    assert.match(why!, /supports CUDA up to 12\.4/);
    assert.match(why!, /needs 12\.8/);
    // And says what to do about it, both ways.
    assert.match(why!, /Update the driver/);
    assert.match(why!, /Vulkan/);
  });

  it("says so plainly when there is no driver at all", () => {
    const why = explainNoCudaDevice(parseNvidiaSmi(""));
    assert.match(why!, /No NVIDIA driver was found/);
  });

  it("does not invent a cause when the driver is new enough", () => {
    /* A working card and a sufficient driver means the fault is somewhere this
       cannot see, and a confident wrong answer would be worse than pointing at
       the probe output. */
    const info = parseNvidiaSmi(
      "| NVIDIA-SMI 570.10  Driver Version: 570.10  CUDA Version: 12.8 |\nNVIDIA GeForce RTX 4060, 570.10\n",
    );
    const why = explainNoCudaDevice(info, "12.8");
    assert.doesNotMatch(why!, /supports CUDA up to/);
    assert.match(why!, /did not initialise/);
    assert.match(why!, /RTX 4060/);
  });
});
