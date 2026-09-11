/**
 * Reading someone else's model library.
 *
 * The Ollama half is the part that needs tests most: its store is
 * content-addressed, so nothing about a blob's name or location says which
 * model it is, and every mapping from `llama3.2:3b` to a file on disk is an
 * inference from a manifest. There is no Ollama installed on the machine this
 * was written on, so these build the store by hand.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  blobFile, defaultStores, indexId, isAuxiliaryGguf, ollamaLabel, ollamaModelDigest,
  readIndexId, safeSegment,
} from "../src/core/runtime/foreign.ts";
import { buildIndex, scanLmStudio, scanOllama } from "../src/main/runtime/foreignScan.ts";

const temps: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "myra-foreign-"));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ names -- */

test("an official Ollama model drops the library namespace nobody types", () => {
  assert.equal(ollamaLabel("registry.ollama.ai/library/llama3.2/3b"), "llama3.2:3b");
});

test("a namespaced Ollama model keeps the namespace that identifies it", () => {
  assert.equal(ollamaLabel("registry.ollama.ai/someone/custom-model/latest"), "someone/custom-model:latest");
});

test("a path too short to name a model is not guessed at", () => {
  assert.equal(ollamaLabel("registry.ollama.ai/library"), undefined);
});

test("a colon is removed from an index name, because Windows has no colons", () => {
  const id = indexId("ollama", "llama3.2:3b");
  assert.ok(!id.includes(":"), id);
  assert.equal(id, "ollama__llama3.2-3b");
});

test("an index id says which tool it came from", () => {
  assert.deepEqual(readIndexId("ollama__llama3.2-3b"), { source: "ollama", label: "llama3.2-3b" });
  assert.deepEqual(readIndexId("lmstudio__Qwen3-8B-Q4_K_M"), { source: "lmstudio", label: "Qwen3-8B-Q4_K_M" });
});

test("a model of MyRA's own is not mistaken for a foreign one", () => {
  assert.equal(readIndexId("bartowski__SmolLM2-135M-Instruct-GGUF"), undefined);
});

test("a name that sanitises to nothing still yields a usable directory", () => {
  assert.equal(safeSegment("///"), "model");
  assert.equal(safeSegment(".."), "model");
});

/* -------------------------------------------------------------- manifests -- */

const MANIFEST = {
  schemaVersion: 2,
  layers: [
    { mediaType: "application/vnd.ollama.image.license", digest: "sha256:aaa", size: 8000 },
    { mediaType: "application/vnd.ollama.image.model", digest: "sha256:bbb", size: 2000000000 },
    { mediaType: "application/vnd.ollama.image.template", digest: "sha256:ccc", size: 100 },
  ],
};

test("the weights layer is chosen by media type, not by being the largest", () => {
  assert.equal(ollamaModelDigest(MANIFEST), "sha256:bbb");
});

test("a manifest with no model layer yields nothing rather than a wrong file", () => {
  assert.equal(ollamaModelDigest({ layers: [{ mediaType: "application/vnd.ollama.image.license", digest: "sha256:aaa" }] }), undefined);
  assert.equal(ollamaModelDigest({}), undefined);
  assert.equal(ollamaModelDigest(null), undefined);
});

test("a digest names the blob file it is stored as", () => {
  assert.equal(blobFile("sha256:bbb"), "sha256-bbb");
});

/* ----------------------------------------------------------------- stores -- */

test("Ollama's store is read through its manifests", async () => {
  const root = await temp();
  await mkdir(join(root, "manifests", "registry.ollama.ai", "library", "llama3.2"), { recursive: true });
  await mkdir(join(root, "blobs"), { recursive: true });
  await writeFile(join(root, "manifests", "registry.ollama.ai", "library", "llama3.2", "3b"), JSON.stringify(MANIFEST));
  await writeFile(join(root, "blobs", "sha256-bbb"), "weights");

  const found = await scanOllama(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.label, "llama3.2:3b");
  assert.equal(found[0]?.id, "ollama__llama3.2-3b");
  assert.equal(found[0]?.path, join(root, "blobs", "sha256-bbb"));
  // The extension is on the link, because the blob has none.
  assert.ok(found[0]?.linkName.endsWith(".gguf"));
});

test("a manifest whose blob has been garbage-collected is skipped", async () => {
  const root = await temp();
  await mkdir(join(root, "manifests", "registry.ollama.ai", "library", "gone"), { recursive: true });
  await mkdir(join(root, "blobs"), { recursive: true });
  await writeFile(join(root, "manifests", "registry.ollama.ai", "library", "gone", "latest"), JSON.stringify(MANIFEST));
  assert.deepEqual(await scanOllama(root), []);
});

test("a store that is not there at all is not an error", async () => {
  assert.deepEqual(await scanOllama(join(await temp(), "nope")), []);
});

test("LM Studio models are labelled by filename, which carries the quantisation", async () => {
  const root = await temp();
  await mkdir(join(root, "bartowski", "Qwen3-8B-GGUF"), { recursive: true });
  await writeFile(join(root, "bartowski", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"), "w");
  const found = await scanLmStudio(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.label, "Qwen3-8B-Q4_K_M");
});

test("a vision projector is not offered as a model of its own", async () => {
  assert.ok(isAuxiliaryGguf("mmproj-model-f16.gguf"));
  assert.ok(isAuxiliaryGguf("Qwen2-VL-7B.mmproj-f16.gguf"));
  assert.ok(!isAuxiliaryGguf("Qwen3-8B-Q4_K_M.gguf"));
});

test("a split archive is listed once, under its first part", async () => {
  assert.ok(!isAuxiliaryGguf("big-model-00001-of-00003.gguf"));
  assert.ok(isAuxiliaryGguf("big-model-00002-of-00003.gguf"));
  assert.ok(isAuxiliaryGguf("big-model-00003-of-00003.gguf"));
});

/* ------------------------------------------------------------------ index -- */

test("the index mirrors MyRA's own models under their existing ids", async () => {
  const models = await temp();
  const index = join(await temp(), "models-index");
  await mkdir(join(models, "LiquidAI__LFM2.5-2.6B-GGUF"), { recursive: true });
  await writeFile(join(models, "LiquidAI__LFM2.5-2.6B-GGUF", "LFM2.5-2.6B-Q4_0.gguf"), "w");

  await buildIndex({ indexDir: index, modelsDir: models, includeForeign: false });

  /* The id Lemonade reports is the leaf directory's name, so preserving the
     name is what stops a saved "load on launch" from breaking. */
  const entries = await readdir(index);
  assert.ok(entries.includes("LiquidAI__LFM2.5-2.6B-GGUF"), entries.join(","));
  const link = join(index, "LiquidAI__LFM2.5-2.6B-GGUF", "LFM2.5-2.6B-Q4_0.gguf");
  assert.equal(await readlink(link), join(models, "LiquidAI__LFM2.5-2.6B-GGUF", "LFM2.5-2.6B-Q4_0.gguf"));
});

test("the index is rebuilt from scratch, so a deleted model leaves no dangling entry", async () => {
  const models = await temp();
  const index = join(await temp(), "models-index");
  await mkdir(join(models, "Gone__Model"), { recursive: true });
  await writeFile(join(models, "Gone__Model", "m.gguf"), "w");
  await buildIndex({ indexDir: index, modelsDir: models, includeForeign: false });
  assert.ok((await readdir(index)).includes("Gone__Model"));

  await rm(join(models, "Gone__Model"), { recursive: true });
  await buildIndex({ indexDir: index, modelsDir: models, includeForeign: false });
  assert.ok(!(await readdir(index)).includes("Gone__Model"));
});

test("no weights are copied: every model in the index is a link", async () => {
  const models = await temp();
  const index = join(await temp(), "models-index");
  await mkdir(join(models, "Some__Model"), { recursive: true });
  await writeFile(join(models, "Some__Model", "m.gguf"), "weights");
  await buildIndex({ indexDir: index, modelsDir: models, includeForeign: false });
  // readlink throws on a real file, so this passing means nothing was copied.
  assert.equal(
    await readlink(join(index, "Some__Model", "m.gguf")),
    join(models, "Some__Model", "m.gguf"),
  );
});

test("the index refuses to build somewhere that would delete the models", async () => {
  const root = await temp();
  const models = join(root, "models");
  await mkdir(models, { recursive: true });
  await writeFile(join(models, "keep.gguf"), "w");

  // buildIndex begins by removing its own directory; here that is the parent
  // of the user's entire model library.
  await assert.rejects(
    () => buildIndex({ indexDir: root, modelsDir: models, includeForeign: false }),
    /Refusing to build the model index/,
  );
  assert.ok((await readdir(models)).includes("keep.gguf"));
});

/* --------------------------------------------------------------- defaults -- */

test("Ollama's own environment variable wins over the default location", () => {
  const stores = defaultStores("/home/x", "linux", { OLLAMA_MODELS: "/mnt/big/ollama" });
  assert.ok(stores.some((s) => s.source === "ollama" && s.dir === "/mnt/big/ollama"));
  assert.ok(!stores.some((s) => s.dir === "/home/x/.ollama/models"));
});

test("both LM Studio locations are looked at, old and new", () => {
  const dirs = defaultStores("/home/x", "linux").filter((s) => s.source === "lmstudio").map((s) => s.dir);
  assert.deepEqual(dirs, ["/home/x/.lmstudio/models", "/home/x/.cache/lm-studio/models"]);
});
