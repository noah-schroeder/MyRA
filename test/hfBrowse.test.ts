/**
 * Browsing the registry directly.
 *
 * The tests that matter are about the query string, because the difference
 * between `author=` and `search=` is the difference between a publisher's
 * page and a guess -- and that difference is what this whole module exists
 * for. "granite" through the old path returned 42 rows of which 5 were
 * usable; `author=ibm-granite` returns the publisher's actual catalogue.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  age,
  browseParams,
  compact,
  describeDownloads,
  KINDS,
  kindById,
  loadable,
  parseModels,
  SORTS,
  type HfModel,
} from "../src/core/runtime/hfBrowse.ts";

const get = (q: Parameters<typeof browseParams>[0]) => browseParams(q);

/* ------------------------------------------------------------- params -- */

test("a publisher is asked for exactly, not matched by name", () => {
  const p = get({ author: "ibm-granite" });
  assert.equal(p.get("author"), "ibm-granite");
  assert.equal(p.get("search"), null);
});

test("free text and a publisher can be combined", () => {
  const p = get({ author: "unsloth", query: "qwen" });
  assert.equal(p.get("author"), "unsloth");
  assert.equal(p.get("search"), "qwen");
});

test("a model kind becomes a pipeline tag the API understands", () => {
  assert.equal(get({ kind: "image" }).get("pipeline_tag"), "text-to-image");
  assert.equal(get({ kind: "chat" }).get("pipeline_tag"), "text-generation");
});

test("the everything tab sets no tag at all", () => {
  // A tab that filtered client-side would report counts over a page it had
  // already truncated, so "everything" has to mean "no filter sent".
  assert.equal(get({ kind: "all" }).get("pipeline_tag"), null);
});

test("nothing is filtered to GGUF unless it was asked for", () => {
  // The complaint that started this: a publisher's 42 repositories showing as
  // 5, because only 5 held GGUF. Showing everything is now the default.
  assert.equal(get({ author: "ibm-granite" }).get("filter"), null);
  assert.equal(get({ author: "ibm-granite", ggufOnly: true }).get("filter"), "gguf");
});

test("a full page is asked for, not a handful", () => {
  assert.equal(get({}).get("limit"), "100");
});

test("the fields the rows display are requested explicitly", () => {
  // The default response omits downloads, which is the one number on a row a
  // person can act on.
  const expanded = get({}).getAll("expand[]");
  for (const field of ["downloads", "likes", "createdAt", "pipeline_tag"]) {
    assert.ok(expanded.includes(field), field);
  }
});

test("every offered sort is a real one, and downloads is the default", () => {
  assert.equal(get({}).get("sort"), "downloads");
  for (const s of SORTS) assert.equal(get({ sort: s.id }).get("sort"), s.id);
});

test("an unknown kind falls back to everything rather than throwing", () => {
  assert.equal(kindById("nonsense").id, "all");
});

/* -------------------------------------------------------------- parse -- */

test("the API's rows become models, and malformed ones are skipped", () => {
  const models = parseModels([
    {
      id: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
      downloads: 12_760_676,
      likes: 933,
      pipeline_tag: "text-generation",
      tags: ["gguf", "qwen3"],
      createdAt: "2025-07-31T10:27:38.000Z",
    },
    { nonsense: true },
    null,
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.owner, "unsloth");
  assert.equal(models[0]!.hasGguf, true);
  assert.equal(models[0]!.downloads, 12_760_676);
});

test("a repository without the gguf tag is not claimed to have one", () => {
  const [model] = parseModels([{ id: "ibm-granite/granite-4.1-8b", tags: ["transformers"] }]);
  assert.equal(model!.hasGguf, false);
});

test("a gated repository is marked, because it will not download unprompted", () => {
  const [a] = parseModels([{ id: "meta-llama/x", gated: "auto", tags: [] }]);
  const [b] = parseModels([{ id: "open/y", tags: [] }]);
  assert.equal(a!.gated, true);
  assert.equal(b!.gated, false);
});

/* ----------------------------------------------------------- loadable -- */

const model = (patch: Partial<HfModel> = {}): HfModel => ({
  id: "a/b", owner: "a", tags: [], hasGguf: true, gated: false, ...patch,
});

test("a GGUF chat model is ready", () => {
  assert.equal(loadable(model(), kindById("chat")), "ready");
});

test("original weights are named as the wrong format rather than as a failure", () => {
  // 37 of the 42 granite results were this. It is not an error, it is a
  // repository holding the unquantised model.
  assert.equal(loadable(model({ hasGguf: false }), kindById("chat")), "wrong-format");
});

test("a GGUF diffusion model is flagged, because Lemonade would call it llama.cpp", () => {
  /* Measured: `/pull/variants` reports `recipe: llamacpp` for
     Kijai/WanVideo_comfy_GGUF and SporkySporkness/FLUX.1-Canny-dev-GGUF,
     neither of which llama.cpp can execute. */
  assert.equal(loadable(model(), kindById("image")), "other-runtime");
  assert.equal(loadable(model(), kindById("voice")), "other-runtime");
});

/* ------------------------------------------------------------ wording -- */

test("the download figure carries the window it was measured over", () => {
  assert.equal(describeDownloads(12_760_676), "12.8M in the last 30 days");
  assert.equal(describeDownloads(undefined), "Not reported");
});

test("counts are compact without being wrong", () => {
  assert.equal(compact(12_760_676), "12.8M");
  assert.equal(compact(92_613_063), "92.6M");
  assert.equal(compact(1_000_000), "1M");
  assert.equal(compact(334_000), "334k");
  assert.equal(compact(undefined), "—");
});

test("age reads as a person would say it", () => {
  const now = Date.parse("2026-08-30T12:00:00Z");
  assert.equal(age("2026-08-30T06:00:00Z", now), "today");
  assert.equal(age("2026-08-26T12:00:00Z", now), "4 days ago");
  assert.equal(age("2026-06-25T12:00:00Z", now), "2 months ago");
  assert.equal(age(undefined, now), undefined);
  assert.equal(age("not a date", now), undefined);
});

test("every kind says whether Karen can load it, and the honest ones say no", () => {
  const byId = new Map(KINDS.map((k) => [k.id, k]));
  assert.equal(byId.get("chat")!.runnable, true);
  // Diffusion, speech synthesis and Whisper do not run on llama.cpp.
  assert.equal(byId.get("image")!.runnable, false);
  assert.equal(byId.get("voice")!.runnable, false);
  assert.equal(byId.get("speech")!.runnable, false);
});
