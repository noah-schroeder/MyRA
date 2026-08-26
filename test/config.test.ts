/**
 * Settings a previous build could write and this one must survive.
 *
 * The timeout clamp is not hypothetical. A real config on this machine held
 * `llm.timeoutMs: 1000`, which the Settings field cannot produce -- it is in
 * seconds and clamps at 5 -- and which gave every request a one-second
 * deadline. It presented as "the LLM endpoint did not answer", so it read as a
 * broken endpoint rather than as a stored number, which is the expensive kind
 * of wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { ConfigStore, DEFAULT_SETTINGS } from "../src/core/config.ts";
import { CONFIG_DIR } from "../src/core/paths.ts";

const SETTINGS = join(CONFIG_DIR, "settings.json");

async function withSettings(body: unknown, fn: (s: ConfigStore) => Promise<void>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(body));
  try {
    const store = new ConfigStore();
    await store.load();
    await fn(store);
  } finally {
    await rm(SETTINGS, { force: true });
  }
}

test("a timeout the UI could not have written is not honoured", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1", timeoutMs: 1000 } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, DEFAULT_SETTINGS.llm.timeoutMs);
    // The rest of the endpoint is kept: only the impossible field is replaced.
    assert.equal(store.current.llm.baseUrl, "http://x/v1");
  });
});

test("a timeout a person deliberately chose is left alone", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1", timeoutMs: 15_000 } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, 15_000);
  });
});

test("a missing or corrupt timeout falls back rather than becoming NaN", async () => {
  await withSettings({ llm: { baseUrl: "http://x/v1" } }, async (store) => {
    assert.equal(store.current.llm.timeoutMs, DEFAULT_SETTINGS.llm.timeoutMs);
  });
  await withSettings({ transcription: { timeoutMs: "soon" } }, async (store) => {
    assert.equal(store.current.transcription.timeoutMs, DEFAULT_SETTINGS.transcription.timeoutMs);
  });
});

test("an endpoint written before it existed keeps its env var", async () => {
  // A file holding only a baseUrl must not drop envVar, or the API key has
  // nowhere to arrive.
  await withSettings({ embeddings: { baseUrl: "http://e/v1" } }, async (store) => {
    assert.equal(store.current.embeddings.envVar, DEFAULT_SETTINGS.embeddings.envVar);
  });
});
