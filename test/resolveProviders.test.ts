/**
 * Turning "these databases are chosen" into "these of them are usable right
 * now" -- the one place a missing key becomes a dropped database rather than
 * a silent gap in the results.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { resetDatabaseKeys, setDatabaseKeys } from "../src/core/research/keys.ts";
import { resolveProviders } from "../src/core/research/providers.ts";

afterEach(() => resetDatabaseKeys());

test("with no reader installed, a keyed database is unavailable rather than sent with no key", async () => {
  const { providers, unavailable } = await resolveProviders(["openalex", "core"]);
  assert.deepEqual(providers.map((p) => p.id), ["openalex"]);
  assert.deepEqual(unavailable, ["CORE"]);
});

test("a keyed database resolves once its key is present", async () => {
  setDatabaseKeys(async (secret) => (secret === "coreKey" ? "the-key" : undefined));
  const { providers, unavailable } = await resolveProviders(["openalex", "core"]);
  assert.deepEqual(providers.map((p) => p.id).sort(), ["core", "openalex"]);
  assert.deepEqual(unavailable, []);
});

test("an empty selection resolves to the keyless defaults", async () => {
  const { providers, unavailable } = await resolveProviders([]);
  assert.deepEqual(providers.map((p) => p.id).sort(), ["arxiv", "openalex"]);
  assert.deepEqual(unavailable, []);
});

test("an unknown id is ignored, not thrown on", async () => {
  const { providers, unavailable } = await resolveProviders(["openalex", "not-a-database"]);
  assert.deepEqual(providers.map((p) => p.id), ["openalex"]);
  assert.deepEqual(unavailable, []);
});

test("losing a key between choosing it and searching is named, not silent", async () => {
  setDatabaseKeys(async () => "present");
  const first = await resolveProviders(["pubmed"]);
  assert.deepEqual(first.providers.map((p) => p.id), ["pubmed"]);

  setDatabaseKeys(async () => undefined);
  const second = await resolveProviders(["pubmed"]);
  assert.deepEqual(second.providers, []);
  assert.deepEqual(second.unavailable, ["PubMed"]);
});
