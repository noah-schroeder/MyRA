/**
 * Running a build compiled on a newer Linux than the machine it lands on.
 *
 * The strings below are the real ones, from a machine with an RTX 4060 and a
 * working 580 driver that reported no graphics card at all.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  cRuntimeEssentials, cRuntimePatterns, explainTooOld, gnuTriplet, isSharedObject, isTooOld,
  loaderName, missingVersions, parseLdSoConf, parseMissingLibraries, searchPath,
} from "../src/core/runtime/libc.ts";
import { baseLayers, layersWithHistory } from "../src/core/runtime/oci.ts";

const PROBE = `
/home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/llama-server: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by /home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/libllama-server-impl.so)
/home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/llama-server: /lib/x86_64-linux-gnu/libstdc++.so.6: version \`GLIBCXX_3.4.32' not found (required by /home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/libllama-common.so.0)
/home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/llama-server: /lib/x86_64-linux-gnu/libm.so.6: version \`GLIBC_2.38' not found (required by /home/noah/.config/Karen/runtimes/llama.cpp/b10644-cuda/libllama-common.so.0)
`;

describe("missingVersions", () => {
  it("reads the symbol versions the loader could not satisfy", () => {
    assert.deepEqual(missingVersions(PROBE).sort(), ["GLIBCXX_3.4.32", "GLIBC_2.38"].sort());
  });

  it("reports each version once however many libraries wanted it", () => {
    // GLIBC_2.38 appears three times above, from three different libraries.
    assert.equal(missingVersions(PROBE).filter((v) => v === "GLIBC_2.38").length, 1);
  });

  it("says nothing about a machine that merely has no card", () => {
    assert.deepEqual(missingVersions("Available devices:\n  (none)\n"), []);
    assert.equal(isTooOld("Available devices:\n  (none)\n"), false);
    assert.equal(isTooOld(PROBE), true);
  });

  it("is not fooled by a missing library, which is a different fault", () => {
    /* "not found" also ends the line ggml prints for an absent soname, and that
       one is fixed by downloading rather than by bundling a C library. */
    assert.deepEqual(missingVersions("libcudart.so.12 => not found"), []);
  });
});

describe("explainTooOld", () => {
  it("names the versions and says the card is not the problem", () => {
    const why = explainTooOld(missingVersions(PROBE));
    assert.match(why, /GLIBC_2\.38/);
    assert.match(why, /newer Linux/);
    // The point that this failure hides: the hardware is fine.
    assert.match(why, /even though\s+yours is working|yours is working/);
    assert.match(why, /Install the CUDA build again/);
  });
});

describe("the bundle's contents", () => {
  it("takes the loader and the C++ runtime, since both were missing", () => {
    const patterns = cRuntimePatterns("x64").join(" ");
    assert.match(patterns, /ld-linux-x86-64\.so\.2/);
    assert.match(patterns, /libc\.so\.6/);
    assert.match(patterns, /libstdc\+\+\.so\./);
  });

  it("anchors under the triplet directory, not usr/lib64", () => {
    /* usr/lib64 holds the same names as relative symlinks pointing back out of
       the directory. Flattened into one directory they become links to nowhere,
       landing on top of the real loader. */
    for (const p of cRuntimePatterns("x64")) {
      assert.ok(p.startsWith("usr/lib/x86_64-linux-gnu/"), p);
    }
  });

  it("knows arm64 uses a different loader and directory", () => {
    assert.equal(loaderName("arm64"), "ld-linux-aarch64.so.1");
    assert.equal(gnuTriplet("arm64"), "aarch64-linux-gnu");
    assert.ok(cRuntimePatterns("arm64").every((p) => p.includes("aarch64-linux-gnu")));
  });

  it("requires the loader and libc together, never one alone", () => {
    /* A libc without its matching loader is worse than neither: the host loader
       pairs with a libc it does not match and the process dies on
       `undefined symbol: __nptl_change_stack_perm`. Measured. */
    const need = cRuntimeEssentials("x64");
    assert.ok(need.includes("ld-linux-x86-64.so.2"));
    assert.ok(need.includes("libc.so.6"));
    assert.ok(need.includes("libstdc++.so.6"));
  });

  it("ships shared objects and not the gdb script packaged beside them", () => {
    assert.ok(isSharedObject("libstdc++.so.6"));
    assert.ok(isSharedObject("libstdc++.so.6.0.33"));
    assert.ok(isSharedObject("ld-linux-x86-64.so.2"));
    assert.ok(!isSharedObject("libstdc++.so.6.0.33-gdb.py"));
  });
});

describe("parseLdSoConf", () => {
  it("separates directories from includes and drops comments", () => {
    const { dirs, includes } = parseLdSoConf(
      "# comment\ninclude /etc/ld.so.conf.d/*.conf\n\n/usr/local/lib\n/opt/cuda/lib64 # trailing\n",
    );
    assert.deepEqual(dirs, ["/usr/local/lib", "/opt/cuda/lib64"]);
    assert.deepEqual(includes, ["/etc/ld.so.conf.d/*.conf"]);
  });

  it("picks up the directory an NVIDIA package adds", () => {
    // This is how libcuda.so.1 is found on several distributions, and
    // --library-path replaces the system search rather than extending it.
    const { dirs } = parseLdSoConf("/usr/lib/x86_64-linux-gnu/nvidia/current\n");
    assert.deepEqual(dirs, ["/usr/lib/x86_64-linux-gnu/nvidia/current"]);
  });
});

describe("searchPath", () => {
  it("puts the bundle first, then the build, then the system", () => {
    const p = searchPath("/r/libc", "/r", ["/usr/lib/x86_64-linux-gnu"]);
    assert.equal(p, "/r/libc:/r:/usr/lib/x86_64-linux-gnu");
  });

  it("does not repeat a directory the system also names", () => {
    assert.equal(searchPath("/r/libc", "/r", ["/r", "/lib", "/lib"]), "/r/libc:/r:/lib");
  });
});

describe("baseLayers", () => {
  it("tries the rootfs layer first, where the whole C runtime lives together", () => {
    const manifest = {
      config: { digest: "sha256:cfg", size: 1 },
      layers: [
        { digest: "sha256:root", size: 29_800_000 },
        { digest: "sha256:cuda", size: 64_300_000 },
        { digest: "sha256:app", size: 165_300_000 },
      ],
    };
    const config = {
      history: [
        { created_by: "/bin/sh -c #(nop) ADD file:6df7753 in / " },
        { created_by: "RUN apt-get install -y cuda-cudart-12-8" },
        { created_by: "COPY /app/lib/ /app # buildkit" },
      ],
    };
    const order = baseLayers(layersWithHistory(manifest, config)).map((l) => l.digest);
    assert.equal(order[0], "sha256:root");
    // and never the app layers, which are already unpacked
    assert.ok(!order.includes("sha256:app"));
  });
});

describe("parseMissingLibraries", () => {
  /* Both of these are real output for the same library on the same machine:
     the first from `ldd`, the second from the same loader run without a trace
     requested. Only one of them looks like ldd. */
  const TRACED = `\tlinux-vdso.so.1 (0x00007ffd)
\tlibcudart.so.12 => not found
\tlibcublas.so.12 => not found
\tlibcuda.so.1 => not found
\tlibnccl.so.2 => not found
\tlibstdc++.so.6 => /r/libc/libstdc++.so.6 (0x00007f00)
`;
  const ABORTED =
    "./libggml-cuda.so: error while loading shared libraries: libcudart.so.12: " +
    "cannot open shared object file: No such file or directory\n";

  it("reads the traced form, and only the names that are missing", () => {
    assert.deepEqual(parseMissingLibraries(TRACED), [
      "libcudart.so.12", "libcublas.so.12", "libcuda.so.1", "libnccl.so.2",
    ]);
  });

  it("reads the form the loader uses when it gives up instead of tracing", () => {
    /* This is the one that was missed. The loader stops at the first missing
       library and never prints "=> not found", so a parser watching only for
       that read four missing libraries as none -- and Karen would have decided
       the machine already had CUDA and installed a build that cannot load. */
    assert.deepEqual(parseMissingLibraries(ABORTED), ["libcudart.so.12"]);
  });

  it("counts a library named by both forms once", () => {
    assert.deepEqual(
      parseMissingLibraries(`${ABORTED}\tlibcudart.so.12 => not found\n`),
      ["libcudart.so.12"],
    );
  });

  it("finds nothing to report when everything resolves", () => {
    assert.deepEqual(parseMissingLibraries("\tlibm.so.6 => /r/libc/libm.so.6 (0x7f)\n"), []);
  });
});
