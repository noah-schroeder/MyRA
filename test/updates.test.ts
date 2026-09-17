/**
 * The pure half of the app-update check: parsing GitHub's response and
 * deciding whether it names something newer than the version running.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isNewer, latestReleaseUrl, parseLatestRelease } from "../src/core/updates.ts";

test("latestReleaseUrl names this repository's latest release", () => {
  assert.equal(
    latestReleaseUrl(),
    "https://api.github.com/repos/noah-schroeder/MyRA/releases/latest",
  );
});

test("parseLatestRelease reads the tag and the page it links to", () => {
  const release = parseLatestRelease({ tag_name: "v0.1.3", html_url: "https://github.com/x/y" });
  assert.deepEqual(release, { tag: "v0.1.3", url: "https://github.com/x/y" });
});

test("parseLatestRelease drops a missing url rather than inventing one", () => {
  assert.deepEqual(parseLatestRelease({ tag_name: "v0.1.3" }), { tag: "v0.1.3" });
});

test("parseLatestRelease refuses a response with no tag", () => {
  assert.equal(parseLatestRelease({}), undefined);
  assert.equal(parseLatestRelease(undefined), undefined);
  assert.equal(parseLatestRelease("not an object"), undefined);
});

test("isNewer compares numerically, not lexically", () => {
  assert.equal(isNewer("v0.1.10", "0.1.9"), true);
  assert.equal(isNewer("v0.2.0", "0.1.9"), true);
  assert.equal(isNewer("v0.1.2", "0.1.2"), false);
  assert.equal(isNewer("v0.1.1", "0.1.2"), false);
});

test("isNewer treats a missing patch segment as zero", () => {
  assert.equal(isNewer("v0.2", "0.1.9"), true);
  assert.equal(isNewer("v0.1", "0.1.0"), false);
});
