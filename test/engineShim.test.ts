/**
 * Making Lemonade's engines start on a system older than they are.
 *
 * The reported failure, from Ubuntu 22.04 (glibc 2.35): chat answers perfectly
 * and dictation dies with
 *
 *   Failed to load model 'Whisper-Large-v3-Turbo': whisper-server failed to
 *   start or become ready
 *
 * with the daemon's log showing `whisper-server process has terminated with
 * exit code: 1` a hundred milliseconds after it was spawned -- twice, the
 * second time with the GPU emptied first, which is what rules out memory.
 *
 * Measured cause: whisper-server v1.8.4 and kokoro's koko b17 both need
 * GLIBC_2.38, while the llama.cpp build needs 2.34. Karen already carries a
 * newer glibc for `lemond` on such a machine; the engines get none of it
 * because Lemonade spawns them itself.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  couldBeEngine, isShimScript, REAL_SUFFIX, shimScript,
} from "../src/core/runtime/engineShim.ts";
import {
  engineBinaries, engineDirs, isWrapped, repairEngines, wrapEngine,
} from "../src/main/runtime/engineRuntime.ts";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

/** A directory shaped like one Lemonade installs an engine into. */
async function engineDir(names: string[] = ["whisper-server"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "karen-engine-"));
  for (const name of names) {
    await writeFile(join(dir, name), ELF);
    await chmod(join(dir, name), 0o755);
  }
  await writeFile(join(dir, "libwhisper.so.1"), ELF);
  await chmod(join(dir, "libwhisper.so.1"), 0o755);
  await writeFile(join(dir, "version.txt"), "v1.8.4\n");
  return dir;
}

/** A stand-in for the runtime Karen ships beside lemond. */
async function runtimeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "karen-libc-"));
  await mkdir(join(dir, "libc"));
  for (const name of ["libc.so.6", "libm.so.6", "libstdc++.so.6"]) {
    await writeFile(join(dir, "libc", name), ELF);
  }
  await writeFile(join(dir, "ld-linux-x86-64.so.2"), ELF);
  await chmod(join(dir, "ld-linux-x86-64.so.2"), 0o755);
  return dir;
}

describe("the script that stands in for the engine", () => {
  const spec = { arch: "x64", hostDirs: ["/lib/x86_64-linux-gnu", "/usr/lib"] };

  it("execs, so Lemonade's pid is the engine and not a shell", () => {
    /* Lemonade records the pid it spawned and kills the process by it. A shell
       that forks would leave the engine running after "Stopping server". */
    assert.match(shimScript("whisper-server", spec), /^exec /m);
  });

  it("searches the bundle, then the engine's own directory, then the host", () => {
    const text = shimScript("whisper-server", spec);
    /* Order and completeness both matter: --library-path REPLACES the loader's
       search, so a directory left out is not found at all -- which is how a
       machine with a perfectly good driver reports no GPU. */
    assert.match(text, /--library-path "\$d\/libc:\$d:\/lib\/x86_64-linux-gnu:\/usr\/lib"/);
  });

  it("resolves its own directory at run time, not at install time", () => {
    // A restored backup or a renamed account moves every one of these paths.
    const text = shimScript("koko", spec);
    assert.match(text, /dirname -- "\$0"/);
    assert.equal(/\/home\//.test(text), false);
  });

  it("passes the arguments through, because the model path is one of them", () => {
    assert.match(shimScript("whisper-server", spec), /"\$@"/);
  });

  it("is recognisable as ours, so it is never wrapped a second time", () => {
    assert.equal(isShimScript(shimScript("koko", spec)), true);
    assert.equal(isShimScript("#!/bin/sh\nexec /usr/bin/something\n"), false);
  });

  it("leaves libraries and already-renamed binaries alone", () => {
    assert.equal(couldBeEngine("whisper-server"), true);
    assert.equal(couldBeEngine("koko"), true);
    assert.equal(couldBeEngine("libwhisper.so.1"), false);
    assert.equal(couldBeEngine("libggml-vulkan.so"), false);
    assert.equal(couldBeEngine(`whisper-server${REAL_SUFFIX}`), false);
    assert.equal(couldBeEngine("ld-linux-x86-64.so.2"), false);
  });
});

describe("finding what to wrap", () => {
  it("takes the executables and not the data beside them", async () => {
    /* kokoro ships espeak-ng-data/ and a version.txt next to `koko`; whisper
       ships nine shared objects next to whisper-server. */
    const dir = await engineDir(["whisper-server", "bench"]);
    assert.deepEqual((await engineBinaries(dir)).sort(), ["bench", "whisper-server"]);
  });

  it("reads Lemonade's own bin/<recipe>/<backend> layout", async () => {
    const cache = await mkdtemp(join(tmpdir(), "karen-cache-"));
    await mkdir(join(cache, "bin", "whispercpp", "vulkan"), { recursive: true });
    await mkdir(join(cache, "bin", "kokoro", "cpu"), { recursive: true });
    const found = (await engineDirs(cache)).map((e) => `${e.recipe}:${e.backend}`).sort();
    assert.deepEqual(found, ["kokoro:cpu", "whispercpp:vulkan"]);
  });
});

describe("wrapping an engine", () => {
  it("puts the loader in the engine's directory, where ggml will look", async () => {
    /* Not beside lemond, and not in libc/. ggml finds libggml-vulkan.so
       relative to /proc/self/exe, which under a bundled loader IS the loader:
       one directory out and whisper-server starts with no backend. */
    const dir = await engineDir();
    const wrapped = await wrapEngine(dir, await runtimeDir());
    assert.deepEqual(wrapped, ["whisper-server"]);
    const names = await readdir(dir);
    assert.ok(names.includes("ld-linux-x86-64.so.2"), "loader beside the binary");
    assert.ok(names.includes("libc"), "libraries in their own directory");
  });

  it("keeps the real binary under the name the shim execs", async () => {
    const dir = await engineDir();
    await wrapEngine(dir, await runtimeDir());
    const shim = await readFile(join(dir, "whisper-server"), "utf8");
    assert.equal(isShimScript(shim), true);
    assert.match(shim, new RegExp(`whisper-server${REAL_SUFFIX.replace(".", "\\.")}`));
    assert.deepEqual((await readFile(join(dir, `whisper-server${REAL_SUFFIX}`))).subarray(0, 4),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert.equal(await isWrapped(dir), true);
  });

  it("does not wrap a wrapper", async () => {
    /* Runs on every launch and after every install, so the second pass must be
       a no-op rather than a shim calling a shim calling the binary. */
    const dir = await engineDir();
    const runtime = await runtimeDir();
    await wrapEngine(dir, runtime);
    assert.deepEqual(await wrapEngine(dir, runtime), []);
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(REAL_SUFFIX)).length, 1);
  });

  it("leaves the machine alone when Karen did not have to bundle a C library", async () => {
    /* The common case, and the reason this costs nothing on a modern system:
       no loader beside lemond means the host is new enough for everything. */
    const cache = await mkdtemp(join(tmpdir(), "karen-cache-"));
    await mkdir(join(cache, "bin", "whispercpp", "vulkan"), { recursive: true });
    assert.deepEqual(await repairEngines(cache, await mkdtemp(join(tmpdir(), "karen-lemond-"))), []);
  });
});

describe("after Lemonade upgrades an engine", () => {
  it("wraps the new binaries, rather than trusting a leftover rename", async () => {
    /* An upgrade unpacks fresh binaries over the shims and leaves the renamed
       originals in place. A directory that merely CONTAINS a `.karen-real` is
       therefore not evidence of anything, and treating it as evidence would
       silently strand the engine as unstartable again. */
    const dir = await engineDir();
    const runtime = await runtimeDir();
    await wrapEngine(dir, runtime);

    // The upgrade: a real ELF binary back at the name the shim occupied.
    await writeFile(join(dir, "whisper-server"), ELF);
    await chmod(join(dir, "whisper-server"), 0o755);
    assert.equal(await isWrapped(dir), false, "the shim is gone");
    assert.deepEqual(await engineBinaries(dir), ["whisper-server"], "so it is seen again");

    assert.deepEqual(await wrapEngine(dir, runtime), ["whisper-server"]);
    assert.equal(await isWrapped(dir), true);
  });
});
