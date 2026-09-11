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

import {
  ConfigStore, DEFAULT_SETTINGS, LEGACY_REASONING, type Settings,
} from "../src/core/config.ts";
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
  await withSettings({ embeddings: { timeoutMs: "soon" } }, async (store) => {
    assert.equal(store.current.embeddings.timeoutMs, DEFAULT_SETTINGS.embeddings.timeoutMs);
  });
});

test("an endpoint written before it existed keeps its env var", async () => {
  // A file holding only a baseUrl must not drop envVar, or the API key has
  // nowhere to arrive.
  await withSettings({ embeddings: { baseUrl: "http://e/v1" } }, async (store) => {
    assert.equal(store.current.embeddings.envVar, DEFAULT_SETTINGS.embeddings.envVar);
  });
});

test("an image size the picker could not have written is not honoured", async () => {
  /* Shape, not membership: the three sizes MyRA offers are what it shows, not
     what an engine accepts, so 1152x896 from a hand-edited file is fine and
     "huge" is not -- that string would go straight into a request body. */
  await withSettings({ image: { model: "sd-turbo", size: "huge" } }, async (store) => {
    assert.equal(store.current.image.size, DEFAULT_SETTINGS.image.size);
    assert.equal(store.current.image.model, "sd-turbo");
  });
  await withSettings({ image: { size: "1152x896" } }, async (store) => {
    assert.equal(store.current.image.size, "1152x896");
  });
});

test("an image block that is not one falls back to the defaults", async () => {
  await withSettings({ image: "sd-turbo" }, async (store) => {
    assert.deepEqual(store.current.image, DEFAULT_SETTINGS.image);
  });
});

test("changing the image model does not send the size back with it", async () => {
  /* The reason update() merges this block rather than replacing it: the picker
     in the top bar knows which model was chosen and nothing about the size
     chosen on the page. The cast is what a caller sending half a block looks
     like from here; the type asks for the whole block precisely so that
     spreading is the easy path. */
  await withSettings({ image: { model: "a", size: "1024x1024" } }, async (store) => {
    await store.update({ image: { model: "b" } } as Partial<Settings>);
    assert.equal(store.current.image.model, "b");
    assert.equal(store.current.image.size, "1024x1024");
  });
});

test("a thinking level stored before dialects were plural is kept", async () => {
  // An older build wrote one level per model, because a model was found to
  // read one switch. Dropping those on upgrade would silently un-choose a
  // setting the user made, with nothing on screen saying so.
  await withSettings({ reasoning: { "qwen3:8b": "high", junk: 5 } }, async (store) => {
    assert.deepEqual(store.current.reasoning["qwen3:8b"], { [LEGACY_REASONING]: "high" });
    assert.equal(store.current.reasoning["junk"], undefined);
  });
});

test("two switches on one model are stored apart", async () => {
  // The reason for the nesting: a model reading both `enable_thinking` and
  // `reasoning_effort` has two independent answers, and one value per model
  // could only ever record whichever was touched last.
  const stored = {
    reasoning: {
      "qwen3:8b": { "template:enable_thinking": "true", "template:reasoning_effort": "high" },
    },
  };
  await withSettings(stored, async (store) => {
    assert.deepEqual(store.current.reasoning["qwen3:8b"], {
      "template:enable_thinking": "true",
      "template:reasoning_effort": "high",
    });
    // Un-choosing everything removes the model rather than leaving an empty
    // row a later reader would have to interpret.
    await store.update({ reasoning: { "qwen3:8b": {} } });
    assert.equal(store.current.reasoning["qwen3:8b"], undefined);
  });
});

test("a persona is per model, and clearing one is expressible", async () => {
  await withSettings({ persona: "You are Hilde.", systemPrompts: { "a::b": "Be terse." } }, async (store) => {
    assert.equal(store.current.persona, "You are Hilde.");
    assert.deepEqual(store.current.systemPrompts, { "a::b": "Be terse." });

    /* Replaced wholesale like sampling and reasoning: a merge could not say
       "this model no longer has one". */
    await store.update({ systemPrompts: {} });
    assert.deepEqual(store.current.systemPrompts, {});
  });
});

test("a blank persona for a model is not an entry", async () => {
  await withSettings({ systemPrompts: { "a::b": "   ", "c::d": "Real." } }, async (store) => {
    assert.deepEqual(store.current.systemPrompts, { "c::d": "Real." });
  });
});

test("the persona falls back to MyRA's own rather than to nothing", async () => {
  await withSettings({ persona: 42 }, async (store) => {
    assert.equal(store.current.persona, DEFAULT_SETTINGS.persona);
    assert.match(store.current.persona, /You are Myra/);
  });
});

test("reviews have a root of their own, beside papers", async () => {
  await withSettings({}, async (store) => {
    assert.ok(store.current.reviewsRoot.endsWith("reviews"));
    assert.notEqual(store.current.reviewsRoot, store.current.papersRoot);
  });
});
