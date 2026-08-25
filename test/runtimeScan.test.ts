/**
 * Finding models another application already downloaded.
 *
 * The layouts below are the real ones. The HuggingFace cache is the awkward
 * case -- `models--org--repo/snapshots/<revision>/file.gguf` is five levels
 * down -- and a shallow walk silently finds nothing, which looks identical to
 * "you have no models".
 */

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { dedupeFound, knownStores, scanStore, type WalkFs } from "../src/core/runtime/scan.ts";

/** A filesystem described as a path→children map. */
function fakeFs(tree: Record<string, string[]>, sizes: Record<string, number> = {}): WalkFs {
  return {
    async readdir(dir) {
      const children = tree[dir];
      if (!children) throw new Error("ENOENT");
      return children.map((name) => ({
        name,
        isDirectory: !name.includes("."),
        isFile: name.includes("."),
      }));
    },
    async size(path) {
      return sizes[path] ?? 1000;
    },
  };
}

test("LM Studio's publisher/repo layout is walked", () => {
  const dir = join("/home/x", ".lmstudio", "models");
  const fs = fakeFs({
    [dir]: ["unsloth"],
    [join(dir, "unsloth")]: ["Qwen3-GGUF"],
    [join(dir, "unsloth", "Qwen3-GGUF")]: ["Qwen3-Q4_K_M.gguf", "README.md"],
  });
  return scanStore({ label: "LM Studio", dir, depth: 4 }, fs).then((found) => {
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, "Qwen3-Q4_K_M.gguf");
    assert.equal(found[0]!.source, "LM Studio");
  });
});

test("the HuggingFace cache is found five levels down", async () => {
  const dir = join("/home/x", ".cache", "huggingface", "hub");
  const repo = join(dir, "models--unsloth--Qwen3-GGUF");
  const snap = join(repo, "snapshots", "abc123");
  const fs = fakeFs({
    [dir]: ["models--unsloth--Qwen3-GGUF"],
    [repo]: ["snapshots", "blobs"],
    [join(repo, "snapshots")]: ["abc123"],
    [join(repo, "blobs")]: [],
    [snap]: ["Qwen3-Q4_K_M.gguf"],
  });
  const store = knownStores("/home/x").find((s) => s.label === "HuggingFace")!;
  const found = await scanStore(store, fs);
  assert.equal(found.length, 1, "a shallower walk would report no models at all");
  assert.equal(found[0]!.path, join(snap, "Qwen3-Q4_K_M.gguf"));
});

test("a store that is not installed is silence, not an error", async () => {
  const found = await scanStore({ label: "LM Studio", dir: "/nope", depth: 3 }, fakeFs({}));
  assert.deepEqual(found, []);
});

test("the walk is bounded, because this runs while someone waits", async () => {
  const dir = "/big";
  const many = Array.from({ length: 500 }, (_, i) => `m${i}.gguf`);
  const found = await scanStore({ label: "x", dir, depth: 1 }, fakeFs({ [dir]: many }), 50);
  assert.equal(found.length, 50);
});

test("the same file reachable through two stores is listed once", () => {
  // LM Studio hard-links out of the HuggingFace cache, so this is the norm.
  const rows = dedupeFound([
    { path: "/a/Qwen3-Q4_K_M.gguf", size: 18_000, source: "LM Studio", name: "Qwen3-Q4_K_M.gguf" },
    { path: "/b/Qwen3-Q4_K_M.gguf", size: 18_000, source: "HuggingFace", name: "Qwen3-Q4_K_M.gguf" },
    { path: "/c/Other-Q4_K_M.gguf", size: 9_000, source: "llama.cpp", name: "Other-Q4_K_M.gguf" },
  ]);
  assert.equal(rows.length, 2);
});

test("Ollama is not scanned", () => {
  // Deliberate: content-addressed blobs behind a private manifest format, and
  // this app is meant to replace it rather than reach into it.
  assert.ok(!knownStores("/home/x").some((s) => /ollama/i.test(s.dir)));
});
