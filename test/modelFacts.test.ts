/**
 * What MyRA has learned about a model, and which source is allowed to say so.
 *
 * `learnFacts` talks to Hugging Face and is exercised elsewhere by whatever
 * calls it in practice; nothing here mocks that network. What is tested here
 * is the part that does not need it and is easy to get quietly wrong: a
 * config.json guess must never overwrite a shape read from the model's own
 * GGUF file, in either direction a record can be built, and the whole reason
 * `learnShapeFromFile` and `learnFacts`'s "carried" fields exist at all is
 * that this file used to just replace the record wholesale.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  factsFor, learnFacts, learnShapeFromFile, setAllowOffload, setAutoCtxSize, setIgnoreSuggested,
} from "../src/main/runtime/modelFacts.ts";

/** A minimal real GGUF file, built the same way test/runtimeGguf.test.ts does. */
async function writeGguf(path: string, blockCount: number): Promise<void> {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (text: string): Buffer => {
    const body = Buffer.from(text, "utf8");
    return Buffer.concat([u64(body.length), body]);
  };
  const kvStr = (k: string, v: string): Buffer => Buffer.concat([str(k), u32(8), str(v)]);
  const kvU32 = (k: string, v: number): Buffer => Buffer.concat([str(k), u32(4), u32(v)]);
  const pairs = [
    kvStr("general.architecture", "testarch"),
    kvU32("testarch.block_count", blockCount),
    kvU32("testarch.embedding_length", 256),
    kvU32("testarch.attention.head_count", 8),
    kvU32("testarch.attention.head_count_kv", 8),
  ];
  const header = Buffer.concat([
    Buffer.from("GGUF"), u32(3), u64(0), u64(pairs.length), ...pairs,
  ]);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, header);
}

test("learnShapeFromFile records the shape and marks where it came from", async () => {
  const dir = process.env["MYRA_CONFIG_DIR"]!;
  const path = join(dir, "gguf-a.gguf");
  await writeGguf(path, 12);

  const facts = await learnShapeFromFile("model-a", path);
  assert.equal(facts?.shapeFrom, "gguf");
  assert.equal(facts?.shape?.layers, 12);
  assert.equal((await factsFor("model-a"))?.shape?.layers, 12);
});

test("a second GGUF read does nothing once one has already answered", async () => {
  const dir = process.env["MYRA_CONFIG_DIR"]!;
  const path = join(dir, "gguf-b.gguf");
  await writeGguf(path, 20);
  await learnShapeFromFile("model-b", path);

  // A different file, same id -- if this re-read, layers would change to 99.
  const other = join(dir, "gguf-b-other.gguf");
  await writeGguf(other, 99);
  const facts = await learnShapeFromFile("model-b", other);
  assert.equal(facts?.shape?.layers, 20, "the first GGUF measurement must stick");
});

test("learnFacts with no repository never destroys a GGUF shape already on record", async () => {
  const dir = process.env["MYRA_CONFIG_DIR"]!;
  const path = join(dir, "gguf-c.gguf");
  await writeGguf(path, 30);
  await learnShapeFromFile("model-c", path);
  await setAutoCtxSize("model-c", 16384);
  await setIgnoreSuggested("model-c", true);
  await setAllowOffload("model-c", true);

  /* An import with no checkpoint -- repoOf(undefined) is undefined, which is
     the `!repo` branch. Before this was fixed, this branch replaced the whole
     record with `{ at }` and threw all four fields away. */
  const facts = await learnFacts("model-c", undefined);
  assert.equal(facts.shape?.layers, 30, "the GGUF shape must survive");
  assert.equal(facts.shapeFrom, "gguf");
  assert.equal(facts.autoCtxSize, 16384, "MyRA's own ctx_size record must survive");
  assert.equal(facts.ignoreSuggested, true);
  assert.equal(facts.allowOffload, true);
});

test("setAutoCtxSize records and clears, and clearing with nothing set is a no-op", async () => {
  await setAutoCtxSize("model-d", 8192);
  assert.equal((await factsFor("model-d"))?.autoCtxSize, 8192);

  await setAutoCtxSize("model-d", undefined);
  assert.equal((await factsFor("model-d"))?.autoCtxSize, undefined);

  // No record at all for this id -- must not manufacture one.
  await setAutoCtxSize("model-e-never-touched", undefined);
  assert.equal(await factsFor("model-e-never-touched"), undefined);
});
