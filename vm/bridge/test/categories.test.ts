import { test } from "node:test";
import assert from "node:assert/strict";
import { categoriesFromConfig } from "../src/categories.ts";

/*
 * Shaped exactly like the live instance's /config, including the trap: openalex
 * and crossref really do report enabled:false there while still answering
 * searches, and `books` really does have no enabled engine at all.
 */
const LIVE = {
  categories: ["general", "science", "scientific publications", "books"],
  engines: [
    { name: "duckduckgo", enabled: true, categories: ["general"], time_range_support: true },
    { name: "arxiv", enabled: true, categories: ["science", "scientific publications"] },
    { name: "pubmed", enabled: true, categories: ["science", "scientific publications"] },
    { name: "google scholar", enabled: true, categories: ["science", "scientific publications"] },
    { name: "semantic scholar", enabled: true, categories: ["science", "scientific publications"] },
    { name: "crossref", enabled: false, categories: ["science", "scientific publications"] },
    { name: "openalex", enabled: false, categories: ["science", "scientific publications"] },
    { name: "openlibrary", enabled: false, categories: ["books"] },
  ],
};

test("the count is every engine behind the category, not just the enabled ones", () => {
  const cats = categoriesFromConfig(LIVE);
  const byName = new Map(cats.map((c) => [c.name, c.engines]));
  // SearXNG's preferences page reports 4 here; a search of it answers from 6.
  assert.equal(byName.get("scientific publications"), 6);
  assert.equal(byName.get("science"), 6);
  assert.equal(byName.get("general"), 1);
});

test("a category whose engines are all reported disabled is still offered", () => {
  // `books` would have vanished from the dropdown under the old filter, even
  // though ?categories=books returns results.
  assert.ok(categoriesFromConfig(LIVE).some((c) => c.name === "books" && c.engines === 1));
});

test("time-range support is reported per category so the GUI can hide a dead control", () => {
  const byName = new Map(categoriesFromConfig(LIVE).map((c) => [c.name, c.timeRange]));
  assert.equal(byName.get("general"), true);
  // No scholarly engine supports a time filter; offering one returns nothing.
  assert.equal(byName.get("science"), false);
  assert.equal(byName.get("scientific publications"), false);
  assert.equal(byName.get("books"), false);
});

test("a category with no engine at all is dropped", () => {
  const cats = categoriesFromConfig({ categories: ["general", "ghost"], engines: LIVE.engines });
  assert.deepEqual(cats.map((c) => c.name), ["general"]);
});

test("categories are sorted, so the list does not reshuffle between reloads", () => {
  const names = categoriesFromConfig(LIVE).map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("an empty or malformed config yields no categories rather than throwing", () => {
  assert.deepEqual(categoriesFromConfig({}), []);
  assert.deepEqual(categoriesFromConfig({ categories: ["general"] }), []);
  assert.deepEqual(categoriesFromConfig({ engines: [{ name: "x" }] }), []);
});
