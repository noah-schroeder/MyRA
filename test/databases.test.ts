/**
 * The one table every other piece reads from: which databases exist, by id
 * and by label, and which of them need a key.
 *
 * The property this pins is what the module's own header promises: it has to
 * be the SAME list the search actually uses, or the bar would be naming
 * databases nobody queried.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DATABASES, DEFAULT_DATABASES, SCHOLARLY_DATABASES, databaseById, databaseByLabel, databaseLabel,
} from "../src/core/research/databases.ts";
import { providers } from "../src/core/research/providers.ts";

test("every database id here matches a registered provider, and vice versa", () => {
  const tableIds = DATABASES.map((d) => d.id).sort();
  const providerIds = providers().map((p) => p.id).sort();
  assert.deepEqual(tableIds, providerIds);
});

test("the default databases need no key -- an existing install behaves exactly as before", () => {
  for (const id of DEFAULT_DATABASES) {
    assert.equal(databaseById(id)?.secret, undefined, `${id} should be keyless`);
  }
  assert.deepEqual([...DEFAULT_DATABASES].sort(), ["arxiv", "openalex"]);
});

test("lookup by id and by label agree with each other", () => {
  for (const d of DATABASES) {
    assert.equal(databaseById(d.id), d);
    assert.equal(databaseByLabel(d.label), d);
    // Case-insensitive: a hand-edited plan.md is not guaranteed to match case.
    assert.equal(databaseByLabel(d.label.toUpperCase()), d);
  }
  assert.equal(databaseById("not-a-database"), undefined);
  assert.equal(databaseByLabel("Not A Database"), undefined);
});

test("the label names only what was chosen, in the table's own order", () => {
  assert.equal(databaseLabel(["core", "openalex"]), "OpenAlex · CORE");
  assert.equal(databaseLabel(["arxiv"]), "arXiv");
});

test("nothing chosen, or nothing recognised, names everything this build knows", () => {
  assert.equal(databaseLabel(), SCHOLARLY_DATABASES.join(" · "));
  assert.equal(databaseLabel([]), SCHOLARLY_DATABASES.join(" · "));
  assert.equal(databaseLabel(["not-a-database"]), SCHOLARLY_DATABASES.join(" · "));
});

test("SCHOLARLY_DATABASES is just the labels, in order", () => {
  assert.deepEqual(SCHOLARLY_DATABASES, DATABASES.map((d) => d.label));
});
