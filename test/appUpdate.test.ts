/**
 * The check itself, with GitHub stubbed: what it reports for a newer release,
 * an up-to-date one, and a request that fails outright.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkForUpdate } from "../src/main/appUpdate.ts";

test("reports a newer release", async () => {
  const result = await checkForUpdate("0.1.2", async () => ({
    tag_name: "v0.1.3",
    html_url: "https://github.com/noah-schroeder/MyRA/releases/tag/v0.1.3",
  }));
  assert.deepEqual(result, {
    ok: true,
    current: "0.1.2",
    latest: "v0.1.3",
    newer: true,
    url: "https://github.com/noah-schroeder/MyRA/releases/tag/v0.1.3",
  });
});

test("reports no update when already on the latest tag", async () => {
  const result = await checkForUpdate("0.1.2", async () => ({ tag_name: "v0.1.2" }));
  assert.equal(result.ok, true);
  assert.equal(result.newer, false);
});

test("a failed request is reported rather than thrown", async () => {
  const result = await checkForUpdate("0.1.2", async () => {
    throw new Error("GitHub answered 403");
  });
  assert.deepEqual(result, {
    ok: false,
    current: "0.1.2",
    newer: false,
    error: "GitHub answered 403",
  });
});

test("a response with no tag is a failure, not a false negative", async () => {
  const result = await checkForUpdate("0.1.2", async () => ({}));
  assert.equal(result.ok, false);
  assert.equal(result.newer, false);
});
