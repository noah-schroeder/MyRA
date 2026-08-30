/**
 * Shelves: finding a model without knowing what to type.
 *
 * The cases that matter are the editorial ones. A shelf is Karen speaking in
 * its own voice, so what it refuses to show, and whether it admits to
 * refusing, are the behaviours worth pinning down.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildShelf,
  compact,
  countFiltered,
  describeDownloads,
  isLowQuality,
  PUBLISHERS,
  SHELVES,
  taskFits,
} from "../src/core/runtime/discover.ts";
import type { RegistryHit } from "../src/core/runtime/registry.ts";

function hit(id: string, patch: Partial<RegistryHit> = {}): RegistryHit {
  return {
    id,
    name: id,
    source: "huggingface",
    hasGguf: true,
    tags: [],
    downloads: 1000,
    ...patch,
  };
}

/* --------------------------------------------------------- the filter -- */

test("the safety-stripped merges that dominate the popular list are refused", () => {
  // Every one of these was in the top eighteen of a real merged popular
  // search, which is what this filter exists for.
  for (const id of [
    "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
    "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
    "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
    "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF",
  ]) {
    assert.equal(isLowQuality(hit(id)), true, id);
  }
});

test("ordinary repositories are not caught by it", () => {
  for (const id of [
    "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    "ggml-org/embeddinggemma-300M-GGUF",
    "ibm-granite/granite-4.2-8b-GGUF",
    "handy-computer/whisper-large-v3-gguf",
  ]) {
    assert.equal(isLowQuality(hit(id)), false, id);
  }
});

/* ---------------------------------------------------------- the tasks -- */

test("a stated task that does not suit the shelf is dropped", () => {
  assert.equal(taskFits(hit("a", { task: "feature-extraction" }), ["text-generation"]), false);
});

test("an absent task is kept, because it is missing metadata and not a mismatch", () => {
  // Roughly a third of GGUF repositories set no pipeline tag. Treating that as
  // a mismatch empties the shelves.
  assert.equal(taskFits(hit("a"), ["text-generation"]), true);
});

test("a shelf with no task preference keeps everything", () => {
  assert.equal(taskFits(hit("a", { task: "anything" }), undefined), true);
});

/* ---------------------------------------------------------- the shelf -- */

test("a repository returned by two queries appears once", () => {
  // The family queries overlap heavily -- "qwen3" and "llama" both return the
  // same huge unsloth repositories.
  const shelf = buildShelf(
    [
      [hit("a/one"), hit("b/two")],
      [hit("a/one"), hit("c/three")],
    ],
    {},
  );
  assert.deepEqual(shelf.map((h) => h.id).sort(), ["a/one", "b/two", "c/three"]);
});

test("the queries are interleaved, so one family cannot take the whole shelf", () => {
  /* The failure this prevents, measured on a real shelf: sorting the merged
     set by downloads put ten consecutive Gemma variants in positions three to
     twelve, because same-family variants have near-identical counts. */
  const gemma = Array.from({ length: 8 }, (_, i) => hit(`g/gemma-${i}`, { downloads: 900 - i }));
  const qwen = Array.from({ length: 8 }, (_, i) => hit(`q/qwen-${i}`, { downloads: 100 - i }));

  const shelf = buildShelf([gemma, qwen], {}, 6);

  // Alternating, even though every Gemma outranks every Qwen on downloads.
  assert.deepEqual(
    shelf.map((h) => h.id),
    ["g/gemma-0", "q/qwen-0", "g/gemma-1", "q/qwen-1", "g/gemma-2", "q/qwen-2"],
  );
});

test("each query still contributes its most-downloaded rows first", () => {
  // Interleaving spreads the families; within one it must stay a ranking.
  const one = [hit("o/big", { downloads: 900 }), hit("o/small", { downloads: 3 })];
  const shelf = buildShelf([one], {}, 2);
  assert.deepEqual(shelf.map((h) => h.id), ["o/big", "o/small"]);
});

test("no single owner may fill the shelf", () => {
  /* unsloth, bartowski and MaziyarPanahi quantise nearly everything. Nine
     consecutive rows from one of them is what this cap exists to stop. */
  const many = Array.from({ length: 12 }, (_, i) => hit(`maziyarpanahi/m${i}`, { downloads: 100 - i }));
  const other = [hit("someone/else")];

  const shelf = buildShelf([many, other], {}, 12);

  const owners = shelf.map((h) => h.id.split("/")[0]);
  assert.equal(owners.filter((o) => o === "maziyarpanahi").length, 4);
  assert.ok(shelf.some((h) => h.id === "someone/else"));
});

test("a repository with no GGUF files never reaches a shelf", () => {
  // Karen runs GGUF; a repository without any is a row that cannot be acted on.
  const shelf = buildShelf([[hit("org/safetensors-only", { hasGguf: false })]], {});
  assert.deepEqual(shelf, []);
});

test("the shelf refuses what the filter caught", () => {
  const shelf = buildShelf(
    [[hit("good/Model-GGUF"), hit("bad/Model-Uncensored-GGUF")]],
    {},
  );
  assert.deepEqual(shelf.map((h) => h.id), ["good/Model-GGUF"]);
});

test("how many were set aside is countable, so the filtering can be admitted", () => {
  const results = [
    [hit("a/x"), hit("b/y-abliterated")],
    [hit("b/y-abliterated"), hit("c/z-OBLITERATED")],
  ];
  // Counted once each, not once per query they appeared in.
  assert.equal(countFiltered(results), 2);
});

test("a shelf is capped, so one press cannot return five hundred rows", () => {
  // Distinct owners, or the per-owner cap would be what limited this and the
  // length cap would go untested.
  const many = Array.from({ length: 60 }, (_, i) => hit(`org${i}/m`, { downloads: 60 - i }));
  assert.equal(buildShelf([many], {}, 24).length, 24);
});

/* ----------------------------------------------------------- wording -- */

test("the download figure carries the window it was measured over", () => {
  // "13M" reads as "thirteen million people use this". It is thirty days of
  // traffic, and saying so is the difference between a number and a fact.
  assert.equal(describeDownloads(12_760_676), "12.8M in the last 30 days");
  assert.equal(describeDownloads(undefined), "—");
});

test("counts are compact without being wrong", () => {
  assert.equal(compact(12_760_676), "12.8M");
  assert.equal(compact(92_613_063), "92.6M");
  assert.equal(compact(1_000_000), "1M");
  assert.equal(compact(334_000), "334k");
  assert.equal(compact(47), "47");
});

/* -------------------------------------------------------- the shelves -- */

test("every shelf ships at least one query, or its button does nothing", () => {
  for (const shelf of SHELVES) {
    assert.ok(shelf.queries.length > 0, shelf.id);
    assert.ok(shelf.title && shelf.hint, shelf.id);
  }
});

test("no shelf sends more queries than it needs to", () => {
  // One press should not become eight round trips to somebody's registry.
  for (const shelf of SHELVES) assert.ok(shelf.queries.length <= 5, shelf.id);
});

test("every publisher shortcut was checked against the live registry", () => {
  /* Each of these returned GGUF repositories when run for real. The label is
     the company a person recognises; the query is what actually finds their
     models. */
  const byLabel = new Map(PUBLISHERS.map((p) => [p.label, p.query]));
  assert.equal(byLabel.get("Z.ai (GLM)"), "glm");
  assert.equal(byLabel.get("Arcee"), "arcee");
  assert.equal(byLabel.get("Poolside (Laguna)"), "poolside");
});

test("the publisher shortcuts search families rather than company handles", () => {
  // Most Llama GGUF files are published by `unsloth` and `bartowski`, not by
  // `meta-llama`; searching the company handle would miss nearly all of them.
  for (const p of PUBLISHERS) assert.ok(!p.query.includes("/"), p.query);
});
