/**
 * Turning a HuggingFace repository into things a person can choose.
 *
 * The file list below is the real one from
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`: 28 GGUF files, some sharded
 * across two parts. Sharding is not an edge case -- every large model has it --
 * and a manager that lists parts separately invites someone to download a third
 * of a model and then wonder why it will not load.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { groupFiles, parseTree, quantOf, downloadUrl, searchUrl, type HfFile } from "../src/core/runtime/hf.ts";

test("only GGUF files survive the tree, with their size and hash", () => {
  const files = parseTree([
    { type: "file", path: "README.md", size: 4096 },
    { type: "file", path: "config.json", size: 900 },
    { type: "file", path: "m-Q4_K_M.gguf", size: 12, lfs: { oid: "A".repeat(64), size: 18_000_000_000 } },
  ]);
  assert.equal(files.length, 1);
  // The LFS size is the real one; `size` on an LFS pointer is the pointer's.
  assert.equal(files[0]!.size, 18_000_000_000);
  assert.equal(files[0]!.sha256, "a".repeat(64));
});

test("a sharded model is one choice, not several", () => {
  const files: HfFile[] = [
    { path: "BF16/Qwen3-Coder-BF16-00001-of-00002.gguf", size: 49_660_000_000 },
    { path: "BF16/Qwen3-Coder-BF16-00002-of-00002.gguf", size: 11_440_000_000 },
    { path: "Qwen3-Coder-Q4_K_M.gguf", size: 18_000_000_000 },
  ];
  const grouped = groupFiles(files);
  assert.equal(grouped.length, 2);

  const sharded = grouped.find((g) => g.parts.length === 2)!;
  assert.equal(sharded.size, 61_100_000_000, "the size shown is the whole model");
  assert.equal(sharded.entry, "BF16/Qwen3-Coder-BF16-00001-of-00002.gguf", "-m takes the first shard");
  assert.equal(sharded.label, "BF16/Qwen3-Coder-BF16.gguf");
});

test("shards are ordered numerically, not lexically", () => {
  const files: HfFile[] = [
    { path: "m-00010-of-00010.gguf", size: 1 },
    { path: "m-00002-of-00010.gguf", size: 1 },
    { path: "m-00001-of-00010.gguf", size: 1 },
  ];
  const [group] = groupFiles(files);
  assert.equal(group!.entry, "m-00001-of-00010.gguf");
  assert.deepEqual(group!.parts.map((p) => p.path), [
    "m-00001-of-00010.gguf", "m-00002-of-00010.gguf", "m-00010-of-00010.gguf",
  ]);
});

test("the quantisation is readable off the filename", () => {
  assert.equal(quantOf("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(quantOf("Qwen3-Coder-30B-A3B-Instruct-IQ4_XS.gguf"), "IQ4_XS");
  assert.equal(quantOf("dir/model-BF16.gguf"), "BF16");
  assert.equal(quantOf("model.gguf"), undefined);
});

test("a path with spaces or unicode still produces a usable URL", () => {
  // Repo names are user-supplied; a raw join would produce a broken request.
  assert.equal(
    downloadUrl("org/repo", "sub dir/model Q4.gguf"),
    "https://huggingface.co/org/repo/resolve/main/sub%20dir/model%20Q4.gguf",
  );
});

test("search asks for GGUF only, since nothing else can be run", () => {
  const url = new URL(searchUrl("qwen3"));
  assert.equal(url.searchParams.get("filter"), "gguf");
  assert.equal(url.searchParams.get("search"), "qwen3");
});
