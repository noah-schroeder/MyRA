/**
 * Choosing which layers of upstream's CUDA image to download.
 *
 * The stakes are a 2 GB transfer: pick wrongly and Karen either fetches the
 * whole Ubuntu rootfs it does not need, or fetches nothing useful and reports
 * that a working card cannot be used. The fixtures below are the real shape of
 * `ghcr.io/ggml-org/llama.cpp:server-cuda`, read off the live registry.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  appLayers, blobUrl, cudaTag, isCudaLib, layersWithHistory, libraryLayers,
  manifestUrl, pickPlatform, tokenUrl,
  type OciConfig, type OciManifest,
} from "../src/core/runtime/oci.ts";

/** The 13 layers of the real image, in order, with their build steps. */
const STEPS: [number, string][] = [
  [29_800_000, "/bin/sh -c #(nop) ADD file:6df7753 in / "],
  [6_900_000, "RUN |1 TARGETARCH=amd64 /bin/sh -c apt-get update && apt-get install -y --no-install-recommends gnupg2 curl ca-certificates && curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/${NVARCH}/3bf863cc.pub | apt-key add -"],
  [64_300_000, "RUN |1 TARGETARCH=amd64 /bin/sh -c apt-get update && apt-get install -y --no-install-recommends cuda-cudart-12-8=${NV_CUDA_CUDART_VERSION} cuda-compat-12-8 && rm -rf /var/lib/apt/lists/*"],
  [40_000, 'RUN |1 /bin/sh -c echo "/usr/local/cuda/lib64" >> /etc/ld.so.conf.d/nvidia.conf'],
  [20_000, "COPY NGC-DL-CONTAINER-LICENSE / # buildkit"],
  [2_058_000_000, "RUN |1 TARGETARCH=amd64 /bin/sh -c apt-get update && apt-get install -y --no-install-recommends cuda-libraries-12-8=${NV_CUDA_LIB_VERSION} ${NV_LIBNPP_PACKAGE} cuda-nvtx-12-8=${NV_NVTX_VERSION} libcusparse-12-8=${NV_LIBCUSPARSE_VERSION} ${NV_LIBCUBLAS_PACKAGE} ${NV_LIBNCCL_PACKAGE} && rm -rf /var/lib/apt/lists/*"],
  [100_000, "RUN |1 /bin/sh -c apt-mark hold ${NV_LIBCUBLAS_PACKAGE_NAME}"],
  [30_000, "COPY entrypoint.d/ /opt/nvidia/entrypoint.d/ # buildkit"],
  [10_000, "COPY nvidia_entrypoint.sh /opt/nvidia/ # buildkit"],
  [261_900_000, "RUN |5 BUILD_DATE=2026-08-27 APP_VERSION=b10644 /bin/sh -c apt-get update && apt-get install -y libgomp1 curl ffmpeg && apt autoremove -y"],
  [165_300_000, "COPY /app/lib/ /app # buildkit"],
  [25_000, "COPY /app/full/llama /app/full/llama-server /app # buildkit"],
  [0, "WORKDIR /app"],
];

const manifest: OciManifest = {
  config: { digest: "sha256:cfg", size: 5000 },
  layers: STEPS.map(([size], i) => ({ digest: `sha256:layer${i}`, size })),
};

const config: OciConfig = {
  history: [
    ...STEPS.map(([, created_by]) => ({ created_by })),
    // Metadata steps, interleaved as they really are: these consume no layer.
    { created_by: "ENV LLAMA_ARG_HOST=0.0.0.0", empty_layer: true },
    { created_by: 'ENTRYPOINT ["/app/llama-server"]', empty_layer: true },
  ],
};

describe("urls", () => {
  it("asks for an anonymous pull token, which a public image still needs", () => {
    assert.match(tokenUrl("ggml-org/llama.cpp"), /^https:\/\/ghcr\.io\/token\?scope=/);
    assert.match(tokenUrl("ggml-org/llama.cpp"), /repository%3Aggml-org%2Fllama\.cpp%3Apull/);
  });

  it("addresses manifests and blobs by the v2 API", () => {
    assert.equal(
      manifestUrl("ggml-org/llama.cpp", "server-cuda"),
      "https://ghcr.io/v2/ggml-org/llama.cpp/manifests/server-cuda",
    );
    assert.equal(
      blobUrl("ggml-org/llama.cpp", "sha256:abc"),
      "https://ghcr.io/v2/ggml-org/llama.cpp/blobs/sha256:abc",
    );
  });

  it("pins the tag to a build when one is known", () => {
    assert.equal(cudaTag("b10644"), "server-cuda-b10644");
    assert.equal(cudaTag(), "server-cuda");
  });
});

describe("pickPlatform", () => {
  const index = {
    manifests: [
      { digest: "sha256:amd", size: 1, platform: { os: "linux", architecture: "amd64" } },
      { digest: "sha256:arm", size: 1, platform: { os: "linux", architecture: "arm64" } },
    ],
  };

  it("finds this machine's manifest", () => {
    assert.equal(pickPlatform(index, { os: "linux", architecture: "amd64" })?.digest, "sha256:amd");
    assert.equal(pickPlatform(index, { os: "linux", architecture: "arm64" })?.digest, "sha256:arm");
  });

  it("returns nothing rather than the wrong architecture", () => {
    assert.equal(pickPlatform(index, { os: "linux", architecture: "riscv64" }), undefined);
    assert.equal(pickPlatform({}, { os: "linux", architecture: "amd64" }), undefined);
  });
});

describe("layersWithHistory", () => {
  it("pairs each layer with the step that built it, skipping metadata steps", () => {
    const layers = layersWithHistory(manifest, config);
    assert.equal(layers.length, 13);
    assert.match(layers[10]!.createdBy, /COPY \/app\/lib\//);
    assert.match(layers[11]!.createdBy, /llama-server/);
    assert.equal(layers[10]!.digest, "sha256:layer10");
  });

  it("refuses to pair at all when the counts disagree", () => {
    /* A mislabelled layer is worse than no answer: it would mean downloading
       two gigabytes and extracting nothing from it. */
    const short = { history: (config.history ?? []).slice(0, 4) };
    assert.deepEqual(layersWithHistory(manifest, short), []);
  });
});

describe("appLayers", () => {
  it("selects exactly the two layers holding llama.cpp", () => {
    const app = appLayers(layersWithHistory(manifest, config));
    assert.deepEqual(app.map((l) => l.digest), ["sha256:layer10", "sha256:layer11"]);
  });

  it("is 165 MB, not the 2.6 GB of the whole image", () => {
    const app = appLayers(layersWithHistory(manifest, config));
    const total = app.reduce((n, l) => n + l.size, 0);
    assert.ok(total < 200e6, `${(total / 1e6).toFixed(0)}MB`);
  });

  it("does not mistake the NVIDIA entrypoint COPYs for the app", () => {
    const app = appLayers(layersWithHistory(manifest, config));
    assert.ok(!app.some((l) => /nvidia/i.test(l.createdBy)));
  });
});

describe("libraryLayers", () => {
  it("tries cudart's small layer before cublas's enormous one", () => {
    /*
     * The two are in different layers, and this order is the whole reason a
     * real install failed: 64 MB holds libcudart, 2 GB holds libcublas and
     * libnccl. A machine missing only cudart should pay 64 MB.
     */
    const libs = libraryLayers(layersWithHistory(manifest, config));
    const order = libs.map((l) => l.digest);
    // cudart's 64 MB layer before cublas's 2 GB one...
    assert.ok(order.indexOf("sha256:layer2") < order.indexOf("sha256:layer5"), order.join(" "));
    // ...and both before the layer that only installs ffmpeg and libgomp.
    assert.ok(order.indexOf("sha256:layer5") < order.indexOf("sha256:layer9"), order.join(" "));
  });

  it("puts layers that never mention CUDA last, but still keeps them", () => {
    // A fallback, so a change in upstream's packaging costs bandwidth rather
    // than a failed install.
    const libs = libraryLayers(layersWithHistory(manifest, config));
    const unnamed = libs.findIndex((l) => !/cuda|nvidia|nccl|cublas/i.test(l.createdBy));
    assert.ok(unnamed > 0, "unnamed layers should not come first");
    assert.ok(libs.some((l) => l.digest === "sha256:layer9"), "should still be searched");
  });

  it("skips layers too small to hold a shared library", () => {
    const libs = libraryLayers(layersWithHistory(manifest, config));
    assert.ok(!libs.some((l) => l.size < 1024 * 1024));
  });

  it("excludes the app layers, which have already been fetched", () => {
    const libs = libraryLayers(layersWithHistory(manifest, config));
    assert.ok(!libs.some((l) => ["sha256:layer10", "sha256:layer11"].includes(l.digest)));
  });
});

describe("isCudaLib", () => {
  it("recognises the libraries ggml links against, at any version suffix", () => {
    for (const name of [
      "libcudart.so.12", "libcublas.so.12", "libcublasLt.so.12", "libnccl.so.2",
      "libcublas.so.12.6.4.1", "usr/local/cuda/lib64/libcublas.so.12",
    ]) {
      assert.ok(isCudaLib(name), `rejected ${name}`);
    }
  });

  it("does not match the driver library or unrelated files", () => {
    /* libcuda.so.1 belongs to the NVIDIA kernel driver and is version-locked to
       it -- shipping a copy would break machines rather than fix them. */
    for (const name of ["libcuda.so.1", "libggml-cuda.so", "cublas.txt", "libcudahelper.so"]) {
      assert.ok(!isCudaLib(name), `accepted ${name}`);
    }
  });
});
